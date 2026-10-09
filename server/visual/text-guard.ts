import { createCanvas, loadImage } from '@napi-rs/canvas';
import { Resvg } from '@resvg/resvg-js';
import type { FigureScene, Primitive } from '../../shared/types';
import { allPrimitives, patchPrimitive, sceneSvg } from '../../shared/svg';
import { textBoxes } from '../typography';

/** A visual tool for the critic: do not accept a text-position edit that reduces
 * local blueprint ink agreement. It never changes wording or creates outlined text. */
export async function guardTextEdits(before:FigureScene,candidate:FigureScene,reference:string,edits:any[]) {
  const changed=new Set(edits.filter(e=>Object.keys(e.patch??{}).some(k=>['x','y','width','fontSize','fontFamily','fontWeight','align'].includes(k))).map(e=>e.id));
  if(!changed.size)return {scene:candidate,report:[]};
  const original=allPrimitives([...before.annotations,...before.modules.flatMap(m=>m.elements)]).filter(e=>e.type==='text'&&changed.has(e.id));
  if(!original.length)return {scene:candidate,report:[]};
  const pixels=async(data:Buffer|string)=>{const picture=await loadImage(typeof data==='string'?Buffer.from(data.split(',')[1],'base64'):data),canvas=createCanvas(picture.width,picture.height),c=canvas.getContext('2d');c.drawImage(picture,0,0);return c.getImageData(0,0,picture.width,picture.height).data;};
  const render=(s:FigureScene)=>new Resvg(sceneSvg(s,false),{font:{loadSystemFonts:true,defaultFontFamily:s.style.font}}).render().asPng();
  const [target,oldImage,newImage]=await Promise.all([pixels(reference),pixels(render(before)),pixels(render(candidate))]);
  const boxes=(s:FigureScene,id:string)=>{
    const groups:Primitive[]=s.modules.map(m=>({id:m.id+'-glyphs',type:'group',x:m.x,y:m.y,scaleX:m.width/(m.contentWidth??m.width),scaleY:m.height/(m.contentHeight??m.height),children:m.elements}));
    return textBoxes([...groups,...s.annotations.filter(e=>e.layer!=='background')],s.style).filter(b=>b.id===id);
  };
  let scene=structuredClone(candidate);const report:any[]=[];
  for(const object of original) {
    const b=[...boxes(before,object.id),...boxes(candidate,object.id)];if(!b.length)continue;
    const x=Math.max(0,Math.floor(Math.min(...b.map(p=>p.x))-10)),y=Math.max(0,Math.floor(Math.min(...b.map(p=>p.y))-10));
    const right=Math.min(before.width,Math.ceil(Math.max(...b.map(p=>p.x+p.width))+10)),bottom=Math.min(before.height,Math.ceil(Math.max(...b.map(p=>p.y+p.height))+10));
    const fill=/^#[\da-f]{6}$/i.test(object.fill??'')?object.fill!:before.style.ink;
    if(!/^#[\da-f]{6}$/i.test(fill))continue;
    const ink=[1,3,5].map(i=>parseInt(fill.slice(i,i+2),16)),w=right-x,h=bottom-y;if(w<=0||h<=0)continue;
    const mask=(image:Uint8ClampedArray)=>{
      const result=new Uint8Array(w*h);let count=0;
      for(let row=0;row<h;row++)for(let col=0;col<w;col++) {const offset=((y+row)*before.width+x+col)*4;
        if(Math.hypot(image[offset]-ink[0],image[offset+1]-ink[1],image[offset+2]-ink[2])<110){result[row*w+col]=1;count++;}}
      return {result,count};
    };
    const t=mask(target),a=mask(oldImage),c=mask(newImage);if(t.count<12)continue;
    const matched=(left:Uint8Array,right:Uint8Array)=>{let count=0;for(let row=0;row<h;row++)for(let col=0;col<w;col++)if(left[row*w+col]) {
      let found=false;for(let dy=-1;dy<=1&&!found;dy++)for(let dx=-1;dx<=1;dx++)if(row+dy>=0&&row+dy<h&&col+dx>=0&&col+dx<w&&right[(row+dy)*w+col+dx]){found=true;break;}if(found)count++;
    }return count;};
    const score=(m:ReturnType<typeof mask>)=>m.count ? .5*(matched(m.result,t.result)/m.count+matched(t.result,m.result)/t.count) : 0;
    const previous=score(a),proposed=score(c),accepted=proposed>=previous-.015;
    if(!accepted){scene.annotations=patchPrimitive(scene.annotations,object.id,object);scene.modules=scene.modules.map(m=>({...m,elements:patchPrimitive(m.elements,object.id,object)}));}
    report.push({id:object.id,accepted,previousAgreement:previous,proposedAgreement:proposed});
  }
  return {scene,report};
}
