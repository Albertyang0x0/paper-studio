import test from 'node:test';
import assert from 'node:assert/strict';
import { Resvg } from '@resvg/resvg-js';
import type { Primitive, RunInput, SemanticPlan } from '../../shared/types';
import type { ReconstructionPlan } from '../../shared/visual-contract';
import { allPrimitives, connectorGeometry, connectionPort, sceneSvg } from '../../shared/svg';
import { validateReconstructionPlan, compileReconstruction, applyReconstructionEdits, normalizedBox, containNativeText } from '../../server/visual/compiler';
import { compileSurface } from '../../server/visual/surface';
import { generateVisualReconstruction } from '../../server/visual/reconstruction';
import { rasterBlueprint, cropBlueprint } from '../../server/visual/image-model';
import { assetPrompt, nodePrompt, visualBriefPrompt, decompositionPrompt, compositionPrompt, fidelityCriticPrompt, geometryPrompt, surfacePrompt } from '../../server/visual/prompts';
import { loadImage } from '@napi-rs/canvas';
import { restoreBlueprintPaint } from '../../server/visual/paint';
import { guardTextEdits } from '../../server/visual/text-guard';
import { applyReviewEdits } from '../../server/visual/review-edits';
import { applyLocalAssetGeometry, localAssetGeometryPrompt } from '../../server/visual/local-geometry';
import { guardVisualEdits } from '../../server/visual/visual-guard';
import { proposeTypographyFit } from '../../server/visual/typography-fit';
import { routingPrompt } from '../../server/visual/routing';
import { proposeOutlineFit } from '../../server/visual/outline-fit';
import { proposeRouteFit } from '../../server/visual/route-fit';
import { fitPolygonPorts } from '../../server/visual/port-fit';
import { typographyObstacles, iconOverlapPenalty, nativeGlyphOverflow } from '../../server/visual/type-obstacles';
import { proposeMarkerFit } from '../../server/visual/marker-fit';

const input:RunInput={materials:[{id:'m',name:'idea.md',content:'Input passes to the output.'}],references:[],intent:'Method overview',figureType:'method-overview',
  config:{pipeline:'visual-reconstruction',planner:'mock',director:'mock',worker:'mock',assembler:'mock',critic:'mock',reviewRounds:1,fidelityRounds:2,
    imageModel:'mock/image',methods:{illustration:'vector-agent',structure:'vector-agent',plot:'vector-agent'}}};
const semantic:SemanticPlan={title:'Method',message:'Input to output',components:[{id:'in',label:'Input',meaning:'Input',sourceRefs:['idea.md']},{id:'out',label:'Output',meaning:'Output',sourceRefs:['idea.md']}],
  relationships:[{from:'in',to:'out',meaning:'transformation'}],constraints:[]};
const gradient:Primitive['gradient']={type:'linear',x1:0,y1:0,x2:0,y2:1,stops:[{offset:0,color:'#f8fcff'},{offset:1,color:'#cce6f4'}]};
const plan:ReconstructionPlan={title:'Method',width:400,height:200,rationale:'Preserve exact blueprint geometry',
  style:{font:'Arial',ink:'#222222',muted:'#666666',accent:'#2266aa',palette:['#ddeeff'],lineWidth:1.5,bodySize:18,titleSize:22,illustrationStyle:'bespoke'},
  backgrounds:[{id:'wash',type:'rect',x:0,y:0,width:400,height:200,fill:'#eef4fa',gradient}],annotations:[],
  nodes:[{id:'a',title:'Input',x:20,y:30,width:110,height:120,elements:[{id:'label',type:'text',x:55,y:85,align:'center',text:'Input',fontSize:16}],componentIds:['in'],sourceRefs:['idea.md'],
    ports:[{id:'out',side:'right',offset:.5}],assets:[{assetId:'icon',x:35,y:15,width:40,height:40}]},
    {id:'b',title:'Output',x:260,y:30,width:110,height:120,elements:[{id:'label',type:'text',x:55,y:85,align:'center',text:'Output',fontSize:16}],componentIds:['out'],sourceRefs:['idea.md'],
      ports:[{id:'in',side:'left',offset:.5}],assets:[{assetId:'icon',x:35,y:15,width:40,height:40}]}],
  connectors:[{id:'flow',from:'a',to:'b',fromPort:'out',toPort:'in',color:'#555555',strokeWidth:2,curve:[{c1:{x:165,y:10},c2:{x:220,y:10},end:{x:260,y:90}}]}],
  assets:[{id:'icon',name:'Bespoke icon',brief:'Layered icon',crop:{x:55,y:45,width:40,height:40},width:40,height:40}]};
