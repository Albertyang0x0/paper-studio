import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import PDFDocument from "pdfkit";
import SVGtoPDF from "svg-to-pdfkit";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { sceneSvg } from "../../shared/svg";
import type { PaperProject } from "../../shared/paper-types";
import { manuscriptOrder, moduleLabels } from "../../shared/paper-types";
import { citationKeys, manuscriptMarkdown } from "../../shared/paper-project";
import { templatePreamble, validateTemplate } from "../../shared/paper-template";
import { zipSync, strToU8 } from 'fflate';
import { existsSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

const tableMetrics = createCanvas(1, 1).getContext('2d');
tableMetrics.font = '9px "Times New Roman"';
function cellText(node: any): string {
  return typeof node.value === 'string' ? node.value : (node.children ?? []).map(cellText).join('');
}

export const texEscape = (s: string) =>
  s.replace(
    /[\\{}%$&#_^~]/g,
    (c) =>
      ({
        "\\": "\\textbackslash{}",
        "{": "\\{",
        "}": "\\}",
        "%": "\\%",
        $: "\\$",
        "&": "\\&",
        "#": "\\#",
        _: "\\_",
        "^": "\\textasciicircum{}",
        "~": "\\textasciitilde{}",
      })[c]!,
  );
function safeMath(value: string) {
  // TeX primitives can be obfuscated with ^^ encoding or constructed macro names.
  // Permit common math commands only; extend this list explicitly for new packages.
  const allowed = new Set(
    (
      "frac dfrac tfrac cfrac sqrt left right middle big Big bigg Bigg bigl bigr Bigl Bigr biggl biggr Biggl Biggr " +
      "sum prod int iint iiint oint lim limsup liminf min max inf sup arg log ln exp sin cos tan cot sec csc sinh cosh tanh det gcd Pr " +
      "text textrm textbf textit textsf texttt mathrm mathbf mathit mathsf mathtt mathcal mathbb mathfrak boldsymbol operatorname " +
      "alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi varpi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega " +
      "Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega " +
      "cdot cdots ldots vdots ddots dots times div pm mp le leq ge geq neq ne approx sim simeq equiv propto ll gg in notin ni subset subseteq supset supseteq cap cup emptyset varnothing " +
      "forall exists neg land lor wedge vee to mapsto rightarrow leftarrow leftrightarrow Rightarrow Leftarrow Leftrightarrow implies iff longrightarrow longleftarrow hookrightarrow " +
      "infty partial nabla ell hbar Re Im angle perp parallel oplus otimes circ bullet star dagger top bot checkmark " +
      "hat widehat bar overline underline tilde widetilde vec dot ddot overbrace underbrace overset underset stackrel phantom vphantom hphantom " +
      "quad qquad thinspace enspace substack limits nolimits begin end binom dbinom tbinom mod bmod pmod lceil rceil lfloor rfloor langle rangle vert Vert mid bigm label tag notag nonumber"
    ).split(/\s+/),
  );
  if (value.includes("^^") || /(^|[^\\])[#%]/.test(value))
    throw Error("公式中包含不允许的 TeX 编码或宏参数操作。");
  for (const match of value.matchAll(/\\([A-Za-z@]+)/g))
    if (!allowed.has(match[1]))
      throw Error(`公式包含不允许或尚未支持的 TeX 命令：${match[1]}`);
  for (const match of value.matchAll(/\\(?:begin|end)\s*\{([^}]+)\}/g))
    if (
      !/^(aligned|alignedat|gathered|split|cases|matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|smallmatrix)$/.test(
        match[1],
      )
    )
      throw Error("公式包含不允许的 TeX 环境。");
  if (
    /\\(?:input|include|write|read|openout|openin|immediate|csname|def|gdef|edef|let|newcommand|renewcommand|catcode|special|usepackage|documentclass|end\s*\{document)/i.test(
      value,
    )
  )
    throw Error("公式中包含不允许的 TeX 文件或宏操作，请手动检查。");
  return value;
}
function renderNode(n: any): string {
  const children = () => (n.children ?? []).map(renderNode).join("");
  switch (n.type) {
    case "root":
      return children();
    case "text": {
      const parts = n.value.split(/(\[@[^\]]+\]|\[fig:[A-Za-z0-9_-]+\])/g);
      return parts
        .map((part: string) =>
          /^\[@/.test(part)
            ? `\\cite{${citationKeys(part)
                .filter((k) => /^[A-Za-z0-9_:.-]+$/.test(k))
                .join(",")}}`
            : /^\[fig:/.test(part) ? `Figure~\\ref{fig:${part.slice(5,-1)}}` : texEscape(part),
        )
        .join("");
    }
    case "paragraph":
      return children() + "\n\n";
    case "heading":
      return `\\${n.depth <= 2 ? "subsection" : "subsubsection"}{${children()}}\n`;
    case "strong":
      return `\\textbf{${children()}}`;
    case "emphasis":
      return `\\emph{${children()}}`;
    case "inlineCode":
      return `\\texttt{${texEscape(n.value)}}`;
    case "code":
      return `\\begin{quote}\\ttfamily\n${n.value
        .split("\n")
        .map((l: string) => texEscape(l))
        .join("\\\\\n")}\n\\end{quote}\n`;
    case "inlineMath":
      return `$${safeMath(n.value)}$`;
    case "math":
      return `\\[${safeMath(n.value)}\\]\n`;
    case "list":
      return `\\begin{${n.ordered ? "enumerate" : "itemize"}}\n${children()}\\end{${n.ordered ? "enumerate" : "itemize"}}\n`;
    case "listItem":
      return "\\item " + children();
    case "link":
      return /^https?:\/\//.test(n.url)
        ? `${children()} (\\url{${texEscape(n.url)}})`
        : children();
    case "image":
      return "[Image omitted: use the registered figure module.]";
    case "blockquote":
      return `\\begin{quote}${children()}\\end{quote}\n`;
    case "table": {
      const columns = n.children[0]?.children?.length ?? 1;
      // Reserve the measured width of unbreakable words/numbers, including rich-text cells.
      // Character-count proportions made short numeric/model columns overlap their neighbors.
      const widths = Array.from({length:columns},(_,i)=> Math.max(14, ...n.children.flatMap((r:any)=>
        cellText(r.children[i] ?? {}).split(/[\s-]+/).map(word => tableMetrics.measureText(word).width + 1))));
      const total = widths.reduce((a,b)=>a+b,0);
      const spec = widths.map(w => {
        const ratio = w / total;
        return `>{\\raggedright\\arraybackslash}p{\\dimexpr ${ratio.toFixed(5)}\\linewidth-${(ratio*2*columns).toFixed(5)}\\tabcolsep\\relax}`;
      }).join('');
      const rows = n.children
        .map(
          (row: any, index: number) =>
            row.children
              .map((cell: any) => cell.children.map(renderNode).join(""))
              .join(" & ") +
            " \\\\\n" +
            (index === 0 ? "\\hline\n" : ""),
        )
        .join("");
      const caption=n.caption ? `\\refstepcounter{table}\\textbf{Table~\\thetable:} ${texEscape(n.caption)}\\par\\smallskip\n` : '';
      return `\\begin{center}\\begin{minipage}{\\linewidth}\\centering\\small${caption}\\setlength{\\tabcolsep}{4pt}\\renewcommand{\\arraystretch}{1.18}\\begin{tabular}{${spec}}\\hline\n${rows}\\hline\\end{tabular}\\end{minipage}\\end{center}\n`;
    }
    case "break":
      return "\\\\\n";
    case "thematicBreak":
      return "\\medskip\n";
    case "html":
      return texEscape(n.value);
    default:
      return children();
  }
}
export function markdownToTex(markdown: string, figures: {key:string;tex:string}[] = []) {
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(markdown);
  for(let index=0;index<tree.children.length-1;index++){
    const node=tree.children[index] as any,next=tree.children[index+1] as any;
    if(node.type!=='paragraph'||node.children.length!==1||node.children[0].type!=='text'||next.type!=='table')continue;
    const caption=/^Table\s+\d+[.:]\s+(.+)$/.exec(node.children[0].value);
    if(caption){next.caption=caption[1];tree.children.splice(index,1);index--;}
  }
  const headings = tree.children.filter((n:any)=>n.type==='heading') as any[];
  const depth = Math.min(2, ...headings.map(n=>n.depth));
  const lowest = headings.length ? Math.min(...headings.map(n=>n.depth)) : depth;
  for(const n of headings) n.depth=n.depth-lowest+2;
  if(!figures.length)return renderNode(tree);
  const remaining=new Map(figures.map(figure=>[figure.key,figure.tex]));
  const body=tree.children.map((node:any)=>{
    const source=markdown.slice(node.position?.start.offset??0,node.position?.end.offset??0);
    const attached=[...remaining].filter(([key])=>source.includes(`[fig:${key}]`));
    attached.forEach(([key])=>remaining.delete(key));
    return renderNode(node)+attached.map(([,tex])=>tex).join('\n');
  }).join('');
  return body+[...remaining.values()].join('\n');
}
export function bibliographyTex(p: PaperProject) {
  if (!p.citations.length)
    return (
      "\\section*{References}\n" +
      markdownToTex(
        p.modules.references.content ||
          "[TODO: Retrieve and verify references before submission.]",
      )
    );
  for (const c of p.citations)
    if (!/^[A-Za-z0-9_:.-]+$/.test(c.key))
      throw Error("引用键包含不支持的字符。");
  const cited=[...new Set(manuscriptOrder.filter(id=>!['references','figures'].includes(id)).flatMap(id=>citationKeys(p.modules[id].content)))];
  const entries=cited.length ? cited.map(key=>p.citations.find(c=>c.key===key)).filter(c=>!!c) : p.citations;
  return (
    "\\begin{thebibliography}{99}\n" +
    entries
      .map(
        (c) =>
          `\\bibitem{${c.key}} ${texEscape(c.authors.length>8 ? c.authors.slice(0,5).join(', ')+', et al.' : c.authors.join(", "))}. ${texEscape(c.title)}. ${texEscape(c.venue)} ${c.year ?? ""}. ${c.url ? `\\url{${texEscape(c.url)}}` : ""}`,
      )
      .join("\n") +
    "\n\\end{thebibliography}"
  );
}
export function bibliographyBib(p: PaperProject) {
  return p.citations
    .map(
      (c) =>
        `@misc{${c.key},\n  title={${texEscape(c.title)}},\n  author={${texEscape(c.authors.join(" and "))}},\n  year={${c.year ?? ""}},\n  url={${texEscape(c.url)}}\n}`,
    )
    .join("\n\n");
}
export function paperTex(p: PaperProject) {
  const activeAssets = p.modules.figures.assetIds.map(id=>p.assets.find(a=>a.id===id)).filter(a=>!!a);
  const figure = (a: NonNullable<(typeof activeAssets)[number]>)=> {
    const key=a.key??a.id;
    if(!/^[A-Za-z0-9_-]+$/.test(key)) throw Error('Invalid figure key');
    return `\\begin{figure}[htbp]\\centering\\includegraphics[width=\\linewidth]{figure-${a.id}.pdf}\n\\caption{${texEscape(a.caption)}}\\label{fig:${key}}\\end{figure}\n`;
  };
  const body = manuscriptOrder
    .filter((id) => id !== "references")
    .map((id) => {
      if (id === "figures")
        return (
          activeAssets.filter(a=>!a.placement).map(figure)
            .join("\n") +
          (!p.modules.figures.assetIds.length && p.modules.figures.content
            ? markdownToTex(p.modules.figures.content)
            : "")
        );
      return id === "abstract"
        ? `\\begin{abstract}\n${markdownToTex(p.modules[id].content || "[TODO: Missing abstract]")}\\end{abstract}\n`
        : `\\section{${moduleLabels[id]}}\n${markdownToTex(p.modules[id].content || "[TODO: Module not yet written]",activeAssets.filter(a=>a.placement===id).map(a=>({key:a.key??a.id,tex:figure(a)})))}`;
    })
    .join("\n");
  const preamble = p.template
    ? templatePreamble(validateTemplate(p.template)!)
    : "\\documentclass[11pt]{article}\n\\usepackage[utf8]{inputenc}\n\\usepackage[T1]{fontenc}\n\\usepackage[margin=1in]{geometry}";
  return `${preamble}\n\\usepackage{amsmath,amssymb,graphicx,url,flafter,array}\n\\title{${texEscape(p.title)}}\n\\author{Anonymous authors}\n\\date{}\n\\begin{document}\n\\maketitle\n${body}\n${bibliographyTex(p)}\n\\end{document}\n`;
}
export async function paperSourceBundle(p: PaperProject): Promise<Buffer> {
  const files: Record<string, Uint8Array> = {};
  if (p.template) {
    const template = validateTemplate(p.template)!;
    for (const file of template.files) {
      if (file.name === template.entry || ['main.tex', 'references.bib'].includes(file.name.toLowerCase())) continue;
      files[file.name] = strToU8(file.content);
    }
  }
  files['main.tex'] = strToU8(paperTex(p));
  files['references.bib'] = strToU8(bibliographyBib(p));
  files['project.json'] = strToU8(JSON.stringify(p,null,2));
  files['manuscript.md'] = strToU8(manuscriptMarkdown(p));
  p.materials.forEach((material,index)=>{files[`materials/${index+1}-${material.role}.md`]=strToU8(material.content);});
  for (const id of p.modules.figures.assetIds) {
    const asset = p.assets.find(a => a.id === id);
    if (!asset) continue;
    const svg = sceneSvg(asset.scene);
    files[`figure-${asset.id}.svg`] = strToU8(svg);
    files[`figure-${asset.id}.json`] = strToU8(JSON.stringify(asset.scene,null,2));
    files[`figure-${asset.id}.pdf`] = await vectorPdf(svg, asset.scene.width, asset.scene.height);
  }
  return Buffer.from(zipSync(files));
}
export async function vectorPdf(
  svg: string,
  width: number,
  height: number,
): Promise<Buffer> {
  return new Promise((resolvePdf, reject) => {
    try {
      const doc = new PDFDocument({ size: [width, height], margin: 0 });
      const fonts = process.platform==='win32' ? {
        regular:join(process.env.WINDIR??'C:\\Windows','Fonts','arial.ttf'),
        bold:join(process.env.WINDIR??'C:\\Windows','Fonts','arialbd.ttf'),
        italic:join(process.env.WINDIR??'C:\\Windows','Fonts','ariali.ttf'),
        boldItalic:join(process.env.WINDIR??'C:\\Windows','Fonts','arialbi.ttf'),
      } : {regular:process.env.PAPER_FIGURE_FONT??'',bold:process.env.PAPER_FIGURE_BOLD_FONT??'',italic:'',boldItalic:''};
      const chunks: Buffer[] = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolvePdf(Buffer.concat(chunks)));
      doc.on("error", reject);
      SVGtoPDF(doc, svg, 0, 0, {
        width,
        height,
        fontCallback: (_family:string,bold:boolean,italic:boolean) => {
          const path=bold&&italic ? fonts.boldItalic : bold ? fonts.bold : italic ? fonts.italic : fonts.regular;
          return path&&existsSync(path) ? path : fonts.regular&&existsSync(fonts.regular) ? fonts.regular : 'Helvetica';
        },
        assumePt: true,
      });
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}
export async function buildPdf(p: PaperProject, root: string) {
  const known = new Set(p.citations.map((c) => c.key));
  const unknown = Object.values(p.modules)
    .flatMap((m) => citationKeys(m.content))
    .filter((k) => !known.has(k));
  if (unknown.length)
    throw Error(`存在未登记的引用：${[...new Set(unknown)].join(", ")}`);
  if (
    p.language === "zh" ||
    /[\u3400-\u9fff]/.test(
      p.title +
        Object.values(p.modules)
          .map((m) => m.content)
          .join(""),
    )
  )
    throw Error(
      "当前 PDF 编译器仅配置英文 pdflatex。中文主稿请导出 LaTeX 项目，在支持中文的 TeX 环境编译。",
    );
  const id = randomUUID(),
    dir = resolve(root, p.id, "builds", id);
  await mkdir(dir, { recursive: true });
  if (p.template) {
    const template = validateTemplate(p.template)!;
    for (const file of template.files) {
      if (file.name === template.entry || file.name.toLowerCase() === 'main.tex') continue;
      await writeFile(join(dir, file.name), file.content, "utf8");
    }
  }
  await writeFile(join(dir, "main.tex"), paperTex(p), "utf8");
  for (const assetId of p.modules.figures.assetIds) {
    const a = p.assets.find((v) => v.id === assetId);
    if (!a) continue;
    await writeFile(join(dir, `figure-${a.id}.svg`), sceneSvg(a.scene));
    await writeFile(
      join(dir, `figure-${a.id}.pdf`),
      await vectorPdf(sceneSvg(a.scene), a.scene.width, a.scene.height),
    );
  }
  const logs: string[] = [];
  try {
    for (let pass = 0; pass < 2; pass++)
      await new Promise<void>((done, reject) => {
        execFile(
          process.env.PAPER_PDFLATEX ?? "pdflatex",
          [
            ...(process.platform === "win32" ? ["--disable-installer"] : []),
            "-interaction=nonstopmode",
            "-halt-on-error",
            "-no-shell-escape",
            "main.tex",
          ],
          { cwd: dir, windowsHide: true, timeout: 30000, maxBuffer: 1000000,
            env: { ...process.env, openin_any: "p", openout_any: "p", TEXMFOUTPUT: dir } },
          (error, stdout, stderr) => {
            logs.push(stdout + stderr);
            if (!error) { done(); return; }
            const output = stdout + stderr;
            const missing = /File [`']([^`']+\.(?:sty|cls|tex))' not found/.exec(output);
            reject(Error(missing
              ? `模板缺少 ${missing[1]}。请在研究材料的论文模板入口补充该文件，或上传包含依赖的 ZIP。\n\n${output.slice(-1400)}`
              : "LaTeX 编译失败：" + output.slice(-1400)));
          },
        );
      });
  } finally {
    await writeFile(join(dir, "compiler.log"), logs.join("\n"));
  }
  await readFile(join(dir, "main.pdf"));
  const warnings = [
    ...new Set(
      (logs.at(-1) ?? "")
        .split(/\r?\n/)
        .filter((line) => /Overfull|Underfull|LaTeX Warning:/.test(line)),
    ),
  ];
  await writeFile(
    join(dir, "build.json"),
    JSON.stringify({
      id,
      revision: p.revision,
      createdAt: new Date().toISOString(),
      warnings,
    }),
  );
  return { id, revision: p.revision, warnings };
}
