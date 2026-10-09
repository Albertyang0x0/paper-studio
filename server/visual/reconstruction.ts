import type { FigureScene, Primitive, RunInput, RunRecord, SemanticPlan } from "../../shared/types";
import type { ReconstructionCheckpoint, ReconstructionPlan, VisualAsset, VisualNode } from "../../shared/visual-contract";
import { allPrimitives, patchPrimitive, sceneSvg } from "../../shared/svg";
import { Resvg } from "@resvg/resvg-js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { outputPath } from "../storage";
import { modelJson, boundModel, referenceImages, bundledReferenceImages, type Log } from "../model";
import { groundingPrompt } from "../prompts";
import { preserveLockedObjects } from '../../shared/locks';
import { replaceSnapshot } from '../paper/store';
import { validateSemantic, normalizeElements } from "../validation";
import { renderedBounds } from "../bounds";
import { applyReconstructionEdits, compileReconstruction, containNativeText, normalizedBox, reconstructionIssues, validateReconstructionPlan } from "./compiler";
import { blueprintGuide, cropBlueprint, modelImage, rasterBlueprint } from "./image-model";
import { assetPrompt, compositionPrompt, decompositionPrompt, fidelityCriticPrompt, geometryPrompt, nodePrompt, surfacePrompt, visualBriefPrompt } from "./prompts";
import { compileSurface } from './surface';
import { restoreBlueprintPaint } from './paint';
import { guardTextEdits } from './text-guard';
import { localAssetGeometryPrompt, applyLocalAssetGeometry } from './local-geometry';
import { guardVisualEdits } from './visual-guard';
import { proposeTypographyFit } from './typography-fit';
import { routingPrompt } from './routing';
import { proposeOutlineFit } from './outline-fit';
import { fitPolygonPorts } from './port-fit';
import { proposeRouteFit } from './route-fit';
import { proposeMarkerFit } from './marker-fit';

const render = (scene: FigureScene) => new Resvg(sceneSvg(scene,false),{font:{loadSystemFonts:true,defaultFontFamily:scene.style.font}}).render().asPng();
const image = (scene: FigureScene) => `data:image/png;base64,${render(scene).toString("base64")}`;
// Review geometry and stable IDs, not the entire illustration path program or
// a duplicated execution history. The two images remain the visual evidence.
const reviewScene=(scene:FigureScene)=>{
  const compact=(items:Primitive[]):any[]=>items.map(e=>{
    const {children,path,...geometry}=e;return {...geometry,path:e.id.startsWith('annotation__')?path:undefined,children:children?compact(children):undefined};
  });
  return {...scene,materials:undefined,semanticPlan:undefined,history:undefined,
    geometryNote:'Some long path programs are omitted. Path translations can be negative because their original control points are positive/global; translations alone are not visible bounds. The independently rendered localInkBounds and actual image are the visible geometry authority.',
    modules:scene.modules.map(m=>({...m,localInkBounds:renderedBounds(m.elements,m.contentWidth??m.width,m.contentHeight??m.height,scene.style),elements:compact(m.elements)}))};
};
type Model = typeof modelJson;
export interface VisualServices {
  model?: Model;
  imageModel?: typeof modelImage;
  save?: (name: string, value: unknown) => Promise<void>;
  saveImage?: (name: string, bytes: Buffer) => Promise<void>;
}

