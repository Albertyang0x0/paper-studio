import { util } from "fabric";
import type { Connector, FigureScene, Point, Primitive, SceneModule } from "../../shared/types";
import { shouldRenderConnectorLabel } from "../../shared/svg";

export interface SvgConnectorSource {
  element: Element;
  paths: { primitive: Primitive; heads: Primitive[]; markerStart: boolean; markerEnd: boolean }[];
  labels: Primitive[];
}
type Curve = NonNullable<Connector["curve"]>;
type Candidate = { source: SvgConnectorSource; connector?: Connector; consumed: Set<string>; first: number; last: number; reason?: string; metadata: boolean };
const near = (a: Point,b: Point,tolerance=1e-4) => Math.hypot(a.x-b.x,a.y-b.y)<=tolerance;
const opaque = (p:Primitive) => (p.opacity??1)===1&&!p.gradient;

function nativeCurve(path: string): { start: Point; end: Point; curve: Curve } | undefined {
  const commands=util.makePathSimpler(util.parsePath(path));
  if(commands[0]?.[0]!=="M")return;
  const start={x:Number(commands[0][1]),y:Number(commands[0][2])},curve:Curve=[];let previous=start;
  for(const command of commands.slice(1)){
    const n=command.slice(1).map(Number);if(n.some(v=>!Number.isFinite(v)))return;
    let c1:Point,c2:Point,end:Point;
    if(command[0]==="C") {c1={x:n[0],y:n[1]};c2={x:n[2],y:n[3]};end={x:n[4],y:n[5]};}
    else if(command[0]==="L") {end={x:n[0],y:n[1]};c1={x:previous.x+(end.x-previous.x)/3,y:previous.y+(end.y-previous.y)/3};c2={x:previous.x+(end.x-previous.x)*2/3,y:previous.y+(end.y-previous.y)*2/3};}
    else if(command[0]==="Q") {end={x:n[2],y:n[3]};c1={x:previous.x+(n[0]-previous.x)*2/3,y:previous.y+(n[1]-previous.y)*2/3};c2={x:end.x+(n[0]-end.x)*2/3,y:end.y+(n[1]-end.y)*2/3};}
    else return; // closed paths and disconnected subpaths are not connectors
    curve.push({c1,c2,end});previous=end;
  }
  return curve.length?{start,end:previous,curve}:undefined;
}

function standardArrow(head: Primitive,shaft:Primitive,curve:Curve,end:Point){
  if(head.type!=="path"||!head.path||!opaque(head)||head.stroke!=="none"||head.fill!==shaft.stroke)return false;
  const commands=util.makePathSimpler(util.parsePath(head.path));
  if(commands.length!==4||commands[0][0]!=="M"||commands[1][0]!=="L"||commands[2][0]!=="L"||commands[3][0]!=="Z")return false;
  const last=curve.at(-1)!,previous=curve.length>1?curve[curve.length-2].end:undefined;
  let dx=end.x-last.c2.x,dy=end.y-last.c2.y;
  if(Math.hypot(dx,dy)<1e-8){dx=end.x-last.c1.x;dy=end.y-last.c1.y;}
  if(Math.hypot(dx,dy)<1e-8&&previous){dx=end.x-previous.x;dy=end.y-previous.y;}
  const size=Math.hypot(dx,dy);if(size<1e-8)return false;
  const cosine=dx/size,sine=dy/size,scale=.7*(shaft.strokeWidth??1);
  const expected=[[-9,-5],[1,0],[-9,5]].map(([x,y])=>({x:end.x+scale*(cosine*x-sine*y),y:end.y+scale*(sine*x+cosine*y)}));
  const actual=commands.slice(0,3).map(command=>({x:Number(command[1])+head.x,y:Number(command[2])+head.y}));
  return expected.every(point=>actual.some(other=>near(point,other,Math.max(1e-3,scale*1e-3))));
}

function smoothJoins(start:Point,curve:Curve){
  for(let index=1;index<curve.length;index++){
    const previous=curve[index-1],next=curve[index],join=previous.end,previousStart=index===1?start:curve[index-2].end;
    const incoming=[previous.c2,previous.c1,previousStart].map(p=>({x:join.x-p.x,y:join.y-p.y})).find(p=>Math.hypot(p.x,p.y)>1e-8);
    const outgoing=[next.c1,next.c2,next.end].map(p=>({x:p.x-join.x,y:p.y-join.y})).find(p=>Math.hypot(p.x,p.y)>1e-8);
    if(!incoming||!outgoing)return false;
    const product=Math.hypot(incoming.x,incoming.y)*Math.hypot(outgoing.x,outgoing.y);
    if((incoming.x*outgoing.x+incoming.y*outgoing.y)/product<1-1e-6||Math.abs(incoming.x*outgoing.y-incoming.y*outgoing.x)/product>1e-5)return false;
  }
  return true;
}

