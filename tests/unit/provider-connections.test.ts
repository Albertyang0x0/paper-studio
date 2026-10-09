import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { ApiSettingsStore } from '../../server/api-settings';
import { protocolDefaults, type ConnectionDraft, type ApiProtocol } from '../../shared/api-settings';
import { withApiConnections, runtimeConnection } from '../../server/provider-runtime';
import { providerText, providerImage, providerModels } from '../../server/provider-transport';
import type { ServerConnection } from '../../server/provider-types';

const key='fixture-key-A-not-real', other='fixture-key-B-not-real';
const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=';
const profile=(protocol:ApiProtocol='openai-compatible',apiKey=key):ServerConnection=>({
  id:protocol,name:protocol,protocol,...protocolDefaults[protocol],baseUrl:protocol==='anthropic'?'https://fixture.example':'https://fixture.example/v1',apiKey,
  textModel:'same-model-id',imageModel:'same-image-id',requiresKey:true,revision:1,source:'saved',
});
const draft=(name:string,protocol:ApiProtocol='openai-compatible'):ConnectionDraft=>({
  name,protocol,...protocolDefaults[protocol],baseUrl:`https://${name}.example/v1`,apiKey:key,requiresKey:true,
});
async function rootFor(t:TestContext){const parent=resolve(tmpdir()),root=await mkdtemp(join(parent,'paper-studio-connections-'));
  t.after(async()=>{assert.equal(dirname(root),parent);assert.ok(root.startsWith(join(parent,'paper-studio-connections-')));await rm(root,{recursive:true,force:true});});return root;}

