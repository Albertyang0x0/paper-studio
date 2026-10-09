import { randomUUID } from "node:crypto";
import type { FigureScene, Primitive, RunInput, SemanticPlan } from "../../shared/types";
import type { ReconstructionPlan } from "../../shared/visual-contract";
import { allPrimitives, connectionPort, patchPrimitive } from "../../shared/svg";
import { normalizeElements, structuralIssues } from "../validation";
import { renderedBounds } from "../bounds";
import { textBoxes, textCollisions } from "../typography";
import { objectIsLocked } from "../../shared/locks";

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const safeId = (value: unknown): value is string => typeof value === "string" && /^[\w.-]{1,100}$/.test(value);
export function normalizedBox(box:unknown,width:number,height:number) {
  if(!Array.isArray(box)||box.length!==4||!box.every(n=>finite(n)&&n>=0&&n<=1000)||box[2]<=box[0]||box[3]<=box[1])throw Error('Invalid normalized box_2d');
  const [top,left,bottom,right]=box as number[];
  return {x:left*width/1000,y:top*height/1000,width:(right-left)*width/1000,height:(bottom-top)*height/1000};
}
/** Correct common anchor/box ambiguity and tiny glyph overflow without shrinking type. */
export function containNativeText(elements:Primitive[],width:number,height:number,style:FigureScene['style']) {
  return elements.map(raw=>{
    const e=structuredClone(raw);if(e.type!=='text'||e.locked)return e;
    if(e.width && (e.align==='center'||e.align==='right') && e.x+e.width>width+2 && e.x>=e.width*(e.align==='center'?.45:.9))
      e.x-=e.width*(e.align==='center'?.5:1);
    const boxes=textBoxes([e],style);if(!boxes.length)return e;
    const left=Math.min(...boxes.map(b=>b.x)),top=Math.min(...boxes.map(b=>b.y));
    const right=Math.max(...boxes.map(b=>b.x+b.width)),bottom=Math.max(...boxes.map(b=>b.y+b.height));
    if(right-left<=width-2)e.x+=left<1?1-left:right>width-1?width-1-right:0;
    if(bottom-top<=height-2)e.y+=top<1?1-top:bottom>height-1?height-1-bottom:0;
    return e;
  });
}
function geometry(box: {x:number;y:number;width:number;height:number}, width: number, height: number) {
  return [box.x,box.y,box.width,box.height].every(finite) && box.width > 0 && box.height > 0 &&
    box.x >= -2 && box.y >= -2 && box.x + box.width <= width + 2 && box.y + box.height <= height + 2;
}
/** Include an illustration that the planner placed just outside the invisible node crop.
 * Global artwork and port positions stay unchanged; only the crop/ownership bounds expand. */
