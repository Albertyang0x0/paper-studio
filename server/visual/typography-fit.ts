import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { FigureScene, Primitive } from '../../shared/types';
import { displayMath } from '../../shared/math-text';
import { canvasFont } from '../font-metrics';
import { textBoxes } from '../typography';
import { iconOverlapPenalty, typographyObstacles } from './type-obstacles';

/** Fit editable type to actual blueprint ink. Search positions/font size only:
 * no OCR substitutions, text tracing, outlined glyphs, or font distortion. */
export async function proposeTypographyFit(scene:FigureScene,dataUrl:string) {
  const picture=await loadImage(Buffer.from(dataUrl.split(',')[1],'base64'));
  const context=createCanvas(scene.width,scene.height).getContext('2d');context.drawImage(picture,0,0,scene.width,scene.height);
  const target=context.getImageData(0,0,scene.width,scene.height).data,edits:any[]=[],audit:any[]=[];
  const tasks:{e:Primitive;tx:number;ty:number;sx:number;sy:number;obstacles?:ReturnType<typeof typographyObstacles>}[]=[];
  for(const e of scene.annotations)if(e.type==='text')tasks.push({e,tx:0,ty:0,sx:1,sy:1});
  for(const m of scene.modules) {
    if(!m.elements.some(e=>e.type==='text'))continue;
    const obstacles=typographyObstacles(m,scene.style);
    for(const e of m.elements)if(e.type==='text')tasks.push({e,tx:m.x,ty:m.y,sx:m.width/(m.contentWidth??m.width),sy:m.height/(m.contentHeight??m.height),obstacles});
  }
  for(const {e,tx,ty,sx,sy,obstacles=[]} of tasks) {
    if(e.rotation||e.scaleX||e.scaleY||!e.text||e.opacity===0)continue;
    const fill=e.fill??scene.style.ink;if(!/^#[\da-f]{6}$/i.test(fill))continue;
    const boxes=textBoxes([{...e,x:tx+e.x*sx,y:ty+e.y*sy,scaleX:sx,scaleY:sy}],scene.style);if(!boxes.length)continue;
    const x=Math.max(0,Math.floor(Math.min(...boxes.map(b=>b.x))-24)),y=Math.max(0,Math.floor(Math.min(...boxes.map(b=>b.y))-20));
    const right=Math.min(scene.width,Math.ceil(Math.max(...boxes.map(b=>b.x+b.width))+24)),bottom=Math.min(scene.height,Math.ceil(Math.max(...boxes.map(b=>b.y+b.height))+20));
    const w=right-x,h=bottom-y;if(w<=0||h<=0)continue;
    const ink=[1,3,5].map(i=>parseInt(fill.slice(i,i+2),16)),mask=new Uint8Array(w*h);let targetCount=0;
    for(let row=0;row<h;row++)for(let col=0;col<w;col++) {const offset=((y+row)*scene.width+x+col)*4;
      const localX=(x+col-tx)/sx,localY=(y+row-ty)/sy;
      if(obstacles.some(o=>localX>=o.x-2&&localX<=o.x+o.width+2&&localY>=o.y-2&&localY<=o.y+o.height+2))continue;
      if(Math.hypot(target[offset]-ink[0],target[offset+1]-ink[1],target[offset+2]-ink[2])<90){mask[row*w+col]=1;targetCount++;}}
    if(targetCount<16)continue;
    // A one-pixel tolerant target accepts antialiasing and minor glyph-family differences.
    const tolerant=new Uint8Array(mask);
    for(let row=0;row<h;row++)for(let col=0;col<w;col++)if(mask[row*w+col])for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)
      if(row+dy>=0&&row+dy<h&&col+dx>=0&&col+dx<w)tolerant[(row+dy)*w+col+dx]=1;
    const size=e.fontSize??scene.style.bodySize;
    const glyphs=(fontSize:number,fontFamily=e.fontFamily??scene.style.font)=>{
      const c=createCanvas(w,h).getContext('2d');c.scale(sx,sy);c.font=canvasFont(fontFamily,fontSize,e.fontWeight??400,!!e.italic);
      c.fillStyle='#000000';c.textAlign=e.align??'left';
      const anchor=e.align==='center'?(e.width??0)/2:e.align==='right'?(e.width??0):0;
      displayMath(e.text!).split('\n').forEach((line,i)=>c.fillText(line,(tx-x)/sx+e.x+anchor,(ty-y)/sy+e.y+fontSize*(.92+i*1.24)));
      const pixels=c.getImageData(0,0,w,h).data,points:{x:number;y:number}[]=[];
      for(let row=0;row<h;row++)for(let col=0;col<w;col++)if(pixels[(row*w+col)*4+3]>100)points.push({x:col,y:row});return points;
    };
    const score=(points:{x:number;y:number}[],dx:number,dy:number)=>{let matches=0;for(const p of points){const row=p.y+dy,col=p.x+dx;if(row>=0&&row<h&&col>=0&&col<w&&tolerant[row*w+col])matches++;}
      return 2*matches/(points.length+targetCount);};
    const original=glyphs(size),previous=score(original,0,0),priorOverlap=iconOverlapPenalty([e],scene.style,obstacles);
    let best={score:previous,size,dx:0,dy:0,fontFamily:e.fontFamily??scene.style.font};
    const families=[e.fontFamily??scene.style.font];
    // Keep the authored face. A condensed face may resolve in Canvas but fall
    // back differently in SVG renderers; it cannot be used as a fitting trick.
    for(const fontFamily of families)for(const ratio of [.85,.95,1,1.05,1.15,1.25]) {
      const fontSize=Math.round(size*ratio*2)/2,points=fontSize===size&&fontFamily===families[0]?original:glyphs(fontSize,fontFamily);if(!points.length)continue;
      for(let dy=-18;dy<=18;dy+=2)for(let dx=-20;dx<=20;dx+=2) {
        const agreement=score(points,dx,dy)-.0005*(Math.abs(dx)+Math.abs(dy));
        if(agreement<=best.score)continue;
        const proposal={...e,fontSize,fontFamily,x:e.x+dx/sx,y:e.y+dy/sy};
        if(iconOverlapPenalty([proposal],scene.style,obstacles)>Math.min(priorOverlap,2)+1)continue;
        best={score:agreement,size:fontSize,dx,dy,fontFamily};
      }
    }
    const accepted=best.score>previous+.08;
    if(accepted)edits.push({id:e.id,patch:{fontSize:best.size,fontFamily:best.fontFamily,x:e.x+best.dx/sx,y:e.y+best.dy/sy}});
    audit.push({id:e.id,previousAgreement:previous,proposedAgreement:best.score,proposedFontSize:best.size,offset:[best.dx,best.dy],proposed:accepted});
  }
  return {edits,audit};
}
