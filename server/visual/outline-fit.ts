import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { FigureScene } from '../../shared/types';

/** Measure an already identified closed card/diamond against the source outline.
 * Only its native object's box changes; no contour is traced and no raster is kept. */
export async function proposeOutlineFit(scene:FigureScene,reference:string) {
  const picture=await loadImage(Buffer.from(reference.split(',')[1],'base64')),ctx=createCanvas(scene.width,scene.height).getContext('2d');
  ctx.drawImage(picture,0,0,scene.width,scene.height);const pixels=ctx.getImageData(0,0,scene.width,scene.height).data,nodeEdits:any[]=[],audit:any[]=[];
  for(const m of scene.modules) {
    const frame=m.elements.find(e=>['rect','polygon'].includes(e.type)&&e.fill&&e.fill!=='none');if(!frame||m.width<50||m.height<30)continue;
    if(frame.type==='rect'&&((frame.width??0)<(m.contentWidth??m.width)*.65||(frame.height??0)<(m.contentHeight??m.height)*.6))continue;
    const padding=30,x=Math.max(0,Math.floor(m.x-padding)),y=Math.max(0,Math.floor(m.y-padding));
    const w=Math.min(scene.width-x,Math.ceil(m.width+padding*2)),h=Math.min(scene.height-y,Math.ceil(m.height+padding*2));
    const barrier=new Uint8Array(w*h),visited=new Uint8Array(w*h);
    for(let row=0;row<h;row++)for(let col=0;col<w;col++) {
      const i=((y+row)*scene.width+x+col)*4,r=pixels[i],g=pixels[i+1],b=pixels[i+2];
      if(Math.max(r,g,b)<220&&Math.max(r,g,b)-Math.min(r,g,b)<70)barrier[row*w+col]=1;
    }
    // Close antialiased subpixel gaps in a known solid outline.
    const closed=new Uint8Array(barrier);
    for(let row=1;row<h-1;row++)for(let col=1;col<w-1;col++)if(barrier[row*w+col])
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)closed[(row+dy)*w+col+dx]=1;
    let best:{size:number;left:number;top:number;right:number;bottom:number}|undefined;
    for(let sy=2;sy<=6;sy++)for(let sx=2;sx<=6;sx++) {
      const col=Math.round(m.x-x+m.width*sx/8),row=Math.round(m.y-y+m.height*sy/8),seed=row*w+col;
      if(col<0||col>=w||row<0||row>=h||closed[seed]||visited[seed])continue;
      const queue=new Int32Array(w*h);queue[0]=seed;visited[seed]=1;let head=0,tail=1,left=col,right=col,top=row,bottom=row,touches=false;
      while(head<tail) {
        const point=queue[head++],cy=Math.floor(point/w),cx=point%w;
        left=Math.min(left,cx);right=Math.max(right,cx);top=Math.min(top,cy);bottom=Math.max(bottom,cy);
        if(cx===0||cy===0||cx===w-1||cy===h-1)touches=true;
        for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){const nx=cx+dx,ny=cy+dy,np=ny*w+nx;if(nx>=0&&nx<w&&ny>=0&&ny<h&&!visited[np]&&!closed[np]){visited[np]=1;queue[tail++]=np;}}
      }
      if(!touches&&tail>m.width*m.height*.15&&(!best||tail>best.size))best={size:tail,left,top,right,bottom};
    }
    if(!best)continue;
    const box={x:x+best.left-2,y:y+best.top-2,width:best.right-best.left+5,height:best.bottom-best.top+5};
    if(box.width/m.width<.65||box.width/m.width>1.5||box.height/m.height<.65||box.height/m.height>1.5||box.x<0||box.y<0||box.x+box.width>scene.width||box.y+box.height>scene.height)continue;
    const delta=Math.abs(box.x-m.x)+Math.abs(box.y-m.y)+Math.abs(box.width-m.width)+Math.abs(box.height-m.height);
    if(delta<4)continue;nodeEdits.push({id:m.id,...box});audit.push({id:m.id,detectedBounds:box,previousBounds:{x:m.x,y:m.y,width:m.width,height:m.height},matchedInteriorPixels:best.size});
  }
  return {nodeEdits,audit};
}
