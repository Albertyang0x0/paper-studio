import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { FigureScene, Point, Connector } from '../../shared/types';
import { connectorGeometry } from '../../shared/svg';

class Queue {
  data:{id:number;priority:number}[]=[];
  push(value:{id:number;priority:number}){let i=this.data.push(value)-1;while(i){const p=(i-1)>>1;if(this.data[p].priority<=value.priority)break;this.data[i]=this.data[p];i=p;}this.data[i]=value;}
  pop(){const first=this.data[0],last=this.data.pop()!;if(this.data.length){let i=0;while(i*2+1<this.data.length){let child=i*2+1;if(child+1<this.data.length&&this.data[child+1].priority<this.data[child].priority)child++;if(this.data[child].priority>=last.priority)break;this.data[i]=this.data[child];i=child;}this.data[i]=last;}return first;}
}
const distance=(a:Point,b:Point)=>Math.hypot(a.x-b.x,a.y-b.y);
function simplify(points:Point[],epsilon:number):Point[] {
  if(points.length<3)return points;const a=points[0],b=points.at(-1)!,dx=b.x-a.x,dy=b.y-a.y,den=dx*dx+dy*dy;let max=0,index=0;
  points.forEach((p,i)=>{const t=den?Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/den)):0,d=distance(p,{x:a.x+t*dx,y:a.y+t*dy});if(d>max){max=d;index=i;}});
  return max>epsilon?[...simplify(points.slice(0,index+1),epsilon).slice(0,-1),...simplify(points.slice(index),epsilon)]:[a,b];
}
function smooth(points:Point[]) {
  const parts:NonNullable<Connector['curve']>=[];let previous=points[0];
  const line=(end:Point)=>{parts.push({c1:{x:previous.x+(end.x-previous.x)/3,y:previous.y+(end.y-previous.y)/3},c2:{x:previous.x+2*(end.x-previous.x)/3,y:previous.y+2*(end.y-previous.y)/3},end});previous=end;};
  for(let i=1;i<points.length-1;i++) {
    const p=points[i],next=points[i+1],r=Math.min(5,distance(previous,p)/2,distance(p,next)/2);
    const interpolate=(a:Point,b:Point,offset:number)=>{const d=distance(a,b)||1;return {x:a.x+(b.x-a.x)*offset/d,y:a.y+(b.y-a.y)*offset/d};};
    const incoming=interpolate(p,previous,r),outgoing=interpolate(p,next,r);line(incoming);
    parts.push({c1:{x:incoming.x+2*(p.x-incoming.x)/3,y:incoming.y+2*(p.y-incoming.y)/3},c2:{x:outgoing.x+2*(p.x-outgoing.x)/3,y:outgoing.y+2*(p.y-outgoing.y)/3},end:outgoing});previous=outgoing;
  }
  line(points.at(-1)!);return parts;
}

/** Follow source-image stroke evidence BETWEEN independently identified scientific
 * endpoints. Recover only connector geometry, not whole-image vector tracing. */