const asset:Primitive[]=Array.from({length:12},(_,i)=>({id:'part'+i,type:'ellipse',x:3+i,y:3+i,width:10,height:10,fill:'#2266aa'}));
const makeScene=()=>compileReconstruction(validateReconstructionPlan(plan,semantic,input,{width:400,height:200}),{icon:asset},semantic,input);

test('Gemini normalized detections convert both axes and extents to native pixels',()=>{
  assert.deepEqual(normalizedBox([250,100,750,600],1600,800),{x:160,y:200,width:800,height:400});
  assert.throws(()=>normalizedBox([0,0,1200,500],1600,800),/Invalid normalized/);
});
test('local glyph containment fixes an anchor-width ambiguity without changing words or font size',()=>{
  const corrected=containNativeText([{id:'label',type:'text',x:40,y:63,width:80,align:'center',fontSize:20,text:'Input\nQuestion'}],80,90,plan.style)[0];
  assert.equal(corrected.x,0);assert.ok(corrected.y<63);assert.equal(corrected.fontSize,20);assert.equal(corrected.text,'Input\nQuestion');
});
const surface={backgrounds:[{id:'wash',box_2d:[0,0,1000,1000],fill:'#eef4fa',gradient}],annotations:[],
  connectors:[{id:'flow',from:'a',to:'b',start:[450,325],end:[450,650],color:'#555555',strokeWidthPx:2,
    segments:[{c1:[50,412.5],c2:[50,550],end:[450,650]}]}]};
test('graphic-layer compiler restores original washes and normalized smooth connection controls',()=>{
  const compiled=validateReconstructionPlan(compileSurface(surface,plan),semantic,input,{width:400,height:200});
  assert.deepEqual(compiled.connectors[0].curve![0].c1,{x:165,y:10});
  assert.equal(compiled.backgrounds[0].gradient!.stops[1].color,'#cce6f4');
  assert.throws(()=>compileSurface({...surface,connectors:[{...surface.connectors[0],from:'missing'}]},plan),/Unknown surface/);
});
test('a detected grouping bracket becomes an editable connector anchor, not a guessed nearby card',()=>{
  const compiled=compileSurface({...surface,decorations:[{id:'bracket',shape:'curve',start:[100,550],segments:[{c1:[300,600],c2:[500,600],end:[700,550]}],fill:'none',stroke:'#555555',strokeWidthPx:2}],
    connectors:[{...surface.connectors[0],from:'bracket',start:[450,600]}]},plan);
  assert.ok(compiled.nodes.some(n=>n.id==='bracket'&&n.elements[0].type==='path'));
  assert.ok(!compiled.annotations.some(e=>e.id==='bracket'));
  assert.equal(compiled.connectors[0].from,'bracket');
});
test('local illustration geometry keeps complete tall silhouettes and exact global crops',()=>{
  const detected=structuredClone(plan);
  applyLocalAssetGeometry(detected,'a',{assets:[{id:'icon',box_2d:[100,300,500,600]}]},new Set());
  assert.equal(detected.nodes[0].assets[0].height,48);
  assert.equal(detected.assets[0].crop.y,42);
  assert.equal(detected.assets[0].height,48);
});