async function illustration(asset: VisualAsset, reference: string, input: RunInput, signal: AbortSignal,
  model: Model, log: Log, previous?: Primitive[], instruction?: string): Promise<Primitive[]> {
  const crop=await cropBlueprint(reference,asset);
  let error:unknown, draft:unknown;
  for(let attempt=0;attempt<2;attempt++) {
    log(`asset:${asset.id}`,"running",`${asset.name} · 矢量插画${attempt ? "修订" : "重建"}`);
    const result=await boundModel(input.config.connections?.worker, model)(input.config.worker,assetPrompt,{task:asset,styleTarget:"precise cropped blueprint",
      previousElements:previous,previousDraft:draft,instruction,validationFeedback:error ? String(error) : undefined},[crop],signal,10000);
    draft=result;
    try {
      if(allPrimitives(result.elements??[]).some(e=>e.type==="symbol"))throw Error("Stock symbols cannot replace bespoke illustrations");
      const elements=normalizeElements(result.elements,{id:asset.id,width:asset.width,height:asset.height,labels:[]});
      if(allPrimitives(elements).some(e=>e.type==="text"))throw Error("Illustration specialist must not bake in scientific labels");
      const bounds=renderedBounds(elements,asset.width,asset.height,{font:"Arial",ink:"#222222",muted:"#666666",accent:"#222222",palette:[],lineWidth:1.5,bodySize:24,titleSize:28,illustrationStyle:"bespoke"});
      if(!bounds)throw Error("Illustration has no visible vector content");
      if(bounds.width > asset.width*1.7 || bounds.height > asset.height*1.7)throw Error("Asset exceeds its local canvas; do not draw the surrounding card");
      const scale=Math.min((asset.width-4)/bounds.width,(asset.height-4)/bounds.height,1);
      const dx=(asset.width-bounds.width*scale)/2-bounds.x*scale;
      const dy=(asset.height-bounds.height*scale)/2-bounds.y*scale;
      log(`asset:${asset.id}`,"complete",`${asset.name} · ${allPrimitives(elements).length} 个可编辑元素`);
      return [{id:asset.id+"-geometry",type:"group",x:dx,y:dy,scaleX:scale,scaleY:scale,children:elements}];
    }catch(failure){error=failure;log(`asset:${asset.id}`,"warning",String(failure));}
  }
  throw Error(`Asset ${asset.id} failed: ${String(error)}`);
}
function replaceAsset(scene: FigureScene, plan: ReconstructionPlan, assetId: string, elements: Primitive[]) {
  const next=structuredClone(scene);
  for(const node of plan.nodes)node.assets.forEach((slot,index)=>{
    if(slot.assetId!==assetId)return;
    const module=next.modules.find(m=>m.id===node.id);
    if(!module || module.locked)return;
    const id=`${node.id}__asset_${assetId}_${index}`;
    const prefix=`${node.id}__${assetId}_${index}__`;
    const copy=(items:Primitive[]):Primitive[]=>items.map(e=>({...e,id:prefix+e.id,containerId:e.containerId?prefix+e.containerId:undefined,children:e.children ? copy(e.children) : undefined}));
    module.elements=preserveLockedObjects(module.elements,patchPrimitive(module.elements,id,{children:copy(elements)}));
  });
  return next;
}
async function nativeNode(node:VisualNode,style:FigureScene['style'],reference:string,input:RunInput,signal:AbortSignal,model:Model,log:Log,instruction?:string,previous?:Primitive[]) {
  const crop=await cropBlueprint(reference,{id:node.id,name:node.title,brief:node.title,crop:node,width:node.width,height:node.height});
  let failure:unknown;
  for(let attempt=0;attempt<2;attempt++) {
    const raw=await boundModel(input.config.connections?.worker, model)(input.config.worker,nodePrompt,{node,style,source:input.materials,instruction,previousElements:previous,
      imageOrder:['full blueprint for context','exact node crop; local canvas origin'],validationFeedback:failure?String(failure):undefined},[reference,crop],signal,6000);
    try{
      if(allPrimitives(raw.elements??[]).some(e=>e.type==='symbol'))throw Error('Use actual custom geometry, not stock symbols');
      const elements=containNativeText(normalizeElements(raw.elements,{...node,labels:[]},false),node.width,node.height,style);
      const bounds=renderedBounds(elements,node.width,node.height,style);
      if(bounds && (bounds.x < -4 || bounds.y < -4 || bounds.right>node.width+4 || bounds.bottom>node.height+4))
        throw Error(`Native content exceeds local canvas ${node.width}x${node.height}: ${JSON.stringify(bounds)}. Reconstruct the FULL assigned object at the supplied crop bounds; do not use global coordinates, draw neighboring arrows, or place text outside its node.`);
      return elements;
    }catch(error){failure=error;log(`node:${node.id}`,'warning',String(error));}
  }
  throw Error(`Node reconstruction failed ${node.id}: ${String(failure)}`);
}
async function pool<T>(items:T[],limit:number,task:(item:T)=>Promise<void>) {
  let cursor=0,failure:unknown;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
    while(!failure && cursor<items.length){const item=items[cursor++];try{await task(item);}catch(error){failure??=error;}}
  }));
  if(failure)throw failure;
}
export async function generateVisualReconstruction(input: RunInput, run: RunRecord, signal: AbortSignal, log: Log,
  services: VisualServices = {}) {
  const model=services.model??modelJson,generateImage=services.imageModel??modelImage;
  const directory = outputPath("runs",run.id,"visual");
  if (!services.save && !/^[a-f\d-]{36}$/i.test(run.id)) throw Error("Invalid reconstruction run ID");
  const write = async (name:string,bytes:string|Buffer) => {
    if (!/^[\w.-]+$/.test(name)) throw Error("Unsafe visual artifact name");
    await mkdir(directory,{recursive:true});
    const target=join(directory,name),temp=target+"."+randomUUID()+".tmp";
    await writeFile(temp,bytes);await replaceSnapshot(temp,target);
  };
  const writeJson=services.save??(async(name:string,value:unknown)=>write(name,JSON.stringify(value,null,2)));
  const saveQueues=new Map<string,Promise<void>>();
  const save=(name:string,value:unknown)=>{
    const snapshot=structuredClone(value);
    const operation=(saveQueues.get(name)??Promise.resolve()).then(()=>writeJson(name,snapshot));saveQueues.set(name,operation);return operation;
  };
  const saveImage=services.saveImage??write;
  run.drafts??=structuredClone(input.resumeDrafts??{});
  const checkpoint=run.drafts?.reconstruction as ReconstructionCheckpoint | undefined;
  const sourceFingerprint=createHash('sha256').update(JSON.stringify({materials:input.materials,intent:input.intent,figureType:input.figureType})).digest('hex');
  if(checkpoint?.sourceFingerprint && checkpoint.sourceFingerprint!==sourceFingerprint)
    throw Error("Materials or figure intent changed; a stale reconstruction cannot be resumed");
  if(checkpoint && input.resumeScene && checkpoint.scene?.materials?.some(old=>!input.materials.some(m=>m.name===old.name && m.content===old.content)))
    throw Error("Materials changed; a stale reconstruction cannot be resumed");
  log("grounder","running","提取方法机制、关系与材料边界");
  const semantic=(checkpoint?.semantic??run.drafts.grounder??await boundModel(input.config.connections?.planner, model)(input.config.planner,groundingPrompt,{materials:input.materials,intent:input.intent,figureType:input.figureType},[],signal,5000)) as SemanticPlan;
  validateSemantic(semantic,new Set(input.materials.map(m=>m.name)));
  run.drafts??={};run.drafts.grounder=semantic;await save("semantic-plan.json",semantic);
  let reference=input.visualReference??run.visualReference??run.drafts.selectedBlueprint as string|undefined;
  if(!reference) {
    log("visual-brief","running","规划方法图内容与视觉语言");
    const refs=input.references.length ? await referenceImages(input.references) : await bundledReferenceImages();
    const brief=run.drafts.visualBrief??await boundModel(input.config.connections?.director, model)(input.config.director,visualBriefPrompt,{materials:input.materials,semanticPlan:semantic,intent:input.intent},refs,signal,8000);
    run.drafts.visualBrief=brief;await save("visual-brief.json",brief);
    const candidates: Awaited<ReturnType<typeof rasterBlueprint>>[]=[];
    for(let i=0;i<3;i++) {
      if(signal.aborted)throw Error("Generation cancelled");
      log("image-designer","running",`生成高完成度视觉方案 ${i+1}/3`);
      const cached=run.drafts[`visualCandidate${i}`];
      const proposal=cached ? await rasterBlueprint(String(cached)) : await generateImage(input.config.imageModel??"google/gemini-3-pro-image",brief.prompt,refs,signal,input.config.connections?.image);
      run.drafts[`visualCandidate${i}`]=proposal.dataUrl;candidates.push(proposal);await saveImage(`blueprint-${i}.png`,proposal.bytes);
    }
    const selection=await boundModel(input.config.connections?.critic, model)(input.config.critic,
      'Select the best of three publication figure blueprints for faithful scientific meaning and professional illustrated finish. Sources are the only scientific authority. Return JSON {index:0..2,reason:string}. Compare composition, icon craft, colors, label readability and correct branch directions. Do not favor a simple generic card layout merely because it is easy to vectorize.',
      {materials:input.materials,semanticPlan:semantic},candidates.map(c=>c.dataUrl),signal,3000);
    const index=Number(selection.index);
    if(!Number.isInteger(index)||index<0||index>2)throw Error("Invalid selected visual blueprint");
    reference=candidates[index].dataUrl;run.drafts.blueprintSelection=selection;await save("blueprint-selection.json",selection);
  }
  const target=await rasterBlueprint(reference);reference=target.dataUrl;run.visualReference=reference;
  run.drafts.selectedBlueprint=reference;
  await saveImage("selected-blueprint.png",target.bytes);
  let plan=checkpoint?.plan,planningError:unknown;
  const guide=await blueprintGuide(reference);
  for(let attempt=0;!plan&&attempt<3;attempt++) {
    log("decomposer","running","拆解原图的位置、图层、文字、曲线与复用插画");
    const raw=await boundModel(input.config.connections?.planner, model)(input.config.planner,decompositionPrompt,{width:target.width,height:target.height,semanticPlan:semantic,
      materials:input.materials,intent:input.intent,validationFeedback:planningError ? String(planningError) : undefined},[reference,guide],signal,15000) as ReconstructionPlan;
    await save(`decomposition-draft-${attempt}.json`,raw);
    try {plan=validateReconstructionPlan(raw,semantic,input,target);}catch(error){planningError=error;log("decomposer","warning",String(error));}
  }
  if(!plan)throw planningError;
  const cachedNodes=structuredClone(checkpoint?.nodes??{}),cachedAssets=structuredClone(checkpoint?.assets??{});
  if(!checkpoint?.geometryCalibrated && !input.resumeScene) {
    log('geometry-calibrator','running','独立核对节点边界与插画裁切坐标');
    const correction=await boundModel(input.config.connections?.planner, model)(input.config.planner,geometryPrompt,{coordinateSystem:'box_2d [ymin,xmin,ymax,xmax], all values normalized0..1000',
      nodes:plan.nodes.map(n=>({id:n.id,title:n.title,assets:n.assets.map(a=>({assetId:a.assetId}))})),
      assets:plan.assets.map(a=>({id:a.id,name:a.name,brief:a.brief}))},[reference,await blueprintGuide(reference,true)],signal,5500);
    await save('geometry-calibration.json',correction);
    const corrected=structuredClone(plan);
    for(const patch of correction.nodes??[]) {
      const node=corrected.nodes.find(n=>n.id===patch.id);if(!node)throw Error('Unknown geometry correction node');
      const previous={...node};Object.assign(node,normalizedBox(patch.box_2d,target.width,target.height));
      node.assets=node.assets.map(slot=>{
        const detected=patch.assets?.find((s:any)=>s.assetId===slot.assetId);
        const global=detected?normalizedBox(detected.box_2d,target.width,target.height):{...slot,x:previous.x+slot.x,y:previous.y+slot.y};
        return {...slot,...global,x:global.x-node.x,y:global.y-node.y};
      });
    }
    for(const patch of correction.assets??[]) {
      const asset=corrected.assets.find(a=>a.id===patch.id);if(!asset)throw Error('Unknown geometry correction asset');
      asset.crop=normalizedBox(patch.box_2d,target.width,target.height);asset.width=Math.max(8,Math.round(asset.crop.width));asset.height=Math.max(8,Math.round(asset.crop.height));
    }
    const calibrated=validateReconstructionPlan(corrected,semantic,input,target);
    for(const node of calibrated.nodes) {
      const old=plan.nodes.find(n=>n.id===node.id);
      if(JSON.stringify({x:node.x,y:node.y,width:node.width,height:node.height,assets:node.assets})!==JSON.stringify({x:old?.x,y:old?.y,width:old?.width,height:old?.height,assets:old?.assets}))delete cachedNodes[node.id];
    }
    for(const asset of calibrated.assets) {
      const old=plan.assets.find(a=>a.id===asset.id);
      if(JSON.stringify(asset.crop)!==JSON.stringify(old?.crop)||asset.width!==old?.width||asset.height!==old?.height)delete cachedAssets[asset.id];
    }
    plan=calibrated;
  }
  if(!checkpoint?.assetGeometryCalibrated && !input.resumeScene) {
    const parents=plan.nodes.filter(n=>n.assets.some(s=>Math.max(s.width,s.height)<=40 && n.width*n.height>s.width*s.height*5));
    const representatives=new Set<string>();
    await pool(parents,3,async node=>{
      log(`asset-locator:${node.id}`,'running','放大父模块，核对小插画的完整轮廓');
      const assigned=node.assets.filter(s=>Math.max(s.width,s.height)<=40);
      const crop=await cropBlueprint(reference,{id:node.id,name:node.title,brief:node.title,crop:node,width:node.width,height:node.height});
      const raw=await boundModel(input.config.connections?.planner, model)(input.config.planner,localAssetGeometryPrompt,{nodeId:node.id,illustrations:assigned.map(s=>{
        const asset=plan!.assets.find(a=>a.id===s.assetId)!;return {id:asset.id,name:asset.name,brief:asset.brief};
      })},[crop],signal,2500);
      await save(`asset-geometry-${node.id}.json`,raw);
      if(assigned.some(s=>!raw.assets?.some((p:any)=>p.id===s.assetId)))throw Error('Local illustration detection omitted an assigned asset');
      const touched=applyLocalAssetGeometry(plan!,node.id,raw,representatives);
      for(const id of touched)delete cachedAssets[id];delete cachedNodes[node.id];
    });
    plan=validateReconstructionPlan(plan,semantic,input,target);
  }
  await save("reconstruction-plan.json",plan);
  const state:ReconstructionCheckpoint={version:1,semantic,plan,sourceFingerprint,geometryCalibrated:true,assetGeometryCalibrated:true,assets:cachedAssets,nodes:cachedNodes};
  run.drafts.reconstruction=state;
  const pendingNodes=plan.nodes.filter(n=>!state.nodes![n.id]);
  await pool(pendingNodes,3,async node=>{
      log(`node:${node.id}`,"running",`${node.id} · 重建文字与原生形状`);
      state.nodes![node.id]=await nativeNode(node,plan!.style,reference,input,signal,model,log);
      node.elements=state.nodes![node.id];await save(`node-${node.id}.json`,node.elements);await save("reconstruction-checkpoint.json",state);
      log(`node:${node.id}`,"complete",`${node.id} · 可编辑文字与形状已完成`);
  });
  for(const node of plan.nodes)node.elements=state.nodes![node.id];
  const missing=plan.assets.filter(a=>!state.assets[a.id]);
  await pool(missing,3,async asset=>{state.assets[asset.id]=await illustration(asset,reference,input,signal,model,log);await save(`asset-${asset.id}.json`,state.assets[asset.id]);await save("reconstruction-checkpoint.json",state);});
  let renewedSurface=false;
  if(!checkpoint?.surfacePlanned) {
    log('surface-specialist','running','恢复背景渐变、全局标注与原图箭头走线');
    let failure:unknown;
    for(let attempt=0;attempt<2;attempt++) {
      const raw=await boundModel(input.config.connections?.worker, model)(input.config.worker,surfacePrompt,{width:target.width,height:target.height,semanticPlan:semantic,materials:input.materials,
        nodes:plan.nodes.map(n=>({id:n.id,title:n.title,ownedLabels:allPrimitives(n.elements).filter(e=>e.type==='text').map(e=>e.text)})),validationFeedback:failure?String(failure):undefined},
        [reference,await blueprintGuide(reference,true)],signal,11000);
      await save(`graphic-layers-${attempt}.json`,raw);
      try{plan=validateReconstructionPlan(compileSurface(raw,plan),semantic,input,target);renewedSurface=true;break;}
      catch(error){failure=error;log('surface-specialist','warning',String(error));}
    }
    if(!renewedSurface)throw failure;
    state.plan=plan;state.surfacePlanned=true;await save('reconstruction-plan.json',plan);await save('reconstruction-checkpoint.json',state);
  }else state.surfacePlanned=true;
  if(!checkpoint?.routingPlanned) {
    log('routing-specialist','running','逐条核对箭头方向，恢复圆角折返路径');
    const routing=await boundModel(input.config.connections?.worker, model)(input.config.worker,routingPrompt,{materials:input.materials,
      endpoints:[...plan.nodes.map(n=>({id:n.id,title:n.title,ownedLabels:allPrimitives(n.elements).filter(e=>e.type==='text').map(e=>e.text)})),
        ...plan.annotations.filter(e=>e.type==='path'&&/bracket|group/i.test(e.id)).map(e=>({id:e.id,title:'Grouping bracket'}))]},[reference,await blueprintGuide(reference,true)],signal,7000);
    await save('routing-plan.json',routing);
    plan=validateReconstructionPlan(compileSurface(routing,plan,true),semantic,input,target);state.plan=plan;renewedSurface=true;
    await save('reconstruction-plan.json',plan);
  }
  state.routingPlanned=true;
  for(const node of plan.nodes)state.nodes![node.id]??=node.elements;
  let scene=input.resumeScene && checkpoint?.scene ? structuredClone(input.resumeScene) : compileReconstruction(plan,state.assets,semantic,input);
  if(renewedSurface && input.resumeScene && checkpoint?.scene){const compiled=compileReconstruction(plan,state.assets,semantic,input);scene.annotations=preserveLockedObjects(scene.annotations,compiled.annotations);scene.connectors=compiled.connectors;}
  if(!input.resumeScene||renewedSurface) {
    const outline=await proposeOutlineFit(scene,reference);await save('outline-fit.json',outline.audit);
    const aligned=await guardVisualEdits(scene,reference,{nodeEdits:outline.nodeEdits});scene=aligned.scene;await save('outline-fit-guard.json',aligned.audit);
    const attached=fitPolygonPorts(scene);scene=attached.scene;await save('port-fit.json',attached.audit);
    const routes=await proposeRouteFit(scene,reference);await save('route-fit.json',routes.audit);
    const routed=await guardVisualEdits(scene,reference,{connectorEdits:routes.connectorEdits});scene=routed.scene;await save('route-fit-guard.json',routed.audit);
    log('paint-specialist','running','核对蓝图配色，恢复可编辑的渐变材质');
    const painted=await restoreBlueprintPaint(scene,reference);scene=painted.scene;await save('paint-audit.json',painted.report);
    const markers=await proposeMarkerFit(scene,reference);scene=(await guardVisualEdits(scene,reference,{edits:markers.edits})).scene;await save('marker-fit.json',markers.audit);
    log('typography-tool','running','对照原图校准原生文字的位置和字号');
    const fit=await proposeTypographyFit(scene,reference);await save('typography-fit.json',fit.audit);
    const guarded=await guardVisualEdits(scene,reference,{edits:fit.edits});scene=guarded.scene;await save('typography-fit-guard.json',guarded.audit);
  }
  run.scene=scene;state.scene=scene;await save("reconstruction-checkpoint.json",state);await saveImage("assembled-initial.png",render(scene));
  log("assembler","running","按原图坐标组装矢量元素，检查图层和连接");
  try {
    const assembly=await boundModel(input.config.connections?.assembler, model)(input.config.assembler,compositionPrompt,{scene:reviewScene(scene),materials:input.materials,structuralIssues:reconstructionIssues(scene)},[reference,image(scene)],signal,7000);
    await save("assembly-report.json",assembly);
    const applied=await guardVisualEdits(scene,reference,assembly);await save('assembly-visual-audit.json',applied.audit);
    const guarded=await guardTextEdits(scene,applied.scene,reference,assembly.edits??[]);
    scene=guarded.scene;await save('assembly-text-audit.json',guarded.report);run.scene=scene;
  }catch(error){if(signal.aborted)throw error;log("assembler","warning",`保留已编译的原图布局：${String(error)}`);}
  const rounds=Math.max(1,Math.min(8,input.config.fidelityRounds??4));
  let previousVisualAudit:unknown[]=[];
  for(let round=0;round<rounds;round++) {
    if(signal.aborted)throw Error("Generation cancelled");
    log("fidelity-critic","running",`对照蓝图检查科学内容与视觉细节 ${round+1}/${rounds}`);
    const measured=reconstructionIssues(scene);
    const report=await boundModel(input.config.connections?.critic, model)(input.config.critic,fidelityCriticPrompt,{scene:reviewScene(scene),planAssets:plan.assets,materials:input.materials,semanticPlan:semantic,measuredIssues:measured,
      previousVisualAudit,reviewInstruction:'Recheck actual images. Previous patches rejected by the rendering tool increased changed-pixel error against the blueprint. Do not repeat those unverified assumptions; use a different, genuinely supported correction or conclude that the existing placement is faithful.'},[reference,image(scene)],signal,9000);
    await save(`fidelity-report-${round}.json`,report);
    const issues=[...measured,...(Array.isArray(report.issues)?report.issues:[])];
    const approved=report.approved===true&&!issues.some(i=>i.severity!=="low");
    scene.review={status:approved?"reviewed":"needs-revision",summary:String(report.summary??"Visual comparison incomplete"),issues};
    scene.reconstruction!.iterations=round+1;scene.reconstruction!.fidelityPassed=approved;
    run.scene=scene;state.scene=scene;await save("reconstruction-checkpoint.json",state);await saveImage(`assembled-${round}.png`,render(scene));
    log("fidelity-critic",approved?"complete":"warning",scene.review.summary);
    if(approved||round===rounds-1)break;
    const patchReport=structuredClone(report),nodeRepairs=[...(report.nodeRepairs??[])];
    // Missing wording requires source-grounded local reconstruction, not unrestricted text rewriting.
    for(const edit of patchReport.edits??[])if(edit.patch?.text!==undefined) {
      const owner=scene.modules.find(m=>allPrimitives(m.elements).some(e=>e.id===edit.id));
      if(owner && !nodeRepairs.some(r=>r.nodeId===owner.id))nodeRepairs.push({nodeId:owner.id,instruction:`The visual critic detected missing/incorrect label wording. Recheck the full blueprint and sources and restore this object's exact source-supported wording: ${String(edit.patch.text)}`});
      delete edit.patch.text;
    }
    try {
      const applied=await guardVisualEdits(scene,reference,patchReport);await save(`visual-edit-audit-${round}.json`,applied.audit);
      previousVisualAudit=applied.audit;
      const rejectedPatches=applied.audit.filter(e=>!e.accepted);
      if(rejectedPatches.length)log('fidelity-critic','warning',`拒绝 ${rejectedPatches.length} 个未改善实际渲染的修订，其余修订已独立应用`);
      const guarded=await guardTextEdits(scene,applied.scene,reference,patchReport.edits??[]);
      scene=guarded.scene;await save(`text-edit-audit-${round}.json`,guarded.report);
      const rejected=guarded.report.filter(r=>!r.accepted);if(rejected.length)log('fidelity-critic','warning',`保留 ${rejected.length} 个与蓝图匹配更好的文字位置`);
    }catch(error){log("fidelity-critic","warning",`拒绝无效对象修订：${String(error)}`);}
    for(const repair of nodeRepairs.slice(0,6)) {
      const node=plan.nodes.find(n=>n.id===repair.nodeId),existing=scene.modules.find(m=>m.id===repair.nodeId);
      if(!node||!existing||existing.locked)continue;
      // Crop at the corrected CURRENT object bounds; keep specialist asset slots.
      const task={...node,x:existing.x,y:existing.y,width:existing.width,height:existing.height};
      log(`node:${node.id}`,'running',`${node.id} · 对照原图定点修订`);
      const elements=await nativeNode(task,scene.style,reference,input,signal,model,log,repair.instruction,node.elements);
      node.elements=elements;state.nodes![node.id]=elements;
      const rebuilt=compileReconstruction({...plan,nodes:plan.nodes.map(n=>n.id===node.id?{...task,elements}:n)},state.assets,semantic,input).modules.find(m=>m.id===node.id)!;
      scene.modules=scene.modules.map(m=>m.id===node.id?{...rebuilt,elements:preserveLockedObjects(m.elements,rebuilt.elements)}:m);
      await save(`node-${node.id}-revision-${round}.json`,elements);
    }
    for(const repair of (report.assetRepairs??[]).slice(0,3)) {
      const asset=plan.assets.find(a=>a.id===repair.assetId);
      if(!asset)continue;
      const rebuilt=await illustration(asset,reference,input,signal,model,log,state.assets[asset.id],repair.instruction);
      state.assets[asset.id]=rebuilt;scene=replaceAsset(scene,plan,asset.id,rebuilt);await save(`asset-${asset.id}-revision-${round}.json`,rebuilt);
    }
    run.scene=scene;state.scene=scene;
  }
  scene.history=[...(input.resumeScene?.history??[]),...run.events];run.scene=scene;state.scene=scene;
  scene.reconstruction!.referenceId=run.id;
  await save("reconstruction-checkpoint.json",state);await saveImage("final-vector.png",render(scene));
  log("export",scene.reconstruction!.fidelityPassed?"complete":"warning",scene.reconstruction!.fidelityPassed ? "视觉对照通过；保留全部原生矢量对象" : "矢量图已保存，视觉对照仍需修订；未标为完成质量验收");
}