test('v1 saved credentials migrate in memory, multi-connection profiles persist without leaking keys',async t=>{
  const root=await rootFor(t),path=join(root,'api-settings.json'),legacy='sk-or-v1-'+'legacy-test-only'.repeat(3);
  await writeFile(path,JSON.stringify({version:1,apiKey:legacy,updatedAt:'2026-10-06'}));
  const store=new ApiSettingsStore(path,{});await store.init();
  assert.equal(store.status().connections.length,1);assert.equal(store.resolve().apiKey,legacy);
  await store.upsert(draft('writer'));await store.upsert({...draft('artist','gemini'),apiKey:other});
  const status=store.status(),writer=status.connections.find(c=>c.name==='writer')!,artist=status.connections.find(c=>c.name==='artist')!;
  await store.defaults(writer.id,artist.id);
  assert.equal(store.resolve().apiKey,key);assert.equal(store.resolve(undefined,'image').apiKey,other);
  for(const secret of [key,other,legacy])assert.ok(!JSON.stringify(store.status()).includes(secret));
  const restarted=new ApiSettingsStore(path,{});await restarted.init();assert.deepEqual(restarted.status(),store.status());
  assert.equal(JSON.parse(await readFile(path,'utf8')).version,2);
});
test('changing a base URL or protocol cannot silently reuse a saved key',async t=>{
  const store=new ApiSettingsStore(join(await rootFor(t),'api-settings.json'),{});
  const status=await store.upsert(draft('writer')),saved=status.connections.find(c=>c.name==='writer')!;
  assert.throws(()=>store.upsert({...saved,baseUrl:'https://other.example/v1'}),/重新填写/);
  assert.throws(()=>store.upsert({...saved,protocol:'gemini'}),/重新填写/);
  assert.equal(store.resolve(saved.id).apiKey,key);
  await store.upsert({...saved,baseUrl:'https://other.example/v1',apiKey:other});
  assert.equal(store.resolve(saved.id).apiKey,other);
  for(const baseUrl of ['file:///tmp/key','https://user:password@example.com/v1','https://example.com/v1?key=abc'])
    assert.throws(()=>store.upsert({...draft('invalid'),baseUrl}),/Base URL/);
  assert.throws(()=>store.upsert({...draft('invalid'),textModel:key}),/API key/);
});
test('local services can omit authentication, short keys stay fully masked, deleted bindings never fall back',async t=>{
  const store=new ApiSettingsStore(join(await rootFor(t),'api-settings.json'),{});
  const s=await store.upsert({...draft('local'),baseUrl:'http://localhost:11434/v1',requiresKey:false,apiKey:undefined});
  const local=s.connections.find(c=>c.name==='local')!;assert.equal(local.configured,true);assert.equal(store.resolve(local.id).apiKey,undefined);
  await store.upsert({...draft('remote'),apiKey:'x'});
  const remote=store.status().connections.find(c=>c.name==='remote')!;assert.equal(remote.keyHint,'••••');
  await assert.rejects(store.remove(local.id),/默认/);
  await store.remove(remote.id);assert.throws(()=>store.resolve(remote.id),/不存在/);
  assert.throws(()=>store.upsert({...local,protocol:'anthropic',apiKey:key}),/默认图片/);
});
test('parallel jobs and role overrides isolate endpoints/keys, running jobs retain their initial snapshot',async t=>{
  const store=new ApiSettingsStore(join(await rootFor(t),'api-settings.json'),{});
  await store.upsert(draft('first'));await store.upsert({...draft('second'),apiKey:other});
  const first=store.status().connections.find(c=>c.name==='first')!,second=store.status().connections.find(c=>c.name==='second')!;
  const results=await Promise.all([first,second].map(p=>withApiConnections({text:p.id},async()=>{
    await new Promise(done=>setTimeout(done,10));return runtimeConnection().apiKey;
  },store)));
  assert.deepEqual(results,[key,other]);
  await withApiConnections({text:first.id,image:second.id},async()=>{
    assert.equal(runtimeConnection(undefined,'image').apiKey,other);
    assert.equal(runtimeConnection(second.id).apiKey,other);
    await store.upsert({...first,apiKey:'new-fixture-key'});
    assert.equal(runtimeConnection().apiKey,key);
  },store);
  withApiConnections({text:first.id},()=>assert.equal(runtimeConnection().apiKey,'new-fixture-key'),store);
});
test('OpenAI-compatible text requests omit OpenRouter extensions and use only the chosen endpoint/key',async()=>{
  const connection=profile();let url='',options:RequestInit|undefined;
  const mock=(async(u,o)=>{url=String(u);options=o;return Response.json({model:'same-model-id',choices:[{message:{content:'{"ok":true}'}}],usage:{input_tokens:2}});}) as typeof fetch;
  const result=await providerText(connection,'same-model-id','system','data',[image],8000,true,new AbortController().signal,mock,{reasoning:{effort:'high'},provider:{order:['unsafe']}});
  assert.equal(url,'https://fixture.example/v1/chat/completions');
  assert.equal((options!.headers as Record<string,string>).Authorization,'Bearer '+key);
  const body=JSON.parse(options!.body as string);assert.equal(body.reasoning,undefined);assert.equal(body.provider,undefined);assert.equal(body.response_format,undefined);
  assert.equal(body.messages[1].content[1].image_url.url,image);assert.equal(result.text,'{"ok":true}');
  assert.equal(body.max_tokens,8000);
  await providerText(connection,'gpt-5','system','data',[],9000,true,new AbortController().signal,mock);
  const reasoningBody=JSON.parse(options!.body as string);
  assert.equal(reasoningBody.max_tokens,undefined);assert.equal(reasoningBody.max_completion_tokens,9000);
});
test('Gemini native uses header authentication, native contents and native text/image response parsing',async()=>{
  const connection=profile('gemini');let calls:{url:string;body:any;headers:any}[]=[];
  const mock=(async(url,options)=>{calls.push({url:String(url),body:JSON.parse(options!.body as string),headers:options!.headers});
    return Response.json(calls.length===1?{candidates:[{content:{parts:[{thought:true,text:'hidden'},{text:'{"ok":true}'}]}}],usageMetadata:{promptTokenCount:7}}:
      {candidates:[{content:{parts:[{thought:true,inlineData:{mimeType:'image/png',data:'ignored'}},{inlineData:{mimeType:'image/png',data:image.split(',')[1]}}]}}]});}) as typeof fetch;
  const text=await providerText(connection,'gemini-example','system','data',[image],9000,true,new AbortController().signal,mock);
  assert.equal(text.text,'{"ok":true}');assert.equal(calls[0].headers['x-goog-api-key'],key);assert.equal(calls[0].headers.Authorization,undefined);
  assert.equal(calls[0].body.contents[0].parts[1].inlineData.mimeType,'image/png');
  const result=await providerImage(connection,'gemini-image','draw',[image],new AbortController().signal,mock);
  assert.equal(result.image,image);assert.deepEqual(calls[1].body.generationConfig.responseModalities,['TEXT','IMAGE']);
  assert.ok(calls[1].url.endsWith('/models/gemini-image:generateContent'));
});
test('OpenAI Images supports references via multipart edits and generation via JSON, no credentials on result downloads',async()=>{
  const connection={...profile(),imageApi:'images' as const};const calls:{url:string;options:RequestInit|undefined}[]=[];
  const mock=(async(url,options)=>{calls.push({url:String(url),options});return Response.json({data:[{b64_json:image.split(',')[1]}]});}) as typeof fetch;
  await providerImage(connection,'image-id','draw',[],new AbortController().signal,mock);
  assert.ok(calls[0].url.endsWith('/images/generations'));assert.equal(JSON.parse(calls[0].options!.body as string).model,'image-id');
  await providerImage(connection,'image-id','draw',[image],new AbortController().signal,mock);
  assert.ok(calls[1].url.endsWith('/images/edits'));assert.equal((calls[1].options!.body as FormData).getAll('image[]').length,1);
  const download=(async(url,options)=>String(url).includes('/images/')?Response.json({data:[{url:'https://asset.example/picture.png'}]}):
    (assert.equal(options!.headers,undefined),new Response(Buffer.from(image.split(',')[1],'base64'),{headers:{'content-type':'image/png'}}))) as typeof fetch;
  assert.equal((await providerImage(connection,'image-id','draw',[],new AbortController().signal,download)).image,image);
});
test('Anthropic adapter uses the official SDK, native image blocks, prompt caching and a complete streamed message',async()=>{
  const connection=profile('anthropic');let options:RequestInit|undefined,url='';
  const events=[
    {type:'message_start',message:{id:'msg_fixture',type:'message',role:'assistant',model:'claude-opus-4-7',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:5,output_tokens:0}}},
    {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
    {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'{"ok":true}'}},
    {type:'content_block_stop',index:0},
    {type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:5}},
    {type:'message_stop'},
  ];
  const mock=(async(u,o)=>{url=String(u);options=o;return new Response(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});}) as typeof fetch;
  const result=await providerText(connection,'claude-opus-4-7','stable prompt','data',[image],16000,true,new AbortController().signal,mock);
  assert.equal(result.text,'{"ok":true}');assert.equal(url,'https://fixture.example/v1/messages');
  const body=JSON.parse(options!.body as string),headers=new Headers(options!.headers);
  assert.equal(headers.get('x-api-key'),key);assert.equal(body.stream,true);assert.equal(body.system[0].cache_control.type,'ephemeral');
  assert.equal(body.messages[0].content[1].source.type,'base64');assert.equal(body.thinking.type,'adaptive');
  await assert.rejects(providerImage(connection,'model','draw',[],new AbortController().signal,mock),/不能生成图片/);
});
test('provider errors and model lists do not echo custom keys, auth-free models omit authorization',async()=>{
  const connection=profile('openai-compatible','custom-short-secret');
  const error=(async()=>Response.json({error:{message:'echo custom-short-secret'}},{status:401})) as typeof fetch;
  await assert.rejects(providerText(connection,'m','s','t',[],10,true,new AbortController().signal,error),e=>{assert.ok(!(e as Error).message.includes(connection.apiKey!));return true;});
  const models=(async(_url,options)=>{assert.equal((options!.headers as any).Authorization,undefined);
    return Response.json({data:[{id:'safe-model'},{id:connection.apiKey}]});}) as typeof fetch;
  const result=await providerModels({...connection,requiresKey:false,apiKey:undefined},models);
  assert.equal(result[0].id,'safe-model');
  const anthropic=profile('anthropic');
  const nativeModels=(async()=>Response.json({data:[{id:'safe-model',display_name:'echo '+key},{id:'model-'+key,display_name:'unsafe'}],has_more:false})) as typeof fetch;
  assert.equal((await providerModels(anthropic,nativeModels)).length,1);
  assert.ok(!JSON.stringify(await providerModels(anthropic,nativeModels)).includes(key));
});