function includeAssetBounds(node:ReconstructionPlan['nodes'][number],assets:ReconstructionPlan['assets']) {
  const slots=node.assets??[];
  if(!slots.length)return;
  // Some vision models emit global asset positions despite the local-slot contract.
  // Convert only when the declared representative crop or containment proves that frame.
  for(const slot of slots) {
    const asset=assets.find(a=>a.id===slot.assetId);
    const globalInside=slot.x>=node.x-2 && slot.y>=node.y-2 && slot.x+slot.width<=node.x+node.width+2 && slot.y+slot.height<=node.y+node.height+2;
    const localInside=geometry(slot,node.width,node.height);
    const matchesCrop=asset && Math.hypot(slot.x-asset.crop.x,slot.y-asset.crop.y)<4 && Math.hypot(node.x+slot.x-asset.crop.x,node.y+slot.y-asset.crop.y)>10;
    if(globalInside && (!localInside||matchesCrop)){slot.x-=node.x;slot.y-=node.y;}
  }
  const minX=Math.min(0,...slots.map(s=>s.x)),minY=Math.min(0,...slots.map(s=>s.y));
  const right=Math.max(node.width,...slots.map(s=>s.x+s.width)),bottom=Math.max(node.height,...slots.map(s=>s.y+s.height));
  if(minX===0&&minY===0&&right===node.width&&bottom===node.height)return;
  for(const port of node.ports??[]) {
    if(port.anchor)port.anchor={x:(port.anchor.x*node.width-minX)/(right-minX),y:(port.anchor.y*node.height-minY)/(bottom-minY)};
    const horizontal=port.side==='top'||port.side==='bottom';
    port.offset=(port.offset*(horizontal?node.width:node.height)-(horizontal?minX:minY))/(horizontal?right-minX:bottom-minY);
  }
  node.x+=minX;node.y+=minY;node.width=right-minX;node.height=bottom-minY;
  node.assets=slots.map(s=>({...s,x:s.x-minX,y:s.y-minY}));
  node.elements=(node.elements??[]).map(e=>({...e,x:(e.x??0)-minX,y:(e.y??0)-minY}));
}
export function validateReconstructionPlan(raw: ReconstructionPlan, semantic: SemanticPlan, input: RunInput,
  size: {width:number;height:number}): ReconstructionPlan {
  const plan = structuredClone(raw);
  if (plan.width !== size.width || plan.height !== size.height) throw Error("Blueprint pixel dimensions must be preserved exactly");
  if (!plan.style?.font || !Array.isArray(plan.nodes) || plan.nodes.length < 2 || plan.nodes.length > 40)
    throw Error("No valid object-level reconstruction plan");
  plan.assets ??= []; plan.backgrounds ??= []; plan.annotations ??= []; plan.connectors ??= [];
  if (plan.assets.length > 16) throw Error("Use at most 16 unique illustration specialists, with repeated asset placements");
  const ids = new Set<string>(), assetIds = new Set<string>();
  for (const asset of plan.assets) {
    if (!safeId(asset.id) || assetIds.has(asset.id) || !geometry(asset.crop,plan.width,plan.height) ||
      ![asset.width,asset.height].every(finite) || asset.width < 8 || asset.height < 8 || asset.width > 800 || asset.height > 800 || !asset.brief)
      throw Error(`Invalid illustration crop or local canvas: ${asset.id}`);
    assetIds.add(asset.id);
  }
  const filenames = new Set(input.materials.map(m=>m.name));
  const known = new Set(semantic.components.map(c=>c.id));
  const covered = new Set<string>();
  for (const node of plan.nodes) {
    includeAssetBounds(node,plan.assets);
    if (!safeId(node.id) || ids.has(node.id) || !geometry(node,plan.width,plan.height)) throw Error(`Invalid node geometry: ${node.id}`);
    ids.add(node.id); node.ports ??= []; node.assets ??= []; node.componentIds ??= []; node.sourceRefs ??= [];
    for (const id of node.componentIds) { if (!known.has(id)) throw Error(`Unsupported component: ${id}`); covered.add(id); }
    if (node.sourceRefs.some(name=>!filenames.has(name))) throw Error(`Unknown source in ${node.id}`);
    if (node.ports.some(p=>!safeId(p.id) || !["left","right","top","bottom"].includes(p.side) || !finite(p.offset) || p.offset<0 || p.offset>1 || (p.anchor&&![p.anchor.x,p.anchor.y].every(n=>finite(n)&&n>=0&&n<=1))))
      throw Error(`Invalid boundary port in ${node.id}`);
    for (const placement of node.assets)
      if (!assetIds.has(placement.assetId) || !geometry(placement,node.width,node.height)) throw Error(`Invalid asset slot in ${node.id}`);
    node.elements = node.elements?.length ? normalizeElements(node.elements, {id:node.id,width:node.width,height:node.height,labels:[]},false) : [];
  }
  for(const asset of plan.assets) {
    const placements=plan.nodes.flatMap(n=>n.assets.filter(s=>s.assetId===asset.id).map(s=>({x:n.x+s.x,y:n.y+s.y,width:s.width,height:s.height})));
    if(!placements.some(p=>Math.max(0,Math.min(p.x+p.width+8,asset.crop.x+asset.crop.width)-Math.max(p.x-8,asset.crop.x))*
      Math.max(0,Math.min(p.y+p.height+8,asset.crop.y+asset.crop.height)-Math.max(p.y-8,asset.crop.y)) >= asset.crop.width*asset.crop.height*.5))
      throw Error(`Illustration crop ${asset.id} must overlap one actual GLOBAL node asset placement, not a (0,0) placeholder`);
  }
  if (plan.backgrounds.length) plan.backgrounds = normalizeElements(plan.backgrounds,{id:"background",width:plan.width,height:plan.height,labels:[]},false);
  if (plan.annotations.length) plan.annotations = normalizeElements(plan.annotations,{id:"annotations",width:plan.width,height:plan.height,labels:[]},false);
  for (const element of allPrimitives(plan.annotations))
    for (const id of element.componentIds ?? []) { if (!known.has(id)) throw Error(`Unsupported annotation component: ${id}`); covered.add(id); }
  for (const component of semantic.components) if (!covered.has(component.id)) throw Error(`Missing source-grounded component ${component.id}`);
  for(const node of plan.nodes)if(node.allowOverlapWith?.some(id=>!ids.has(id)))throw Error('Unknown intentional overlap owner');
  for (const edge of plan.connectors) {
    if (!safeId(edge.id) || !ids.has(edge.from) || !ids.has(edge.to)) throw Error(`Invalid scientific edge ${edge.id}`);
    if (edge.curve?.some(segment=>[segment.c1,segment.c2,segment.end].some(point=>!point || ![point.x,point.y].every(finite))))
      throw Error(`Non-finite curve geometry ${edge.id}`);
  }
  for (const element of allPrimitives([...plan.backgrounds,...plan.annotations,...plan.nodes.flatMap(n=>n.elements)])) {
    for (const paint of [element.fill,element.stroke])
      if (paint && !/^(?:#[\da-f]{3,8}|none)$/i.test(paint)) throw Error(`Only native hex/none paint allowed: ${element.id}`);
  }
  plan.style.palette ??= ["#dcecf4","#f9ead5","#e0edde"];
  plan.style.bodySize = Number(plan.style.bodySize) || 24;
  plan.style.titleSize = Number(plan.style.titleSize) || 28;
  plan.style.lineWidth = Number(plan.style.lineWidth) || 1.5;
  return plan;
}
function namespace(elements: Primitive[], prefix: string): Primitive[] {
  return elements.map(e=>({...e,id:prefix+e.id,containerId:e.containerId ? prefix+e.containerId : undefined,
    children:e.children ? namespace(e.children,prefix) : undefined}));
}
export function compileReconstruction(plan: ReconstructionPlan, assets: Record<string,Primitive[]>, semantic: SemanticPlan, input: RunInput): FigureScene {
  const scene: FigureScene = {
    schema:"paper-atelier/1", id:randomUUID(), title:plan.title, width:plan.width,height:plan.height,style:plan.style,
    publicationWidthPt:input.publicationWidthPt, regions:[],connectors:structuredClone(plan.connectors),
    modules:plan.nodes.map(node=>({ ...node,title:node.title || node.id,role:node.assets.length ? "illustration" : "structure",
      brief:"Exact visual-blueprint object; preserve geometry and scientific meaning.",labels:allPrimitives(node.elements).filter(e=>e.type==="text").map(e=>e.text!),
      method:"vector-agent",status:"ready",model:input.config.worker,contentWidth:node.width,contentHeight:node.height,
      elements:[...namespace(node.elements,node.id+"__"),...node.assets.map((slot,i)=>{
        const asset=plan.assets.find(a=>a.id===slot.assetId)!;
        if (!assets[asset.id]) throw Error(`Illustration specialist ${asset.id} has not completed`);
        return {id:`${node.id}__asset_${asset.id}_${i}`,type:"group" as const,x:slot.x,y:slot.y,
          scaleX:slot.width/asset.width,scaleY:slot.height/asset.height,children:namespace(assets[asset.id],`${node.id}__${asset.id}_${i}__`)};
      })]})),
    annotations:[...namespace(plan.backgrounds,"background__").map(e=>({...e,layer:"background" as const})),...namespace(plan.annotations,"annotation__")],
    semanticPlan:semantic,materials:input.materials,agentConfig:input.config,intent:input.intent,figureType:input.figureType,
    designRationale:plan.rationale,reconstruction:{version:1,referenceId:"selected-blueprint",assetIds:plan.assets.map(a=>a.id),iterations:0,fidelityPassed:false},
  };
  // A calibrated node can own a label previously planned as a separate annotation.
  // Suppress only exact duplicates spatially inside the owning node, never distinct labels.
  const wording=(s:string)=>s.replace(/\s+/g,' ').trim();
  scene.annotations=scene.annotations.filter(e=>e.type!=='text'||!scene.modules.some(m=>e.x>=m.x-2 && e.x<=m.x+m.width+2 && e.y>=m.y-2 && e.y<=m.y+m.height+2 &&
    allPrimitives(m.elements).some(child=>child.type==='text'&&wording(child.text??'')===wording(e.text??''))));
  for (const edge of scene.connectors) {
    const source=scene.modules.find(m=>m.id===edge.from)!, target=scene.modules.find(m=>m.id===edge.to)!;
    edge.curveAnchors={start:connectionPort(source,edge.fromPort,target),end:connectionPort(target,edge.toPort,source)};
  }
  return scene;
}
export function reconstructionIssues(scene: FigureScene) {
  const issues=structuralIssues(scene,false);
  for(const node of scene.modules) {
    const bounds=renderedBounds(node.elements,node.contentWidth??node.width,node.contentHeight??node.height,scene.style);
    if(bounds && (bounds.x < -4 || bounds.y < -4 || bounds.right > node.contentWidth!+4 || bounds.bottom > node.contentHeight!+4))
      issues.push({moduleId:node.id,severity:"medium",message:`Actual vector content exceeds node bounds: ${JSON.stringify(bounds)}`});
    for(const message of textCollisions(node.elements,scene.style))issues.push({moduleId:node.id,severity:"high",message});
  }
  for(const message of textCollisions(scene.annotations.filter(e=>e.layer!=="background"),scene.style))
    issues.push({moduleId:undefined,severity:"high",message});
  const globalText:Primitive[]=scene.modules.map(m=>({id:m.id+'-text-geometry',type:'group',x:m.x,y:m.y,scaleX:m.width/(m.contentWidth??m.width),scaleY:m.height/(m.contentHeight??m.height),children:m.elements}));
  globalText.push(...scene.annotations.filter(e=>e.layer!=='background'));
  for(const message of textCollisions(globalText,scene.style))if(!issues.some(i=>i.message===message))issues.push({severity:'high',message});
  return issues;
}
export function applyReconstructionEdits(scene: FigureScene, report: any): FigureScene {
  const next=structuredClone(scene);
  const allowed=new Set(["x","y","width","height","radius","fill","stroke","strokeWidth","fontSize","fontFamily","fontWeight","align","opacity","path","points","gradient","scaleX","scaleY","rotation","dash"]);
  const existing=allPrimitives([...next.annotations,...next.modules.flatMap(m=>m.elements)]);
  for(const edit of report.edits??[]) {
    const object=existing.find(e=>e.id===edit.id);
    if(!object)throw Error(`Patch references missing object ${edit.id}`);
    if(objectIsLocked([...next.annotations,...next.modules.flatMap(m=>m.elements)],edit.id))continue;
    const patch:Record<string,unknown>={};
    for(const [key,value] of Object.entries(edit.patch??{})) {
      if(key==="text" && value===object.text)continue;
      if(!allowed.has(key))throw Error(`Reconstruction patch cannot change ${key}`);
      patch[key]=value;
    }
    next.annotations=patchPrimitive(next.annotations,edit.id,patch);
    next.modules=next.modules.map(m=>m.locked ? m : {...m,elements:patchPrimitive(m.elements,edit.id,patch)});
  }
  for(const edit of report.nodeEdits??[]) {
    const node=next.modules.find(n=>n.id===edit.id);
    if(!node)throw Error(`Unknown node patch ${edit.id}`);
    if(node.locked || allPrimitives(node.elements).some(e=>e.locked))continue;
    for(const key of ["x","y","width","height"] as const)if(edit[key]!==undefined){if(!finite(edit[key]))throw Error("Invalid node patch geometry");node[key]=edit[key];}
    if(!geometry(node,next.width,next.height))throw Error(`Node patch exceeds canvas ${node.id}`);
  }
  for(const edit of report.connectorEdits??[]) {
    const edge=next.connectors.find(c=>c.id===edit.id);
    if(!edge)throw Error(`Unknown edge patch ${edit.id}`);
    if(edit.curve!==undefined) {
      if(!Array.isArray(edit.curve) || edit.curve.some((s:any)=>[s.c1,s.c2,s.end].some((p:any)=>!p || ![p.x,p.y].every(finite))))throw Error("Invalid curve patch");
      edge.curve=edit.curve;
      const source=next.modules.find(m=>m.id===edge.from)!,target=next.modules.find(m=>m.id===edge.to)!;
      edge.curveAnchors={start:connectionPort(source,edge.fromPort,target),end:connectionPort(target,edge.toPort,source)};
    }
    if(edit.color!==undefined){edge.color=edit.color;if(edit.curve===undefined)edge.curve=edge.curve?.map(({color:_color,...part})=>part);}
    if(edit.strokeWidth!==undefined){if(!finite(edit.strokeWidth))throw Error("Invalid edge width");edge.strokeWidth=edit.strokeWidth;}
  }
  for(const module of next.modules)module.elements=normalizeElements(module.elements,module,false);
  if(next.annotations.length)next.annotations=normalizeElements(next.annotations,{id:"annotations",width:next.width,height:next.height,labels:[]},false);
  return next;
}