function closeToModule(point:Point,module:SceneModule,width:number){
  const margin=Math.max(12,width*3,Math.min(module.width,module.height)*.12);
  return point.x>=module.x-margin&&point.x<=module.x+module.width+margin&&point.y>=module.y-margin&&point.y<=module.y+module.height+margin;
}
function addPort(module:SceneModule,id:string,point:Point){
  const anchor={x:(point.x-module.x)/module.width,y:(point.y-module.y)/module.height};
  const distances=[{side:"left" as const,d:Math.abs(anchor.x)},{side:"right" as const,d:Math.abs(1-anchor.x)},{side:"top" as const,d:Math.abs(anchor.y)},{side:"bottom" as const,d:Math.abs(1-anchor.y)}].sort((a,b)=>a.d-b.d);
  const side=distances[0].side,offset=Math.max(0,Math.min(1,side==="left"||side==="right"?anchor.y:anchor.x));
  module.ports.push({id,side,offset,anchor});
}

/** Recover only validated connection topology; geometry always comes from parsed SVG primitives. */
export function promoteSvgConnectors(scene:FigureScene,root:Element,sources:SvgConnectorSource[],primitives:Primitive[],firstModuleIndex:number,warnings:Set<string>){
  if(!sources.length)return;
  const topology=new Map<string,{from:string;to:string}|undefined>();
  for(const metadata of Array.from(root.children).filter(el=>el.localName==="metadata")){
    try {
      const project:unknown=JSON.parse(metadata.textContent??"");
      if(!project||typeof project!=="object"||!("schema" in project)||project.schema!=="paper-atelier/1"||!("connectors" in project)||!Array.isArray(project.connectors))continue;
      for(const edge of project.connectors){
        if(!edge||typeof edge!=="object"||typeof edge.id!=="string"||typeof edge.from!=="string"||typeof edge.to!=="string")continue;
        topology.set(edge.id,topology.has(edge.id)?undefined:{from:edge.from,to:edge.to});
      }
    } catch { /* optional metadata is never required to import actual SVG artwork */ }
  }
  const indices=new Map(primitives.map((p,index)=>[p.id,index]));
  const sourceIdCounts=new Map<string,number>();for(const source of sources){const id=source.element.getAttribute("data-connector-id")??"";sourceIdCounts.set(id,(sourceIdCounts.get(id)??0)+1);}
  const moduleIdCounts=new Map<string,number>();for(const group of Array.from(root.querySelectorAll("g[data-module-id]"))){if(group.closest("defs,metadata"))continue;const id=group.getAttribute("data-module-id")!;moduleIdCounts.set(id,(moduleIdCounts.get(id)??0)+1);}
  const candidates:Candidate[]=sources.map(source=>{
    const consumed=new Set([...source.paths.flatMap(path=>[path.primitive,...path.heads]),...source.labels].map(p=>p.id));
    const positions=[...consumed].map(id=>indices.get(id)??-1),candidate:Candidate={source,consumed,first:Math.min(...positions),last:Math.max(...positions),metadata:false};
    const reject=(reason:string)=>{candidate.reason=reason;return candidate;};
    const id=source.element.getAttribute("data-connector-id")??"";
    if(!id||sourceIdCounts.get(id)!==1)return reject("连接线标识缺失或重复");
    const hasExplicit=source.element.hasAttribute("data-from")||source.element.hasAttribute("data-to");
    const relation=hasExplicit?{from:source.element.getAttribute("data-from")??"",to:source.element.getAttribute("data-to")??""}:topology.get(id);
    if(!relation)return reject("缺少可验证的起点、终点模块信息");
    const from=scene.modules.find(m=>m.id===relation.from),to=scene.modules.find(m=>m.id===relation.to);
    if(!from||!to||from===to||(moduleIdCounts.get(relation.from)??1)!==1||(moduleIdCounts.get(relation.to)??1)!==1)return reject("起点或终点模块无效或不唯一");
    if(!source.paths.length||source.paths.some(path=>path.markerStart)||source.paths.slice(0,-1).some(path=>path.markerEnd)||!source.paths.at(-1)!.markerEnd)return reject("需要单一终点箭头和连续的开放路径");
    const drawable=Array.from(source.element.querySelectorAll("path,line,polyline,polygon,rect,circle,ellipse,text")).filter(el=>!el.closest("defs"));
    if(drawable.length!==source.paths.length+source.labels.length)return reject("分组包含额外图形或复杂文字");
    const first=source.paths[0].primitive,strokeWidth=first.strokeWidth??1,dash=first.dash??[];
    if(!(strokeWidth>0)||!(dash.length===0||(dash.length===2&&near({x:dash[0],y:dash[1]},{x:7,y:5}))))return reject("当前工程不能无损表示该描边或虚线样式");
    const curve:Curve=[];let start:Point|undefined,end:Point|undefined;
    for(const path of source.paths){
      const p=path.primitive;
      if(p.type!=="path"||!p.path||p.fill!=="none"||!p.stroke||p.stroke==="none"||!opaque(p)||p.strokeLineCap!=="round"||(p.strokeDashOffset??0)!==0||(p.scaleX??1)!==1||(p.scaleY??1)!==1||(p.rotation??0)!==0||Math.abs((p.strokeWidth??1)-strokeWidth)>1e-6||JSON.stringify(p.dash??[])!==JSON.stringify(dash))return reject("路径样式超出原生连接线支持范围");
      const parsed=nativeCurve(p.path);if(!parsed||end&&!near(end,parsed.start))return reject("路径不连续、闭合或包含多个子路径");
      if(parsed.curve.length>1&&dash.length)return reject("多段虚线转换会重置虚线起始位置");
      if(parsed.curve.length>1&&p.stroke.length===9&&!p.stroke.toLowerCase().endsWith("ff"))return reject("半透明曲线分段后会改变交接处的透明度");
      if(!smoothJoins(parsed.start,parsed.curve))return reject("路径中的尖角或反向交接无法保留原来的描边连接样式");
      start??=parsed.start;end=parsed.end;curve.push(...parsed.curve.map(part=>({...part,color:p.stroke})));
      if(!path.markerEnd&&path.heads.length)return reject("包含额外箭头标记");
    }
    const last=source.paths.at(-1)!;
    if(last.heads.length!==1||!standardArrow(last.heads[0],last.primitive,curve,end!))return reject("自定义箭头形状或颜色无法无损转换");
    if(!hasExplicit&&(!closeToModule(start!,from,strokeWidth)||!closeToModule(end!,to,strokeWidth)))return reject("SVG 当前端点与旧工程中的模块关系不符");
    const connector:Connector={id,from:from.id,to:to.id,fromPort:`${id}-svg-out`,toPort:`${id}-svg-in`,color:first.stroke,strokeWidth,dash:dash.length>0,curve,curveAnchors:{start:start!,end:end!}};
    if(source.labels.length){
      const label=source.labels[0];
      if(source.labels.length!==1||!label.text||!opaque(label)||label.stroke!=="none"||label.fill!==first.stroke||label.align!=="center"||Math.abs((label.fontSize??16)-17)>1e-6||(label.fontWeight??400)!==400||label.italic||(label.rotation??0)!==0||(label.scaleX??1)!==1||(label.scaleY??1)!==1||!/^['"]?Arial(?:['"]?\s*,|['"]?$)/i.test(label.fontFamily??"Arial"))return reject("连接线文字含有当前原生连接线不能保留的排版样式");
      connector.label=label.text;connector.labelAt={x:label.x+(label.width??0)/2,y:label.y+17};
      if(!shouldRenderConnectorLabel(connector,scene))return reject("原生连接线的文字去重会隐藏当前 SVG 中可见的标注");
    }
    if(firstModuleIndex<0||candidate.first<0||candidate.last>=firstModuleIndex||candidate.last-candidate.first+1!==consumed.size)return reject("该连接线的前后遮挡顺序不能放入原生连接线图层");
    candidate.connector=connector;candidate.metadata=!hasExplicit;return candidate;
  });
  // Native connectors render after background annotations and before modules.
  // Promote only a complete compatible suffix of that prefix, so even fallback
  // arrows or intervening global artwork retain their original painter order.
  const byIndex=new Map<number,Candidate>();for(const candidate of candidates)if(candidate.connector)for(let i=candidate.first;i<=candidate.last;i++)byIndex.set(i,candidate);
  const promoted=new Set<Candidate>();
  for(let index=firstModuleIndex-1;index>=0;){const candidate=byIndex.get(index);if(!candidate||candidate.last!==index)break;promoted.add(candidate);index=candidate.first-1;}
  const removed=new Set<string>();
  for(const candidate of candidates.sort((a,b)=>a.first-b.first)){
    if(!promoted.has(candidate)){
      const id=candidate.source.element.getAttribute("data-connector-id")||"未命名";
      warnings.add(`连接线“${id}”保留为可编辑路径：${candidate.reason??"为保留原有遮挡顺序，未转换为原生连接线"}。`);continue;
    }
    const connector=candidate.connector!;
    addPort(scene.modules.find(m=>m.id===connector.from)!,connector.fromPort!,connector.curveAnchors!.start);
    addPort(scene.modules.find(m=>m.id===connector.to)!,connector.toPort!,connector.curveAnchors!.end);
    scene.connectors.push(connector);for(const id of candidate.consumed)removed.add(id);
  }
  scene.annotations=scene.annotations.filter(p=>!removed.has(p.id));
  if(promoted.size)warnings.add(`已恢复 ${promoted.size} 条原生连接线；移动对应模块时，连接线端点会跟随。`);
  if([...promoted].some(candidate=>candidate.metadata))warnings.add("仅沿用已验证的工程连接关系；连接线位置、曲线、颜色和端口均按当前 SVG 重建。");
}
