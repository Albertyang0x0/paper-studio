import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPaper} from '../../shared/paper-project';
import {extractEvidenceTables,evidenceChart} from '../../server/paper/figures';
import {recoverAbstract,openAlexSearch,deduplicateCitations,reviewManuscript,reviseReviewedSection} from '../../server/paper/research';
import {markdownToTex,paperTex,bibliographyTex} from '../../server/paper/export';
import {sceneSvg,allPrimitives} from '../../shared/svg';
import type {Citation,ModuleInput} from '../../shared/paper-types';
import {executePaperModule} from '../../server/paper/adapters';
import {validateDesign} from '../../server/validation';
import {fitModuleText} from '../../server/text-layout';
import {textBoxes} from '../../server/typography';
import {canvasFont} from '../../server/font-metrics';
import {refineSceneDocument} from '../../server/scene-refinement';

const material={name:'experiment.md',content:'## Accuracy\n\n|Dataset|Model|Baseline|Ours|\n|---|---|---:|---:|\n|D1|Small|85.5|86.0|\n|D1|Large|95.5|95.2|\n|D2|Small|72.0|77.0|'};
test('charts are bound to source cells, preserve negative outcomes and stay native vectors',()=>{
  const [table]=extractEvidenceTables([material]);
  assert.equal(table.rows.length,3);
  const scene=evidenceChart(table,{tableId:table.id,title:'Accuracy',key:'accuracy',caption:'Mixed outcomes',categoryColumn:1,groupColumn:0,valueColumns:[2,3]});
  assert.match(scene.materials![0].content,/95.5/);assert.match(scene.materials![0].content,/95.2/);
  assert.ok(scene.modules.every(m=>m.elements.filter(e=>e.type==='text').every(e=>!['120'].includes(e.text??''))));
  assert.match(sceneSvg(scene),/data-object-id/);assert.doesNotMatch(sceneSvg(scene),/<image/);
  assert.throws(()=>evidenceChart(table,{tableId:table.id,title:'x',key:'x',caption:'',categoryColumn:0,valueColumns:[1]}),/numeric/);
});
test('rate denominators remain separate panels instead of misleading combined axes',()=>{
  const [table]=extractEvidenceTables([{name:'ablation.md',content:'|Variant|Gain|Rescue|Harm|\n|---|---:|---:|---:|\n|Default|3.5|32.1|1.1|\n|Strict|2.0|21.7|1.2|'}]);
  const scene=evidenceChart(table,{tableId:table.id,title:'Ablation',key:'ablation',caption:'',categoryColumn:0,valueColumns:[1,2,3]});
  assert.equal(scene.modules.length,3);assert.equal(scene.modules[0].title,'Gain');
  assert.match(scene.annotations[0].text!,/1  Default/);
  assert.match(scene.annotations[1].text!,/2  Strict/);
});
test('non-percentage comparisons are not relabelled or clipped as accuracy',()=>{
  const [table]=extractEvidenceTables([{name:'throughput.md',content:'|Model|Baseline|New|\n|---|---:|---:|\n|Small|180|220|\n|Large|140|190|'}]);
  const scene=evidenceChart(table,{tableId:table.id,title:'Throughput',key:'throughput',caption:'',categoryColumn:0,valueColumns:[1,2],commonAxisLabel:'Tokens / second'});
  const labels=scene.modules.flatMap(m=>m.elements).filter(e=>e.type==='text').map(e=>e.text);
  assert.ok(labels.includes('Tokens / second'));assert.ok(!labels.includes('Accuracy (%)'));
  assert.ok(labels.includes('260'));
});
test('OpenAlex abstract recovery uses positions and metadata never creates missing authors',async()=>{
  assert.equal(recoverAbstract({world:[1],Hello:[0]}),'Hello world');
  const request=async()=>new Response(JSON.stringify({results:[{id:'https://openalex.org/W1',title:'Verified title',authorships:[{author:{display_name:'A'}}],publication_year:2024,abstract_inverted_index:{Real:[0],abstract:[1]},primary_location:{landing_page_url:'https://arxiv.org/abs/2401.00001'}}]}));
  const [c]=await openAlexSearch('query',undefined,request as typeof fetch);
  assert.equal(c.provider,'OpenAlex');assert.equal(c.abstract,'Real abstract');assert.equal(c.verification,'metadata-verified');
  assert.equal(deduplicateCitations([c,{...c,id:'other',title:'Verified: title'}]).length,1);
});
test('figure references resolve to labels, fit-width tables and headings render without 3.0.1 numbering',()=>{
  const p=createPaper(randomUUID(),'Paper','Idea');
  p.modules.method.content='### Mechanism\n\nSee [fig:overview].';
  const a={id:randomUUID(),figureId:randomUUID(),version:1,title:'Overview',key:'overview',caption:'Actual caption',placement:'method' as const,scene:evidenceChart(extractEvidenceTables([material])[0],{tableId:'table_0',title:'x',key:'x',caption:'',categoryColumn:1,groupColumn:0,valueColumns:[2,3]}),createdAt:new Date().toISOString()};
  p.assets.push(a);p.modules.figures.assetIds.push(a.id);
  const tex=paperTex(p);
  assert.match(tex,/Figure~\\ref\{fig:overview\}/);assert.match(tex,/\\label\{fig:overview\}/);assert.match(tex,/\\subsection\{Mechanism\}/);
  assert.equal((tex.match(/includegraphics/g)??[]).length,1);
  assert.match(markdownToTex(material.content),/\\dimexpr/);
});
test('figures are defined after their first scientific reference, not before the containing section text',()=>{
  const source=markdownToTex('Setup first.\n\n### Results\n\nSee [fig:accuracy].\n\nInterpretation.',[{key:'accuracy',tex:'\\begin{figure}ACTUAL FIGURE\\end{figure}\n'}]);
  assert.ok(source.indexOf('Setup first.')<source.indexOf('ACTUAL FIGURE'));
  assert.ok(source.indexOf('Figure~\\ref{fig:accuracy}')<source.indexOf('ACTUAL FIGURE'));
  assert.ok(source.indexOf('ACTUAL FIGURE')<source.indexOf('Interpretation.'));
});
test('explicit Markdown table captions become native numbered LaTeX table captions',()=>{
  const tex=markdownToTex('Table 1. Source-reported accuracy (%).\n\n| Model | Score |\n|---|---:|\n| Small | 85 |');
  assert.match(tex,/\\refstepcounter\{table\}/);assert.match(tex,/Table~\\thetable/);
  assert.match(tex,/Source-reported accuracy/);assert.equal((tex.match(/Source-reported accuracy/g)??[]).length,1);
});
test('paper bibliography follows cited records while retaining the full editable project library',()=>{
  const p=createPaper(randomUUID(),'Paper','Idea');
  const citation={id:'x',key:'Used',title:'Actual cited work',authors:Array.from({length:12},(_,i)=>'Author '+i),year:2025,venue:'Conference',abstract:'',url:'https://example.org',provider:'Manual',verification:'user-provided' as const};
  p.citations=[{...citation,id:'other',key:'Unused',title:'Library-only work'},citation];p.modules.method.content='Supported [@Used].';
  const tex=bibliographyTex(p);assert.match(tex,/Actual cited work/);assert.match(tex,/et al/);assert.doesNotMatch(tex,/Library-only/);
  assert.equal(p.citations.length,2);assert.equal(p.citations[1].authors.length,12);
});
test('whole manuscript review and revision are independent and preserve canonical modules',async()=>{
  const p=createPaper(randomUUID(),'Paper','Idea');p.modules.method.content='Unsupported loss';
  const review=await reviewManuscript(p,'test',()=>{},undefined,async()=>({summary:'Fix factual error',issues:[{moduleId:'method',severity:'high',message:'Loss was not supplied'}]}));
  const input:ModuleInput={contract:'paper-module/1',project:p,moduleId:'method',methodId:'orchestra-section',model:'test',instruction:''};
  const result=await reviseReviewedSection(input,review,()=>{},async()=>({content:'Monitor trained from sampled continuations.',warnings:[]}));
  assert.match(result.content,/sampled/);assert.equal(p.modules.method.content,'Unsupported loss');
  await assert.rejects(reviseReviewedSection(input,review,()=>{},async()=>({content:'Invented [@fake]',warnings:[]})),/未登记/);
});
test('unknown figure links are actionable even when a language-model reviewer calls them low priority',async()=>{
  const p=createPaper(randomUUID(),'Paper','Idea');p.modules.method.content='See [fig:unregistered].';
  const review=await reviewManuscript(p,'mock',()=>{},undefined,async()=>({summary:'Looks fine',issues:[]}));
  assert.equal(review.issues[0].severity,'high');assert.match(review.issues[0].message,/Unregistered figure/);
});
test('grounded writing repairs fabricated settings before making a candidate and rejects invented evidence excerpts',async()=>{
  const p=createPaper(randomUUID(),'Paper','The monitor reads hidden states. Only the monitor is trained.');
  let calls=0;
  const output=await executePaperModule({contract:'paper-module/1',project:p,moduleId:'method',methodId:'grounded-section',model:'mock',instruction:''},()=>{},async(_m,_s,data:any)=>{
    calls++;
    if(calls===1)return {supported:[{fact:'Monitor reads hidden states',source:'idea',quote:'The monitor reads hidden states.'},{fact:'Use binary loss',source:'idea',quote:'We use binary cross-entropy.'}],unspecified:['loss'],structure:['monitor']};
    if(calls===2){assert.equal(data.evidence_ledger.supported.length,1);return {content:'The monitor uses binary cross-entropy.',warnings:[]};}
    if(calls===3)return {issues:['Training loss is not supplied. Remove this invented setting.']};
    if(calls===4)return {content:'The monitor reads hidden states. Its training loss is unspecified.',warnings:[]};
    return {issues:[]};
  });
  assert.equal(calls,5);assert.doesNotMatch(output.content,/cross-entropy/);assert.equal(p.modules.method.content,'');
});
test('global scientific constraints can be grounded annotations without fake extra mechanism modules',()=>{
  const scene=evidenceChart(extractEvidenceTables([material])[0],{tableId:'table_0',title:'x',key:'x',caption:'',categoryColumn:1,groupColumn:0,valueColumns:[2,3]});
  const semantic={title:'x',message:'x',components:[{id:'results',label:'Results',meaning:'x',sourceRefs:['experiment.md']},{id:'budget',label:'Budget',meaning:'At most one intervention',sourceRefs:['idea.md']}],relationships:[],constraints:[]};
  const design={...scene,rationale:'x',modules:scene.modules.map(m=>({...m,componentIds:['results']})),annotations:[{id:'budget-note',type:'text' as const,x:10,y:10,width:300,text:'Max 1 intervention',fontSize:28,componentIds:['budget']}]};
  validateDesign(design,semantic);
  design.annotations[0].componentIds=[];
  assert.throws(()=>validateDesign(design,semantic),/omitted semantic component budget/);
});
test('publication-specific text floor protects print readability without converting text into paths',()=>{
  const scene=evidenceChart(extractEvidenceTables([material])[0],{tableId:'table_0',title:'x',key:'x',caption:'',categoryColumn:1,groupColumn:0,valueColumns:[2,3]});
  const fitted=fitModuleText([{id:'caption',type:'text',x:0,y:0,width:300,text:'Editable text',fontSize:16}],300,100,{...scene.style,minimumFontSize:31});
  assert.equal(fitted[0].fontSize,31);assert.equal(fitted[0].type,'text');
});
test('adding an implicit text box preserves center and right glyph anchors',()=>{
  const scene=evidenceChart(extractEvidenceTables([material])[0],{tableId:'table_0',title:'x',key:'x',caption:'',categoryColumn:1,groupColumn:0,valueColumns:[2,3]});
  const fitted=fitModuleText([{id:'center',type:'text',x:150,y:20,text:'Gate',fontSize:31,align:'center'}, {id:'right',type:'text',x:280,y:60,text:'Reject',fontSize:31,align:'right'}],300,150,scene.style);
  assert.equal(fitted[0].x+fitted[0].width!/2,150);assert.equal(fitted[1].x+fitted[1].width!,280);
  assert.ok(fitted[0].width!<100);assert.ok(fitted[1].width!<130);
});
test('CSS font fallback lists are measured using the actual primary font',()=>{
  assert.equal(canvasFont('Arial, sans-serif',31,'bold'),'bold 31px "Arial"');
  const scene=evidenceChart(extractEvidenceTables([material])[0],{tableId:'table_0',title:'x',key:'x',caption:'',categoryColumn:1,groupColumn:0,valueColumns:[2,3]});
  const style={...scene.style,font:'Arial, sans-serif'};
  const fitted=fitModuleText([{id:'note',type:'text',x:0,y:0,width:380,text:'Constraint: Max 1 Intervention (Count Limit)',fontSize:31,fontWeight:700}],400,200,style);
  assert.ok(textBoxes(fitted,style).every(box=>box.width<=380));
});
test('explicit shape-owned labels stay inside their editable containers and grow tiny boxes',()=>{
  const scene=evidenceChart(extractEvidenceTables([material])[0],{tableId:'table_0',title:'x',key:'x',caption:'',categoryColumn:1,groupColumn:0,valueColumns:[2,3]});
  const items=[{id:'box',type:'rect' as const,x:20,y:20,width:240,height:95},{id:'label',type:'text' as const,x:0,y:0,text:'Keep Original\nPrefix',fontSize:31,align:'center' as const,containerId:'box'}];
  const fitted=fitModuleText(items,300,200,scene.style);const label=fitted[1];
  assert.equal(label.x,28);assert.equal(label.width,224);assert.ok(label.y>20&&label.y+31*1.24*2<115);
  const grown=fitModuleText([{...items[0],height:30},items[1]],300,200,scene.style);
  assert.ok(grown[0].height!>=85);
  assert.equal(grown[1].fontSize,31);
  assert.equal(grown[1].text,items[1].text);
  assert.ok(grown[1].y+31*1.24*2<=grown[0].y+grown[0].height!);
});
test('object-level refinement preserves scientific words, stable IDs, other objects and input snapshots',async()=>{
  const scene=evidenceChart(extractEvidenceTables([material])[0],{tableId:'table_0',title:'x',key:'x',caption:'',categoryColumn:1,groupColumn:0,valueColumns:[2,3]});
  const previous=structuredClone(scene),text=scene.modules[0].elements.find(e=>e.type==='text')!;
  const output=await refineSceneDocument(scene,'Reflow','mock',undefined,undefined,async()=>({patches:[{moduleId:scene.modules[0].id,elementId:text.id,properties:{y:8}}]}));
  assert.deepEqual(scene,previous);assert.equal(output.modules[0].elements.find(e=>e.id===text.id)!.y,8);
  await assert.rejects(refineSceneDocument(scene,'','mock',undefined,undefined,async()=>({patches:[{moduleId:scene.modules[0].id,elementId:text.id,properties:{text:'New unsupported claim'}}]})),/not rewrite/);
  scene.modules[0].elements.find(e=>e.id===text.id)!.locked=true;
  await assert.rejects(refineSceneDocument(scene,'','mock',undefined,undefined,async()=>({patches:[{moduleId:scene.modules[0].id,elementId:text.id,properties:{y:8}}]})),/locked/);
});