export async function proposeRouteFit(scene:FigureScene,reference:string) {
  const picture=await loadImage(Buffer.from(reference.split(',')[1],'base64')),ctx=createCanvas(scene.width,scene.height).getContext('2d');ctx.drawImage(picture,0,0,scene.width,scene.height);
  const pixels=ctx.getImageData(0,0,scene.width,scene.height).data,connectorEdits:any[]=[],audit:any[]=[];
  const ink=(x:number,y:number)=>{
    if(x<0||x>=scene.width||y<0||y>=scene.height)return undefined;
    const i=(Math.round(y)*scene.width+Math.round(x))*4,r=pixels[i],g=pixels[i+1],b=pixels[i+2],avg=(r+g+b)/3;
    return (Math.max(r,g,b)-Math.min(r,g,b)<40&&avg>=40&&avg<185)||(r>140&&r>g*1.7&&r>b*1.7)||(g>75&&g>r*1.3&&g>b*1.15)?[r,g,b]:undefined;
  };
  for(const edge of scene.connectors) {
    if(edge.dash)continue;const geometry=connectorGeometry(edge,scene);if(!geometry||distance(geometry.points[0],geometry.points.at(-1)!)<170)continue;
    const start=geometry.points[0],end=geometry.points.at(-1)!,points=geometry.points;
    const left=Math.max(0,Math.floor(Math.min(...points.map(p=>p.x))-38)),top=Math.max(0,Math.floor(Math.min(...points.map(p=>p.y))-38));
    const right=Math.min(scene.width-1,Math.ceil(Math.max(...points.map(p=>p.x))+38)),bottom=Math.min(scene.height-1,Math.ceil(Math.max(...points.map(p=>p.y))+38));
    const step=2,w=Math.floor((right-left)/step)+1,h=Math.floor((bottom-top)/step)+1;
    const cost=new Float32Array(w*h),came=new Int32Array(w*h).fill(-1),scores=new Float64Array(w*h).fill(Infinity),visited=new Uint8Array(w*h);
    for(let row=0;row<h;row++)for(let col=0;col<w;col++) {
      const x=left+col*step,y=top+row*step;
      const blocked=scene.modules.some(m=>x>m.x+2&&x<m.x+m.width-2&&y>m.y+2&&y<m.y+m.height-2&&distance({x,y},start)>16&&distance({x,y},end)>16);
      if(blocked){cost[row*w+col]=10000;continue;}
      let marked=false;for(let dy=-1;dy<=1&&!marked;dy++)for(let dx=-1;dx<=1;dx++)if(ink(x+dx,y+dy)){marked=true;break;}
      cost[row*w+col]=marked?1:14;
    }
    const at=(p:Point)=>Math.max(0,Math.min(h-1,Math.round((p.y-top)/step)))*w+Math.max(0,Math.min(w-1,Math.round((p.x-left)/step)));
    const first=at(start),last=at(end),queue=new Queue();scores[first]=0;queue.push({id:first,priority:0});
    while(queue.data.length){const current=queue.pop().id;if(visited[current])continue;visited[current]=1;if(current===last)break;
      const row=Math.floor(current/w),col=current%w;
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){if(!(dx||dy))continue;const nx=col+dx,ny=row+dy,next=ny*w+nx;
        if(nx<0||nx>=w||ny<0||ny>=h||visited[next]||cost[next]>=10000)continue;
        const candidate=scores[current]+cost[next]*(dx&&dy?Math.SQRT2:1);if(candidate<scores[next]){scores[next]=candidate;came[next]=current;queue.push({id:next,priority:candidate+Math.hypot(nx-last%w,ny-Math.floor(last/w))});}
      }
    }
    if(came[last]<0)continue;const path:Point[]=[];let id=last;
    while(id>=0){path.push({x:left+(id%w)*step,y:top+Math.floor(id/w)*step});id=came[id];}path.reverse();
    const marked=path.filter(p=>{for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(ink(p.x+dx,p.y+dy))return true;return false;}).length/path.length;
    if(marked<.7)continue;
    path[0]=start;path[path.length-1]=end;const simplified=simplify(path,3.2),curve=smooth(simplified);
    for(const part of curve) {
      const p=part.c1,colors:number[][]=[];
      for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){const color=ink(Math.round(p.x)+dx,Math.round(p.y)+dy);if(color)colors.push(color);}
      if(colors.length){const median=(i:number)=>colors.map(c=>c[i]).sort((a,b)=>a-b)[Math.floor(colors.length/2)];part.color='#'+[0,1,2].map(i=>median(i).toString(16).padStart(2,'0')).join('');}
    }
    connectorEdits.push({id:edge.id,curve});audit.push({id:edge.id,matchedStrokeFraction:marked,waypoints:simplified.length,segments:curve.length});
  }
  return {connectorEdits,audit};
}
