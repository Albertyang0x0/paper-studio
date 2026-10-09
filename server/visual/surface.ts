import type { Point, Primitive } from '../../shared/types';
import type { ReconstructionPlan } from '../../shared/visual-contract';
import { normalizedBox } from './compiler';
import { renderedBounds } from '../bounds';

/** Convert normalized detections into native, not anisotropically scaled, vector paint/text. */
export function compileSurface(raw:any,plan:ReconstructionPlan,connectionsOnly=false):ReconstructionPlan {
  const next=structuredClone(plan),point=(p:unknown):Point=>{
    if(!Array.isArray(p)||p.length!==2||!p.every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1000))throw Error('Invalid normalized curve point');
    return {x:p[1]*plan.width/1000,y:p[0]*plan.height/1000};
  };
  if((!connectionsOnly&&(!Array.isArray(raw.backgrounds)||!Array.isArray(raw.annotations)))||!Array.isArray(raw.connectors))throw Error('Incomplete graphic-layer reconstruction');
  if(!connectionsOnly)next.backgrounds=raw.backgrounds.map((b:any):Primitive=>{
    const box=b.box_2d;
    if(Array.isArray(box)&&box.length===4&&box.every((n:any)=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1000)&&
      ((box[0]===box[2]&&box[1]<box[3])||(box[1]===box[3]&&box[0]<box[2])))
      return {id:b.id,type:'line',x:box[1]*plan.width/1000,y:box[0]*plan.height/1000,width:(box[3]-box[1])*plan.width/1000,height:(box[2]-box[0])*plan.height/1000,
        stroke:b.stroke??plan.style.muted,strokeWidth:b.strokeWidthPx??1.5,dash:b.dash};
    return {id:b.id,type:'rect',...normalizedBox(box,plan.width,plan.height),
      fill:b.fill??'none',stroke:b.stroke??'none',strokeWidth:b.strokeWidthPx??1.5,radius:b.radiusPx??0,dash:b.dash===true?[7,5]:b.dash===false?undefined:b.dash,gradient:b.gradient,opacity:b.opacity??1};
  });
  if(!connectionsOnly)next.annotations=raw.annotations.map((a:any):Primitive=>{
    const bounds=normalizedBox(a.box_2d,plan.width,plan.height);
    if(typeof a.text!=='string'||!a.text.trim())throw Error('Empty global text annotation');
    return {id:a.id,type:'text',...bounds,text:a.text,fontSize:a.fontSizePx??bounds.height/(a.text.split('\n').length*1.24),
      fontFamily:plan.style.font,fontWeight:a.fontWeight??400,fill:a.color??plan.style.ink,align:a.align??'left'};
  });
  for(const d of raw.decorations??[]) {
    if(d.shape==='rect'||d.shape==='ellipse')next.annotations.push({id:d.id,type:d.shape,...normalizedBox(d.box_2d,plan.width,plan.height),
      fill:d.fill??'none',stroke:d.stroke??'none',strokeWidth:d.strokeWidthPx??1.5,radius:d.radiusPx});
    else {
      const start=point(d.start??d.points?.[0]);let path=`M${start.x} ${start.y}`;
      if(d.shape==='curve')for(const s of d.segments??[]){const a=point(s.c1),b=point(s.c2),end=point(s.end);path+=`C${a.x} ${a.y} ${b.x} ${b.y} ${end.x} ${end.y}`;}
      else if(d.shape==='polyline')for(const p of (d.points??[]).slice(1)){const end=point(p);path+=`L${end.x} ${end.y}`;}
      else throw Error('Unknown native adornment');
      if(d.closed)path+='Z';next.annotations.push({id:d.id,type:'path',x:0,y:0,path,fill:d.fill??'none',stroke:d.stroke??plan.style.ink,strokeWidth:d.strokeWidthPx??2});
    }
  }
  // A grouping bracket can be the actual origin of a scientific connection.
  // Promote only referenced, explicitly detected decoration objects to editable
  // nodes, rather than inventing an endpoint or moving the arrow to a nearby card.
  for(const edge of raw.connectors)for(const id of [edge.from,edge.to]) {
    if(next.nodes.some(n=>n.id===id))continue;
    const decoration=next.annotations.find(e=>e.id===id&&e.type!=='text');
    if(!decoration)throw Error(`Unknown surface connector endpoint ${id}`);
    const bounds=renderedBounds([decoration],plan.width,plan.height,plan.style);
    if(!bounds)throw Error('Empty connector decoration');
    const x=Math.max(0,bounds.x-1),y=Math.max(0,bounds.y-1),width=Math.min(plan.width-x,bounds.width+2),height=Math.min(plan.height-y,bounds.height+2);
    next.nodes.push({id,title:'Grouped inputs',x,y,width,height,elements:[{...decoration,x:decoration.x-x,y:decoration.y-y}],componentIds:[],sourceRefs:[],ports:[],assets:[]});
    next.annotations=next.annotations.filter(e=>e.id!==id);
  }
  const port=(nodeId:string,position:Point,name:string)=>{
    const node=next.nodes.find(n=>n.id===nodeId);if(!node)throw Error('Unknown surface connector endpoint');
    const choices=[{side:'left',distance:Math.abs(position.x-node.x),offset:(position.y-node.y)/node.height},
      {side:'right',distance:Math.abs(position.x-node.x-node.width),offset:(position.y-node.y)/node.height},
      {side:'top',distance:Math.abs(position.y-node.y),offset:(position.x-node.x)/node.width},
      {side:'bottom',distance:Math.abs(position.y-node.y-node.height),offset:(position.x-node.x)/node.width}].sort((a,b)=>a.distance-b.distance);
    const best=choices[0];node.ports=node.ports.filter(p=>p.id!==name);
    node.ports.push({id:name,side:best.side as 'left'|'right'|'top'|'bottom',offset:Math.max(0,Math.min(1,best.offset)),
      anchor:{x:Math.max(0,Math.min(1,(position.x-node.x)/node.width)),y:Math.max(0,Math.min(1,(position.y-node.y)/node.height))}});return name;
  };
  next.connectors=raw.connectors.map((e:any)=>{
    if(typeof e.id!=='string')throw Error('Incomplete cubic connector');
    const start=point(e.start),end=point(e.end);
    const segments=Array.isArray(e.segments)&&e.segments.length?e.segments:[{c1:[e.start[0]+(e.end[0]-e.start[0])/3,e.start[1]+(e.end[1]-e.start[1])/3],c2:[e.start[0]+2*(e.end[0]-e.start[0])/3,e.start[1]+2*(e.end[1]-e.start[1])/3],end:e.end}];
    return {id:e.id,from:e.from,to:e.to,fromPort:port(e.from,start,e.id+'-out'),toPort:port(e.to,end,e.id+'-in'),
      color:e.color??plan.style.ink,strokeWidth:e.strokeWidthPx??plan.style.lineWidth,dash:!!e.dash,
      curve:segments.map((s:any)=>({c1:point(s.c1),c2:point(s.c2),end:point(s.end)}))};
  });
  for(const pair of raw.intentionalOverlaps??[]) {
    const front=next.nodes.find(n=>n.id===pair.front),back=next.nodes.find(n=>n.id===pair.back);
    if(!front||!back) {
      const graphicIds=new Set([...raw.backgrounds,...raw.annotations].map((g:any)=>g.id));
      if(graphicIds.has(pair.front)&&graphicIds.has(pair.back))continue; // header tabs on their panels already have paint order.
      throw Error('Unknown intentional blueprint overlap');
    }
    front.allowOverlapWith=[...new Set([...(front.allowOverlapWith??[]),back.id])];
  }
  return next;
}
