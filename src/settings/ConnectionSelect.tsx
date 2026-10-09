import { useEffect, useState } from "react";
import type { ApiSettingsStatus } from "../../shared/api-settings";
import { useApiSettingsUpdates } from "./api-settings-events";

export function useConnectionSettings() {
  const [settings, setSettings] = useState<ApiSettingsStatus>();
  useEffect(() => { let active = true;
    void fetch('/api/settings').then(r=>r.json()).then(s=>{if(active && Array.isArray(s.connections))setSettings(s);}).catch(()=>{});
    return ()=>{active=false;};
  }, []);
  useApiSettingsUpdates(setSettings);
  return settings;
}
export function ConnectionSelect({ settings, value, kind = "text", label, disabled, onChange }: {
  settings?: ApiSettingsStatus; value?: string; kind?: "text" | "image"; label: string; disabled?: boolean; onChange: (id: string) => void;
}) {
  const connections = settings?.connections?.filter(c=>kind!=='image'||c.protocol!=='anthropic')??[];
  const defaultId=kind==='image'?settings?.defaultImageConnectionId:settings?.defaultConnectionId;
  const defaultName=connections.find(c=>c.id===defaultId)?.name;
  return <select aria-label={label} value={value??''} disabled={disabled} onChange={e=>onChange(e.target.value)}>
    <option value="">默认连接{defaultName?' · '+defaultName:''}</option>
    {value&&!connections.some(c=>c.id===value)&&<option value={value}>已移除的连接 · 请重新选择</option>}
    {connections.map(c=><option key={c.id} value={c.id}>{c.name}{c.configured?'':' · 未配置'}</option>)}
  </select>;
}
