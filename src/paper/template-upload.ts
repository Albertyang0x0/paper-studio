import { strFromU8, unzipSync } from 'fflate';
import type { PaperTemplate } from '../../shared/paper-types';
import { validateTemplate } from '../../shared/paper-template';

export async function readTemplate(file: File): Promise<PaperTemplate> {
  if (file.size > 4_000_000) throw Error('模板文件不能超过 4 MB。');
  let files: PaperTemplate['files'];
  if (/\.zip$/i.test(file.name)) {
    let count = 0, size = 0;
    const archive = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter(info) {
      if (/__MACOSX|(^|\/)\./.test(info.name) || !/\.(tex|sty|cls|bst|bib|cfg|def)$/i.test(info.name)) return false;
      if (info.name.split(/[\\/]/).includes('..') || /^[\\/]|^[A-Za-z]:/.test(info.name)) throw Error('模板包含不安全的路径。');
      count++; size += info.originalSize;
      if (count > 80 || size > 4_000_000) throw Error('模板解压后的文件总量不能超过 4 MB / 80 个文件。');
      return true;
    } });
    files = Object.entries(archive).map(([name, data]) => ({ name: name.split('/').at(-1)!, content: strFromU8(data) }));
  } else if (/\.tex$/i.test(file.name)) files = [{ name: file.name, content: await file.text() }];
  else throw Error('论文模板支持 .tex 或 .zip。');
  const entries = files.filter(f => /\.tex$/i.test(f.name) && /\\documentclass/.test(f.content));
  const entry = entries.find(f => /^main\.tex$/i.test(f.name)) ?? entries.find(f => /^template\.tex$/i.test(f.name)) ?? entries[0];
  if (!entry) throw Error('模板中没有 LaTeX 主文件。');
  return validateTemplate({ name: file.name, entry: entry.name, files })!;
}

export async function readTemplateFiles(selected: File[], current?: PaperTemplate): Promise<PaperTemplate> {
  if (!selected.length) throw Error('请选择模板文件。');
  if (selected.length === 1 && /\.zip$/i.test(selected[0].name)) return readTemplate(selected[0]);
  if (selected.some(f => /\.zip$/i.test(f.name))) throw Error('请选择一个 ZIP，或选择同目录下的 LaTeX 文件。');
  if (selected.length > 80 || selected.reduce((size, f) => size + f.size, 0) > 4_000_000)
    throw Error('模板文件总量不能超过 4 MB / 80 个文件。');
  const uploaded = await Promise.all(selected.map(async f => ({ name: f.name, content: await f.text() })));
  const entries = uploaded.filter(f => /\.tex$/i.test(f.name) && /\\documentclass/.test(f.content));
  if (!entries.length && !current) throw Error('请同时选择主 .tex 文件与 .sty 等依赖，或上传模板 ZIP。');
  // A new main file replaces the template. Dependency-only selections complete the current one.
  const files = entries.length ? uploaded : [...current!.files.filter(f => !uploaded.some(u => u.name.toLowerCase() === f.name.toLowerCase())), ...uploaded];
  const entry = entries.find(f => /^main\.tex$/i.test(f.name)) ?? entries.find(f => /^template\.tex$/i.test(f.name)) ?? entries[0];
  return validateTemplate({ name: entries.length ? entry.name : current!.name,
    entry: entry?.name ?? current!.entry, files })!;
}