test('native gradients and bespoke groups survive SVG export without raster flattening',()=>{
  const scene=makeScene(),svg=sceneSvg(scene);
  assert.ok(svg.includes('<linearGradient'));assert.ok(svg.includes('<text'));assert.ok(!svg.includes('<image'));
  assert.ok(svg.indexOf('data-object-id="background__wash"')<svg.indexOf('data-connector-id="flow"'));
  const ids=allPrimitives([...scene.annotations,...scene.modules.flatMap(m=>m.elements)]).map(e=>e.id);
  assert.equal(new Set(ids).size,ids.length);
  assert.ok(ids.includes('a__icon_0__part0')&&ids.includes('b__icon_0__part0'));
  const png=new Resvg(svg,{font:{loadSystemFonts:true}}).render().asPng();assert.ok(png.length>1000);
});
test('reconstruction preserves smooth Bézier controls and follows edited node geometry',()=>{
  const scene=makeScene(),edge=scene.connectors[0],before=connectorGeometry(edge,scene)!;
  assert.ok(before.path.includes('C165 10 220 10 260 90'));
  scene.modules[1].x+=10;
  const after=connectorGeometry(edge,scene)!;
  assert.equal(after.points.at(-1)!.x,270);assert.ok(!after.path.includes('L'));
  assert.equal(after.points[1].x,165+10/3);
});
test('true normalized anchors preserve non-rectangular connection points during node moves',()=>{
  const scene=makeScene();scene.modules[0].ports[0].anchor={x:.8,y:.75};
  const first=connectionPort(scene.modules[0],'out',scene.modules[1]);
  assert.equal(first.x,108);assert.equal(first.y,120);
  scene.modules[0].x+=30;assert.equal(connectionPort(scene.modules[0],'out',scene.modules[1]).x,138);
});
test('decision side ports meet the actual polygon edge rather than its bounding rectangle',()=>{
  const source=makeScene(),node=source.modules[0];node.elements=[{id:'diamond',type:'polygon',x:0,y:0,fill:'#ddeeff',points:[{x:55,y:0},{x:110,y:60},{x:55,y:120},{x:0,y:60}]}];
  node.ports[0].offset=.25;node.ports[0].anchor={x:1,y:.25};
  const attached=fitPolygonPorts(source);assert.equal(attached.audit.length,1);
  assert.equal(attached.scene.modules[0].ports[0].anchor!.x,.75);
  assert.equal(connectionPort(attached.scene.modules[0],'out',attached.scene.modules[1]).x,102.5);
  assert.equal(source.modules[0].ports[0].anchor!.x,1);
});
test('native icon obstacles detect real path ink but ignore the enclosing card',()=>{
  const source=makeScene(),node=source.modules[0];node.elements=[{id:'card',type:'rect',x:0,y:0,width:110,height:120,fill:'#ffffff'},
    {id:'pictogram',type:'path',x:0,y:0,path:'M10 10 L25 10 L25 30 L10 30 Z',fill:'#667788'},
    {id:'label',type:'text',x:18,y:12,fontSize:18,text:'Input'}];
  const obstacles=typographyObstacles(node,source.style);assert.equal(obstacles.length,1);
  assert.ok(iconOverlapPenalty([node.elements[2]],source.style,obstacles)>0);
  assert.equal(iconOverlapPenalty([{...node.elements[2],x:35}],source.style,obstacles),0);
});
test('typography safety checks real SVG glyph bounds rather than only Canvas font metrics',()=>{
  const source=makeScene(),node=source.modules[0];node.contentWidth=104;node.elements=[{id:'label',type:'text',x:52,y:50,fontSize:24,fontFamily:'Arial',fontWeight:700,align:'center',text:'Intervention /'}];
  assert.ok(nativeGlyphOverflow(node,source.style)>30);
  node.elements[0].fontSize=14;assert.equal(nativeGlyphOverflow(node,source.style),0);
});
test('small native marker calibration recovers a source circle rather than retaining a pill',async()=>{
  const source=makeScene();source.annotations=[{id:'pause',type:'rect',x:180,y:50,width:22,height:22,radius:11,fill:'#cc0000'}];
  const reference=await rasterBlueprint(new Resvg(sceneSvg(source,false)).render().asPng());
  const wrong=structuredClone(source);wrong.annotations[0].height=14;wrong.annotations[0].radius=7;
  const fitted=await proposeMarkerFit(wrong,reference.dataUrl);assert.equal(fitted.edits.length,1);
  assert.equal(fitted.edits[0].patch.width,fitted.edits[0].patch.height);
  assert.ok(fitted.edits[0].patch.height>=20);
});
test('stroke-aware routing recovers native curve pieces without embedding its source image',async()=>{
  const source=makeScene();source.width=900;source.height=400;source.annotations=[];
  source.modules[0].x=30;source.modules[0].y=180;source.modules[1].x=740;source.modules[1].y=180;
  source.connectors[0].curveAnchors=undefined;source.connectors[0].curve=[{c1:{x:260,y:140},c2:{x:630,y:140},end:{x:740,y:240}}];
  const ref=await rasterBlueprint(new Resvg(sceneSvg(source,false),{font:{loadSystemFonts:true}}).render().asPng());
  const wrong=structuredClone(source);wrong.connectors[0].curve![0].c1.y=180;wrong.connectors[0].curve![0].c2.y=180;
  const fit=await proposeRouteFit(wrong,ref.dataUrl);
  assert.equal(fit.connectorEdits.length,1);assert.ok(fit.audit[0].matchedStrokeFraction>.7);
  const recovered=applyReconstructionEdits(wrong,fit);assert.ok(connectorGeometry(recovered.connectors[0],recovered)!.pieces!.length>1);
  assert.ok(!sceneSvg(recovered).includes('<image'));
});
test('planner crop validation rejects placeholder crops and preserves global artwork on crop expansion',()=>{
  const invalid=structuredClone(plan);invalid.assets[0].crop={x:0,y:0,width:40,height:40};
  assert.throws(()=>validateReconstructionPlan(invalid,semantic,input,{width:400,height:200}),/GLOBAL/);
  const expanded=structuredClone(plan);expanded.nodes[0].assets[0].y=-10;expanded.assets[0].crop.y=20;
  const valid=validateReconstructionPlan(expanded,semantic,input,{width:400,height:200});
  assert.equal(valid.nodes[0].y,20);assert.equal(valid.nodes[0].assets[0].y,0);assert.equal(valid.nodes[0].elements[0].y,95);
  assert.equal(valid.nodes[0].y+valid.nodes[0].ports[0].offset*valid.nodes[0].height,90);
});
test('review patches cannot rewrite scientific text, identities, or locked descendants',()=>{
  const scene=makeScene();
  assert.throws(()=>applyReconstructionEdits(scene,{edits:[{id:'a__label',patch:{text:'Fabricated'}}]}),/cannot change text/);
  assert.throws(()=>applyReconstructionEdits(scene,{connectorEdits:[{id:'missing'}]}),/Unknown edge/);
  scene.modules[0].elements[1].locked=true;
  const edited=applyReconstructionEdits(scene,{edits:[{id:'a__icon_0__part0',patch:{fill:'#ff0000'}}],nodeEdits:[{id:'a',x:22}]});
  assert.equal(allPrimitives(edited.modules[0].elements).find(e=>e.id==='a__icon_0__part0')!.fill,'#2266aa');
  assert.equal(edited.modules[0].x,20);
});
test('one invalid critic object does not discard valid independent geometry edits',()=>{
  const source=makeScene();
  const reviewed=applyReviewEdits(source,{edits:[{id:'missing',patch:{y:3}},{id:'a__label',patch:{fill:'#990000'}}]});
  assert.equal(reviewed.rejected.length,1);
  assert.equal(allPrimitives(reviewed.scene.modules[0].elements).find(e=>e.id==='a__label')!.fill,'#990000');
  assert.equal(source.modules[0].elements[0].fill,undefined);
});
test('asset crops preserve aspect ratio during supersampling',async()=>{
  const ref=await rasterBlueprint(new Resvg(sceneSvg(makeScene())).render().asPng());
  const cropped=await cropBlueprint(ref.dataUrl,{...plan.assets[0],width:80,height:20});
  const picture=await loadImage(Buffer.from(cropped.split(',')[1],'base64'));
  assert.equal(picture.width/picture.height,4);
});
test('blueprint palette recovery restores native gradients without sampling foreground text',async()=>{
  const source=makeScene();
  source.annotations[0].gradient={type:'linear',x1:0,y1:0,x2:1,y2:0,stops:[{offset:0,color:'#f6f2e6'},{offset:1,color:'#e5dac5'}]};
  const reference=await rasterBlueprint(new Resvg(sceneSvg(source)).render().asPng());
  const flattened=structuredClone(source);delete flattened.annotations[0].gradient;flattened.annotations[0].fill='#f0e8d8';
  const recovered=await restoreBlueprintPaint(flattened,reference.dataUrl);
  assert.equal(recovered.scene.annotations[0].gradient!.x2,1);
  assert.equal(recovered.scene.annotations[0].gradient!.stops.length,3);
  assert.ok(recovered.report.length>0);assert.ok(!sceneSvg(recovered.scene).includes('<image'));
  assert.equal(recovered.scene.modules[0].elements[0].text,'Input');
});
test('text critic cannot move a correct native label away from its reference',async()=>{
  const source=makeScene();
  const reference=await rasterBlueprint(new Resvg(sceneSvg(source,false),{font:{loadSystemFonts:true,defaultFontFamily:source.style.font}}).render().asPng());
  const edited=applyReconstructionEdits(source,{edits:[{id:'a__label',patch:{y:105}}]});
  const guarded=await guardTextEdits(source,edited,reference.dataUrl,[{id:'a__label',patch:{y:105}}]);
  assert.equal(guarded.report[0].accepted,false);
  assert.equal(allPrimitives(guarded.scene.modules[0].elements).find(e=>e.id==='a__label')!.y,85);
  const same=await guardTextEdits(source,source,reference.dataUrl,[{id:'a__label',patch:{y:85}}]);
  assert.equal(same.report[0].accepted,true);
});
test('native typography fitting recovers readable source size without OCR or outlines',async()=>{
  const source=makeScene();source.modules[0].elements[0].fontSize=24;
  const ref=await rasterBlueprint(new Resvg(sceneSvg(source,false),{font:{loadSystemFonts:true}}).render().asPng());
  const small=structuredClone(source);small.modules[0].elements[0].fontSize=17;
  const fitted=await proposeTypographyFit(small,ref.dataUrl);
  assert.ok(fitted.edits.some(e=>e.id==='a__label'&&e.patch.fontSize>20));
  assert.equal(small.modules[0].elements[0].text,'Input');
});
test('rendered visual guard refuses destructive node scaling and preserves valid changes',async()=>{
  const scene=makeScene(),ref=await rasterBlueprint(new Resvg(sceneSvg(scene,false),{font:{loadSystemFonts:true,defaultFontFamily:scene.style.font}}).render().asPng());
  const proposed=await guardVisualEdits(scene,ref.dataUrl,{nodeEdits:[{id:'a',x:100,width:160}],edits:[{id:'a__label',patch:{fill:'#222222'}}]});
  assert.equal(proposed.scene.modules[0].x,20);assert.equal(proposed.scene.modules[0].width,110);
  assert.equal(proposed.audit.find(e=>e.field==='nodeEdits').accepted,false);
});
test('real orchestration selects a blueprint, splits native nodes/assets, assembles and compares images',async()=>{
  const ref=await rasterBlueprint(new Resvg(sceneSvg(makeScene())).render().asPng());
  const calls:string[]=[],artifacts=new Map<string,unknown>();let criticCalls=0,imagesGenerated=0;
  const run:any={id:'test',status:'running',events:[]};
  await generateVisualReconstruction(input,run,new AbortController().signal,()=>{}, {
    save:async(name,data)=>{artifacts.set(name,structuredClone(data));},saveImage:async()=>{},
    imageModel:async()=>{imagesGenerated++;return ref;},
    model:async(_model,system,data:any,images=[])=>{
      if(system===visualBriefPrompt){calls.push('brief');return {title:'Method',caption:'Grounded caption',prompt:'Six-section description'};}
      if(system===decompositionPrompt){calls.push('decompose');assert.equal(images.length,2);return structuredClone(plan);}
      if(system===geometryPrompt){calls.push('calibrate');assert.equal(images.length,2);return {nodes:[],assets:[]};}
      if(system===localAssetGeometryPrompt){return {assets:data.illustrations.map((a:any)=>({id:a.id,box_2d:[125,318.181818,458.333333,681.818181]}))};}
      if(system===surfacePrompt){calls.push('surface');assert.equal(images.length,2);return structuredClone(surface);}
      if(system===routingPrompt){calls.push('routing');return {connectors:structuredClone(surface.connectors)};}
      if(system===nodePrompt){calls.push('node');assert.equal(images.length,2);return {elements:data.node.elements};}
      if(system===assetPrompt){calls.push('asset');assert.equal(images.length,1);return {elements:asset};}
      if(system===compositionPrompt){calls.push('assemble');assert.equal(images.length,2);return {edits:[]};}
      if(system===fidelityCriticPrompt){calls.push('compare');assert.equal(images.length,2);criticCalls++;return {approved:criticCalls>1,summary:criticCalls>1?'Visually faithful':'Need contrast',issues:criticCalls>1?[]:[{severity:'medium',message:'Need contrast'}],edits:[{id:'a__label',patch:{fill:'#222222'}}]};}
      if(system.startsWith('Select the best')){calls.push('select');assert.equal(images.length,3);return {index:1,reason:'Best design'};}
      calls.push('ground');return structuredClone(semantic);
    },
  });
  assert.equal(imagesGenerated,3);assert.equal(calls.filter(c=>c==='asset').length,1);assert.equal(calls.filter(c=>c==='node').length,2);
  assert.equal(run.scene.reconstruction.fidelityPassed,true);assert.equal(run.scene.reconstruction.iterations,2);
  assert.ok(artifacts.has('reconstruction-checkpoint.json'));assert.ok(run.drafts.selectedBlueprint);
  assert.ok(!sceneSvg(run.scene).includes('<image'));
  const resumed:any={id:'resume',status:'running',events:[]};
  await assert.rejects(generateVisualReconstruction({...input,intent:'Different intent',resumeDrafts:run.drafts},resumed,new AbortController().signal,()=>{},
    {save:async()=>{},saveImage:async()=>{}}),/stale reconstruction/);
});
