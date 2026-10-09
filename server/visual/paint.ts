import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { FigureScene, Primitive } from '../../shared/types';

/** Recover low-frequency surface color from the blueprint, not contours or raster content.
 * The output is native fill/three-stop gradient paint, never sampled image pixels. */
export async function restoreBlueprintPaint(original:FigureScene,dataUrl:string) {
  const image=await loadImage(Buffer.from(dataUrl.split(',')[1],'base64'));
  const canvas=createCanvas(image.width,image.height),ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
  const pixels=ctx.getImageData(0,0,image.width,image.height).data,scene=structuredClone(original),report:any[]=[];
  const median=(values:number[])=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)];
  const hex=(rgb:number[])=>'#'+rgb.map(c=>Math.max(0,Math.min(255,Math.round(c))).toString(16).padStart(2,'0')).join('');
  const delta=(a:number[],b:number[])=>Math.hypot(...a.map((v,i)=>v-b[i]));
  const recoverDash=(e:Primitive,tx:number,ty:number,sx:number,sy:number)=>{
    if(!['rect','line','path'].includes(e.type)||e.rotation||!e.stroke||e.stroke==='none')return;
    let px=tx,py=ty,pw=e.width??0,ph=e.height??0;
    if(e.type==='path') {
      const straight=/^M\s*([\d.-]+)[ ,]+([\d.-]+)\s*L\s*([\d.-]+)[ ,]+([\d.-]+)\s*$/i.exec(e.path??'');
      if(!straight)return;const [ax,ay,bx,by]=straight.slice(1).map(Number);px+=Math.min(ax,bx)*sx;py+=Math.min(ay,by)*sy;pw=Math.abs(bx-ax);ph=Math.abs(by-ay);
    }
    const horizontal=pw*sx>=ph*sy;
    const length=Math.floor(horizontal?pw*sx:ph*sy);
    if(length<160)return;
    const margin=e.type==='rect'?Math.max(20,(e.radius??0)*2):12,bits:boolean[]=[];
    for(let n=margin;n<length-margin;n++) {
      let ink=false;
      for(let offset=-4;offset<=4;offset++) {
        const x=Math.round(px+(horizontal?n:offset)),y=Math.round(py+(horizontal?offset:n));
        if(x<0||y<0||x>=image.width||y>=image.height)continue;
        const index=(y*image.width+x)*4;
        if((pixels[index]+pixels[index+1]+pixels[index+2])/3<185){ink=true;break;}
      }
      bits.push(ink);
    }
    const runs:{ink:boolean;length:number}[]=[];
    for(const ink of bits){if(runs.at(-1)?.ink===ink)runs.at(-1)!.length++;else runs.push({ink,length:1});}
    const dark=runs.slice(1,-1).filter(r=>r.ink).map(r=>r.length),gaps=runs.slice(1,-1).filter(r=>!r.ink).map(r=>r.length);
    const coverage=bits.filter(Boolean).length/bits.length;
    if(dark.length<6||gaps.length<6||coverage<.2||coverage>.85)return;
    const dash=median(dark),gap=median(gaps);if(dash<2||dash>20||gap<2||gap>20)return;
    e.dash=[dash/(horizontal?sx:sy),gap/(horizontal?sx:sy)];report.push({id:e.id,strokeDash:e.dash,matchedSegments:dark.length});
  };
  const sample=(e:Primitive,x:number,y:number,sx:number,sy:number,background:boolean)=>{
    if(e.type!=='rect'||e.locked||e.rotation||!/^#[\da-f]{6}$/i.test(e.fill??'')||(e.width??0)<80||(e.height??0)<30)return;
    const base=[1,3,5].map(i=>parseInt(e.fill!.slice(i,i+2),16));
    const samples:{u:number;v:number;rgb:number[]}[]=[];
    for(let i=0;i<36;i++)for(let j=0;j<18;j++) {
      const u=(i+.5)/36,v=(j+.5)/18,px=Math.round(x+(e.width??0)*sx*u),py=Math.round(y+(e.height??0)*sy*v);
      if(px<0||py<0||px>=image.width||py>=image.height)continue;
      if(background&&scene.modules.some(m=>px>=m.x-3&&px<=m.x+m.width+3&&py>=m.y-3&&py<=m.y+m.height+3))continue;
      const offset=(py*image.width+px)*4,rgb=Array.from(pixels.slice(offset,offset+3));
      if(delta(rgb,base)>55)continue;samples.push({u,v,rgb});
    }
    if(samples.length<48)return;
    const bands=(axis:'u'|'v')=>[samples.filter(p=>p[axis]<.25),samples.filter(p=>p[axis]>.4&&p[axis]<.6),samples.filter(p=>p[axis]>.75)];
    const colors=(bands:typeof samples[])=>bands.every(b=>b.length>=6)?bands.map(b=>[0,1,2].map(i=>median(b.map(p=>p.rgb[i])))):undefined;
    const horizontal=colors(bands('u')),vertical=colors(bands('v'));
    const variation=(c:number[][]|undefined)=>c?Math.max(delta(c[0],c[1]),delta(c[1],c[2]),delta(c[0],c[2])):0;
    const across=variation(horizontal)>variation(vertical),stops=across?horizontal:vertical;
    if(!stops)return;
    const surface=[0,1,2].map(i=>median(samples.map(p=>p.rgb[i])));
    if(delta(base,surface)>3)e.fill=hex(surface);
    if(variation(stops)>=2.5)e.gradient={type:'linear',x1:0,y1:0,x2:across?1:0,y2:across?0:1,stops:stops.map((rgb,i)=>({offset:i/2,color:hex(rgb)}))};
    else if(e.gradient){e.fill=hex(surface);delete e.gradient;}
    report.push({id:e.id,matchedSamples:samples.length,fill:e.fill,direction:e.gradient?(across?'horizontal':'vertical'):undefined,stops:e.gradient?.stops});
  };
  const walk=(items:Primitive[],tx:number,ty:number,sx:number,sy:number,background:boolean)=>{
    for(const e of items){if(e.rotation||e.locked)continue;const x=tx+e.x*sx,y=ty+e.y*sy;
      if(e.type==='group')walk(e.children??[],x,y,sx*(e.scaleX??1),sy*(e.scaleY??1),background);
      else {recoverDash(e,x,y,sx*(e.scaleX??1),sy*(e.scaleY??1));sample(e,x,y,sx*(e.scaleX??1),sy*(e.scaleY??1),background);}
    }
  };
  walk(scene.annotations.filter(e=>e.layer==='background'),0,0,1,1,true);
  for(const e of scene.annotations.filter(e=>e.layer!=='background'&&!e.locked))recoverDash(e,e.x,e.y,1,1);
  for(const module of scene.modules)if(!module.locked)walk(module.elements,module.x,module.y,module.width/(module.contentWidth??module.width),module.height/(module.contentHeight??module.height),false);
  return {scene,report};
}
