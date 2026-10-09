import { FileText, Upload, X } from 'lucide-react';
import type { PaperMaterial, PaperTemplate } from '../../shared/paper-types';

export function PaperInputs({ template, materials, ideaSpark, onTemplate, onFile, onText, onRemove, onEntry }: {
  template?: PaperTemplate; materials: PaperMaterial[]; ideaSpark: string;
  onTemplate: (files: File[]) => void; onFile: (file: File, role: 'idea' | 'experiment') => void;
  onText: (role: 'idea' | 'experiment', content: string) => void;
  onRemove: (role: 'template' | 'idea' | 'experiment') => void;
  onEntry: (entry: string) => void;
}) {
  return <div className="pw-inputs">
    <section className="pw-input-slot" data-input="template">
      <header><div><FileText size={16} /><strong>论文模板</strong></div>
        <label className="pw-upload-button"><Upload size={14} />{template ? '上传文件' : '上传'}
          <input aria-label="上传论文模板" type="file" multiple accept=".tex,.zip,.sty,.cls,.bst,.bib,.cfg,.def" onChange={e => {
            const files = Array.from(e.target.files ?? []); if (files.length) onTemplate(files); e.target.value = '';
          }} /></label>
      </header>
      <div className="pw-input-filename"><span>{template?.name ?? '.tex 与依赖文件 / .zip'}</span>
        {template && <button aria-label="移除论文模板" onClick={() => onRemove('template')}><X size={14} /></button>}</div>
      {template && <details><summary>{template.files.length} 个模板文件</summary>
        <label>主文件<select aria-label="模板主文件" value={template.entry} onChange={e => onEntry(e.target.value)}>
          {template.files.filter(f => /\.tex$/i.test(f.name) && /\\documentclass/.test(f.content)).map(f => <option key={f.name}>{f.name}</option>)}
        </select></label>
        <ul>{template.files.map(f => <li key={f.name}>{f.name}</li>)}</ul>
      </details>}
    </section>
    {(['idea', 'experiment'] as const).map(role => {
      const material = materials.find(m => m.role === role);
      const content = material?.content ?? (role === 'idea' ? ideaSpark : '');
      return <section className="pw-input-slot" data-input={role} key={role}>
        <header><div><FileText size={16} /><strong>{role === 'idea' ? 'Idea' : 'Experiment'}</strong></div>
          <label className="pw-upload-button"><Upload size={14} />{material ? '替换' : '上传'}
            <input aria-label={`上传 ${role}`} type="file" accept=".md,.txt,.csv,.tsv,.json" onChange={e => {
              const file = e.target.files?.[0]; if (file) onFile(file, role); e.target.value = '';
            }} /></label>
        </header>
        <div className="pw-input-filename"><span>{material?.name ?? (content ? '已输入内容' : '.md / .txt / .csv / .json')}</span>
          {(material || content) && <button aria-label={`移除 ${role}`} onClick={() => onRemove(role)}><X size={14} /></button>}</div>
        <details open={!content}><summary>{content ? `${content.length.toLocaleString()} 字符 · 编辑内容` : '粘贴内容'}</summary>
          <textarea aria-label={role === 'idea' ? 'Idea spark' : 'Experiment 内容'} rows={4} value={content}
            onChange={e => onText(role, e.target.value)} placeholder={role === 'idea' ? '研究想法' : '实验记录与结果'} />
        </details>
      </section>;
    })}
  </div>;
}
