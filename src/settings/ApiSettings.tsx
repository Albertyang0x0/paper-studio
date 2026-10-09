import { useEffect, useRef, useState } from "react";
import { Check, Eye, EyeOff, KeyRound, Loader2, Plus, Trash2, X } from "lucide-react";
import { protocolDefaults, protocolLabels, type ApiSettingsStatus, type ApiConnectionResult, type ConnectionDraft, type ApiProtocol, type ApiConnection } from "../../shared/api-settings";
import { notifyApiSettingsChanged } from "./api-settings-events";
import "./api-settings.css";

async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, body === undefined ? { signal } : {
    method: "POST", headers: { "Content-Type": "application/json", "X-Paper-Studio-Settings": "1" }, body: JSON.stringify(body), signal,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "API 设置请求失败。");
  return data;
}
const draftFor=(connection:ApiConnection):ConnectionDraft=>({
  id:connection.id,name:connection.name,protocol:connection.protocol,baseUrl:connection.baseUrl,
  textModel:connection.textModel,imageModel:connection.imageModel,imageApi:connection.imageApi,requiresKey:connection.requiresKey,
});
const newDraft=():ConnectionDraft=>({name:"",protocol:"openai-compatible",...protocolDefaults["openai-compatible"],requiresKey:true});

function ApiSettingsDialog({ onClose }: { onClose: () => void }) {
  const dialog=useRef<HTMLDialogElement>(null),operation=useRef<AbortController|undefined>(undefined);
  const [status,setStatus]=useState<ApiSettingsStatus>(),[draft,setDraft]=useState<ConnectionDraft>(newDraft);
  const [visible,setVisible]=useState(false),[busy,setBusy]=useState<"loading"|"save"|"test"|"defaults"|"remove"|undefined>("loading");
  const [error,setError]=useState(""),[message,setMessage]=useState("");
  const [textDefault,setTextDefault]=useState(""),[imageDefault,setImageDefault]=useState("");
  const current=status?.connections.find(c=>c.id===draft.id);
  const sameEndpoint=current?.protocol===draft.protocol&&current.baseUrl===draft.baseUrl.trim().replace(/\/+$/,"");
  const canUseKey=!draft.requiresKey||Boolean(draft.apiKey?.trim())||Boolean(current?.configured&&sameEndpoint);
  const usable=Boolean(draft.name.trim()&&draft.baseUrl.trim()&&canUseKey);
  const accept=(saved:ApiSettingsStatus,id?:string)=>{
    setStatus(saved);setTextDefault(saved.defaultConnectionId);setImageDefault(saved.defaultImageConnectionId);
    const selected=saved.connections.find(c=>c.id===(id||draft.id||saved.defaultConnectionId));
    if(selected)setDraft(draftFor(selected));
    setVisible(false);notifyApiSettingsChanged(saved);
  };
  useEffect(()=>{
    const node=dialog.current!,previousFocus=document.activeElement as HTMLElement|null,controller=new AbortController();
    node.showModal();
    void request<ApiSettingsStatus>("/api/settings",undefined,controller.signal).then(s=>{
      setStatus(s);setTextDefault(s.defaultConnectionId);setImageDefault(s.defaultImageConnectionId);
      const connection=s.connections.find(c=>c.id===s.defaultConnectionId);if(connection)setDraft(draftFor(connection));
    }).catch(e=>{if(!controller.signal.aborted)setError(e.message);}).finally(()=>{if(!controller.signal.aborted)setBusy(undefined);});
    return ()=>{controller.abort();operation.current?.abort();node.close();previousFocus?.focus();};
  },[]);
  const change=(patch:Partial<ConnectionDraft>)=>{setDraft(v=>({...v,...patch}));setError("");setMessage("");};
  async function perform(kind:"save"|"test"|"defaults"|"remove"){
    setError("");setMessage("");setBusy(kind);
    const controller=new AbortController();operation.current=controller;
    try{
      if(kind==="test"){
        const tested=await request<ApiConnectionResult>("/api/settings/test",{draft},controller.signal);
        setMessage(tested.message+(tested.limitRemaining===undefined?"":" Key 剩余额度：$"+tested.limitRemaining.toFixed(2)));
      }else{
        const saved=await request<ApiSettingsStatus>("/api/settings/"+(kind==="save"?"connections":kind==="defaults"?"defaults":"remove"),
          kind==="save"?draft:kind==="defaults"?{defaultConnectionId:textDefault,defaultImageConnectionId:imageDefault}:{connectionId:draft.id},controller.signal);
        const created=kind==="save"&&!draft.id?saved.connections.find(c=>!status?.connections.some(p=>p.id===c.id))?.id:undefined;
        accept(saved,kind==="remove"?saved.defaultConnectionId:created);
        setMessage(kind==="defaults"?"已保存默认连接。":kind==="remove"?"已删除连接。":"已保存，论文和绘图模块即时生效。");
      }
    }catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:"请求失败，请重试。");}
    finally{if(!controller.signal.aborted)setBusy(undefined);}
  }
  const close=()=>{if(!busy||busy==="test"||busy==="loading")onClose();};
  return <dialog ref={dialog} className="api-settings-dialog" aria-labelledby="api-settings-title"
    onCancel={e=>{e.preventDefault();close();}} onClick={e=>{
      if(e.target!==e.currentTarget)return;const r=e.currentTarget.getBoundingClientRect();
      if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)close();
    }}>
    <header className="api-settings-header"><h2 id="api-settings-title">API 设置</h2>
      <button type="button" aria-label="关闭 API 设置" onClick={close} disabled={busy==="save"||busy==="defaults"||busy==="remove"}><X size={18}/></button>
    </header>
    <form onSubmit={e=>{e.preventDefault();if(!busy&&usable)void perform("save");}}>
      <div className="api-settings-body">
        <div className="api-connections-row">
          <select aria-label="选择 API 连接" value={draft.id??""} disabled={Boolean(busy)} onChange={e=>{
            const c=status?.connections.find(p=>p.id===e.target.value);if(c)setDraft(draftFor(c));else setDraft(newDraft());
            setVisible(false);setError("");setMessage("");
          }}>
            {!draft.id&&<option value="">新增连接</option>}
            {status?.connections.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button type="button" aria-label="新增连接" title="新增连接" disabled={Boolean(busy)} onClick={()=>{setDraft(newDraft());setVisible(false);setError("");setMessage("");}}><Plus size={17}/></button>
          <button type="button" aria-label="删除连接" title="删除前请先更换默认连接"
            disabled={Boolean(busy)||!draft.id||draft.id===status?.defaultConnectionId||draft.id===status?.defaultImageConnectionId}
            onClick={()=>{if(confirm("删除此连接？绑定它的模块需重新选择连接，论文内容不会删除。"))void perform("remove");}}><Trash2 size={16}/></button>
        </div>
        <div className="api-settings-grid">
          <label>连接名称<input aria-label="连接名称" value={draft.name} disabled={Boolean(busy)} placeholder="例如：团队文本模型" onChange={e=>change({name:e.target.value})}/></label>
          <label>接口协议<select aria-label="接口协议" value={draft.protocol} disabled={Boolean(busy)} onChange={e=>{
            const protocol=e.target.value as ApiProtocol;change({protocol,...protocolDefaults[protocol],requiresKey:true,apiKey:undefined});
          }}>{Object.entries(protocolLabels).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label>
        </div>
        <label htmlFor="api-base-url">Base URL</label>
        <input id="api-base-url" value={draft.baseUrl} disabled={Boolean(busy)||draft.protocol==="openrouter"} spellCheck={false} onChange={e=>change({baseUrl:e.target.value,apiKey:undefined})}/>
        <label htmlFor="api-key-input">API key</label>
        <div className="api-key-field">
          <input id="api-key-input" type={visible?"text":"password"} value={draft.apiKey??""} autoComplete="off" spellCheck={false}
            placeholder={current?.configured&&sameEndpoint?"留空保留当前 key":"填写该服务的 API key"} disabled={Boolean(busy)||!draft.requiresKey} onChange={e=>change({apiKey:e.target.value})}/>
          <button type="button" aria-label={visible?"隐藏 API key":"显示 API key"} aria-pressed={visible} disabled={Boolean(busy)} onClick={()=>setVisible(!visible)}>{visible?<EyeOff size={17}/>:<Eye size={17}/>}</button>
        </div>
        {current?.keyHint&&sameEndpoint&&<p className="api-settings-note">当前 Key：{current.keyHint} · {current.source==="saved"?"工作台配置":"环境配置"}</p>}
        {current&&!sameEndpoint&&draft.requiresKey&&<p className="api-settings-note">地址或协议已改变，请填写对应服务的 key。</p>}
        {draft.protocol==="openai-compatible"&&<label className="api-anonymous"><input type="checkbox" checked={!draft.requiresKey} disabled={Boolean(busy)} onChange={e=>change({requiresKey:!e.target.checked,apiKey:undefined})}/>无需 key（如本地模型服务）</label>}
        <div className="api-settings-grid">
          <label>默认文本模型<input aria-label="默认文本模型" value={draft.textModel} disabled={Boolean(busy)} placeholder="模型 ID，可手动填写" onChange={e=>change({textModel:e.target.value})}/></label>
          {draft.protocol!=="anthropic"&&<label>默认图片模型<input aria-label="默认图片模型" value={draft.imageModel} disabled={Boolean(busy)} placeholder="需支持图片生成" onChange={e=>change({imageModel:e.target.value})}/></label>}
        </div>
        {draft.protocol==="openai-compatible"&&<label>图片接口<select aria-label="图片接口" value={draft.imageApi} disabled={Boolean(busy)} onChange={e=>change({imageApi:e.target.value as "images"|"chat"})}>
          <option value="images">Images API · 生成 / 参考图编辑</option><option value="chat">Chat Completions · 图片输出</option>
        </select></label>}
        <p className="api-settings-note">仅将 key 发送到所配置的服务地址；不写入浏览器存储或论文导出。</p>
        <details className="api-defaults" open>
          <summary>工作台默认连接</summary>
          <div className="api-settings-grid">
            <label>文本连接<select aria-label="默认文本连接" value={textDefault} disabled={Boolean(busy)} onChange={e=>setTextDefault(e.target.value)}>
              {status?.connections.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
            </select></label>
            <label>图片连接<select aria-label="默认图片连接" value={imageDefault} disabled={Boolean(busy)} onChange={e=>setImageDefault(e.target.value)}>
              {status?.connections.filter(c=>c.protocol!=="anthropic").map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
            </select></label>
          </div>
          <button type="button" disabled={Boolean(busy)||!textDefault||!imageDefault||(textDefault===status?.defaultConnectionId&&imageDefault===status.defaultImageConnectionId)} onClick={()=>void perform("defaults")}>保存默认连接</button>
        </details>
        <p className="api-settings-note">模块可以覆盖默认连接与模型。“测试连接”只读取账户或模型列表，不生成内容。</p>
        {error&&<p className="api-settings-error" role="alert">{error}</p>}
        {message&&<p className="api-settings-result" role="status"><Check size={15}/>{message}</p>}
      </div>
      <footer className="api-settings-footer">
        <button type="button" disabled={Boolean(busy)||!usable} title="不验证具体模型的生成权限" onClick={()=>void perform("test")}>{busy==="test"&&<Loader2 className="api-settings-spinner" size={15}/>}测试连接</button>
        <button type="submit" className="api-settings-primary" disabled={Boolean(busy)||!usable}>{busy==="save"&&<Loader2 className="api-settings-spinner" size={15}/>}保存配置</button>
      </footer>
    </form>
  </dialog>;
}
export function ApiSettingsButton({ className = "", iconOnly = false }: { className?: string; iconOnly?: boolean }) {
  const [open,setOpen]=useState(false);
  return <><button type="button" className={className+" api-settings-trigger"} title="API 设置" aria-label="API 设置" aria-haspopup="dialog" onClick={()=>setOpen(true)}>
    <KeyRound size={16}/>{!iconOnly&&<span>API 设置</span>}
  </button>{open&&<ApiSettingsDialog onClose={()=>setOpen(false)}/>}</>;
}
