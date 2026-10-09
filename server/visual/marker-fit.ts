import {createCanvas,loadImage} from '@napi-rs/canvas';
import type {FigureScene,Primitive} from '../../shared/types';

/** Calibrate an existing small native colored badge from its source footprint.
 * This measures a simple shape's bounds; it does not trace arbitrary imagery. */
export async function proposeMarkerFit(scene:FigureScene,reference:string) {
  const picture=await loadImage(Buffer.from(reference.split(',')[1],'base64')),ctx=createCanvas(scene.width,scene.height).getContext('2d');
  ctx.drawImage(picture,0,0,scene.width,scene.height);const pixels=ctx.getImageData(0,0,scene.width,scene.height).data,edits:any[]=[],audit:any[]=[];
  for(const e of scene.annotations) {
    // A backtracking polyline sometimes encodes an X. Preserve its exact ink
    // as two independent strokes instead of an ambiguous connected path.
    if(e.type==='path'&&e.fill==='none'&&!e.locked&&!/[CQAHVZS]/i.test(e.path??'')) {
      const points=[...(e.path??'').matchAll(/[ML]\s*([\d.-]+)[ ,]+([\d.-]+)/gi)].map(m=>({x:Number(m[1]),y:Number(m[2])}));
      if(points.length===5&&Math.hypot(points[2].x-(points[0].x+points[1].x)/2,points[2].y-(points[0].y+points[1].y)/2)<.1
        &&Math.hypot(points[2].x-(points[3].x+points[4].x)/2,points[2].y-(points[3].y+points[4].y)/2)<.1
        &&Math.max(...points.map(p=>p.x))-Math.min(...points.map(p=>p.x))<50) {
        const [a,b,,c,d]=points;edits.push({id:e.id,patch:{path:`M${a.x} ${a.y}L${b.x} ${b.y}M${c.x} ${c.y}L${d.x} ${d.y}`}});
      }
    }
    if(!['rect','ellipse'].includes(e.type)||e.layer==='background'||e.locked||e.rotation||e.gradient||!/^#[\da-f]{6}$/i.test(e.fill??''))continue;
    const w=e.width??0,h=e.height??0;if(w<8||h<8||w>45||h>45)continue;
    const rgb=[1,3,5].map(i=>parseInt(e.fill!.slice(i,i+2),16)),chroma=Math.max(...rgb)-Math.min(...rgb);if(chroma<85)continue;
    const dominant=rgb.indexOf(Math.max(...rgb)),cx=e.x+w/2,cy=e.y+h/2,pad=12;
    const x=Math.max(0,Math.floor(e.x-pad)),y=Math.max(0,Math.floor(e.y-pad)),rw=Math.min(scene.width-x,Math.ceil(w+pad*2)),rh=Math.min(scene.height-y,Math.ceil(h+pad*2));
    const mask=new Uint8Array(rw*rh),seen=new Uint8Array(mask.length);
    for(let row=0;row<rh;row++)for(let col=0;col<rw;col++) {
      const i=((y+row)*scene.width+x+col)*4,c=[pixels[i],pixels[i+1],pixels[i+2]];
      if(c.indexOf(Math.max(...c))===dominant&&c[dominant]-Math.min(...c)>75&&Math.hypot(...c.map((v,j)=>v-rgb[j]))<130)mask[row*rw+col]=1;
    }
    let best:number[]=[],nearest=Infinity;
    for(let seed=0;seed<mask.length;seed++) {
      if(!mask[seed]||seen[seed])continue;
      const queue=[seed];seen[seed]=1;let distance=Infinity;
      for(let head=0;head<queue.length;head++) {
        const p=queue[head],row=Math.floor(p/rw),col=p%rw;distance=Math.min(distance,Math.hypot(x+col-cx,y+row-cy));
        for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){const a=col+dx,b=row+dy,q=b*rw+a;if(a>=0&&a<rw&&b>=0&&b<rh&&mask[q]&&!seen[q]){seen[q]=1;queue.push(q);}}
      }
      if(queue.length>=20&&distance<nearest){nearest=distance;best=queue;}
    }
    if(nearest>Math.min(w,h)*.45||!best.length)continue;
    const rows=new Map<number,number[]>();for(const p of best){const row=Math.floor(p/rw);if(!rows.has(row))rows.set(row,[]);rows.get(row)!.push(p%rw);}
    const maximum=Math.max(...[...rows.values()].map(c=>Math.max(...c)-Math.min(...c)+1));
    const thick=[...rows].filter(([,c])=>Math.max(...c)-Math.min(...c)+1>=maximum*.6&&c.length>=maximum*.3);
    if(thick.length<5||maximum<8||maximum>w*1.7)continue;
    const left=Math.min(...thick.flatMap(([,c])=>c)),right=Math.max(...thick.flatMap(([,c])=>c)),top=Math.min(...thick.map(([r])=>r)),bottom=Math.max(...thick.map(([r])=>r));
    const circular=e.type==='ellipse'||(e.radius??0)>=Math.min(w,h)*.45;
    const width=right-left+1,height=circular?width:bottom-top+1;
    const patch:Partial<Primitive>={x:x+(left+right+1)/2-width/2,y:y+(top+bottom+1)/2-height/2,width,height};
    if(e.type==='rect')patch.radius=circular?width/2:Math.min(e.radius??3,width/4,height/4);
    if(Math.abs(width-w)+Math.abs(height-h)+Math.abs(patch.x!-e.x)+Math.abs(patch.y!-e.y)<3)continue;
    edits.push({id:e.id,patch});audit.push({id:e.id,measuredColoredPixels:best.length,patch});
  }
  return {edits,audit};
}
