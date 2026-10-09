import type { PaperTemplate } from './paper-types';

export function validateTemplate(value: unknown): PaperTemplate | undefined {
  if (value === undefined || value === null) return undefined;
  const v = value as PaperTemplate;
  if (typeof v.name !== 'string' || typeof v.entry !== 'string' || !Array.isArray(v.files) || v.files.length > 80)
    throw Error('论文模板格式无效。');
  const names = new Set<string>();
  let size = 0;
  for (const file of v.files) {
    if (typeof file?.name !== 'string' || typeof file?.content !== 'string'
      || !/^[A-Za-z0-9_ .-]+\.(tex|sty|cls|bst|bib|cfg|def)$/i.test(file.name)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(file.name)
      || file.name.includes('..') || file.content.includes('\0'))
      throw Error('模板仅支持同一目录下的 LaTeX 文本文件。');
    if (names.has(file.name.toLowerCase())) throw Error('模板包含重复文件名。');
    names.add(file.name.toLowerCase());
    size += file.content.length;
  }
  if (size > 4_000_000) throw Error('模板文件总量不能超过 4 MB。');
  const main = v.files.find(f => f.name === v.entry);
  if (!main || !/\.tex$/i.test(v.entry) || !/\\documentclass(?:\[[^\]]*\])?\{[^}]+\}/.test(main.content)
    || !main.content.includes('\\begin{document}'))
    throw Error('请选择包含 documentclass 和 begin{document} 的模板主文件。');
  return { name: v.name.slice(0, 160), entry: v.entry, files: v.files.map(f => ({ name: f.name, content: f.content })) };
}

// Keep the template's formatting, not its sample manuscript or author/title metadata.
export function templatePreamble(template: PaperTemplate): string {
  const main = template.files.find(f => f.name === template.entry)!;
  let preamble = main.content.split('\\begin{document}')[0];
  for (const command of ['title', 'author', 'date']) {
    const pattern = new RegExp('\\\\' + command + '\\s*(?:\\[[^\\]]*\\])?\\s*\\{', 'g');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(preamble))) {
      let end = pattern.lastIndex, depth = 1;
      for (; end < preamble.length && depth; end++) {
        if (preamble[end] === '\\') { end++; continue; }
        if (preamble[end] === '{') depth++;
        if (preamble[end] === '}') depth--;
      }
      if (depth) throw Error('模板标题或作者命令的括号不完整。');
      preamble = preamble.slice(0, match.index) + preamble.slice(end);
      pattern.lastIndex = 0;
    }
  }
  return preamble.trim();
}
