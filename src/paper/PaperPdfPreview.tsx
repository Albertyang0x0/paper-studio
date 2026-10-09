import { useEffect, useRef, useState } from 'react';
import { Download, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { getDocument, GlobalWorkerOptions, TextLayer } from 'pdfjs-dist';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PaperProject } from '../../shared/paper-types';

GlobalWorkerOptions.workerSrc = workerUrl;
type Build = { id: string; url: string; revision: number; warnings: string[] };

function PdfPage({ document, number, width }: { document: PDFDocumentProxy; number: number; width: number }) {
  const container = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null), text = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(number <= 2), [rendered, setRendered] = useState(false), [error, setError] = useState('');
  const [ratio, setRatio] = useState(792 / 612);
  useEffect(() => {
    const observer = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '600px' });
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let stopped = false, task: RenderTask | undefined, layer: TextLayer | undefined;
    setRendered(false); setError('');
    void (async () => {
      const page = await document.getPage(number);
      if (stopped || !canvas.current || !text.current) return;
      const base = page.getViewport({ scale: 1 });
      const scale = width / base.width, viewport = page.getViewport({ scale });
      setRatio(base.height / base.width);
      const outputScale = Math.min(window.devicePixelRatio || 1, 2);
      canvas.current.width = Math.ceil(viewport.width * outputScale);
      canvas.current.height = Math.ceil(viewport.height * outputScale);
      text.current.replaceChildren();
      text.current.style.setProperty('--total-scale-factor', String(scale));
      task = page.render({ canvas: canvas.current, viewport,
        transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0] });
      layer = new TextLayer({ textContentSource: page.streamTextContent(), container: text.current, viewport });
      await Promise.all([task.promise, layer.render()]);
      if (!stopped) setRendered(true);
    })().catch(e => { if (!stopped) setError(e instanceof Error ? e.message : String(e)); });
    return () => { stopped = true; task?.cancel(); layer?.cancel(); };
  }, [document, number, width, visible]);
  return <div className="pw-pdf-sheet" ref={container} data-page={number} data-rendered={rendered} style={{ width }}>
    <div className="pw-pdf-paper" style={{ height: width * ratio }}>
      <canvas ref={canvas} aria-label={`论文第 ${number} 页`} style={{ width, height: width * ratio }} />
      <div ref={text} className="pw-pdf-text" />
      {!rendered && <div className="pw-pdf-page-loading">{error || (visible ? '正在载入页面…' : '')}</div>}
    </div>
    <span className="pw-pdf-page-number">{number} / {document.numPages}</span>
  </div>;
}

export default function PaperPdfPreview({ project, available }: { project: PaperProject; available?: boolean }) {
  const [build, setBuild] = useState<Build>(), [document, setDocument] = useState<PDFDocumentProxy>();
  const [error, setError] = useState(''), [compiling, setCompiling] = useState(true), [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0), [zoom, setZoom] = useState('fit'), [width, setWidth] = useState(600);
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let stopped = false;
    setBuild(undefined); setError(''); setCompiling(true);
    if (available === undefined) return;
    if (!available) { setError('未检测到 LaTeX 编译器，无法按模板预览。'); setCompiling(false); return; }
    // Builds are local, cached, and use only the accepted manuscript. No model requests.
    void fetch(`/api/papers/${project.id}/build`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: project.revision }) })
      .then(async r => { const value = await r.json(); if (!r.ok) throw Error(value.error ?? r.statusText); return value as Build; })
      .then(value => { if (!stopped) setBuild(value); })
      .catch(e => { if (!stopped) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!stopped) setCompiling(false); });
    return () => { stopped = true; };
  }, [project.id, project.revision, available, retry]);
  useEffect(() => {
    setDocument(undefined);
    if (!build) return;
    let stopped = false;
    setLoading(true);
    const task = getDocument({ url: build.url });
    void task.promise.then(pdf => { if (!stopped) setDocument(pdf); })
      .catch(e => { if (!stopped) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!stopped) setLoading(false); });
    return () => { stopped = true; void task.destroy().catch(() => {}); };
  }, [build?.url]);
  useEffect(() => {
    const host = viewport.current;
    if (!host) return;
    const observer = new ResizeObserver(() => setWidth(Math.max(240, Math.min(900, host.clientWidth - 48))));
    observer.observe(host);
    return () => observer.disconnect();
  }, []);
  const pageWidth = zoom === 'fit' ? width : 612 * Number(zoom);
  return <section className="pw-pdf-preview" aria-label="模板 PDF 预览" data-revision={build?.revision}>
    <div className="pw-pdf-toolbar">
      <div className="pw-pdf-meta"><span>{project.template?.name ?? '默认 LaTeX 模板'}</span>
        <small>主稿 v{project.revision}{document ? ` · ${document.numPages} 页` : ''}</small></div>
      <select aria-label="PDF 缩放" value={zoom} onChange={e => setZoom(e.target.value)}>
        <option value="fit">适合宽度</option><option value="1">100%</option><option value="1.5">150%</option><option value="2">200%</option>
      </select>
      <button className="pw-button" disabled={compiling} onClick={() => setRetry(n => n + 1)}><RefreshCw size={14} />刷新</button>
      {build && !compiling && <>
        <a className="pw-button" href={build.url} target="_blank" rel="noreferrer"><ExternalLink size={14} />打开 PDF</a>
        <a className="pw-button" href={`${build.url}?download=1`} download={`paper-${project.id}.pdf`}><Download size={14} />下载</a>
      </>}
    </div>
    {!!build?.warnings.length && <details className="pw-pdf-warnings"><summary>{build.warnings.length} 条编译警告</summary>
      <pre>{build.warnings.join('\n')}</pre></details>}
    <div className="pw-pdf-viewport" ref={viewport}>
      {error ? <div className="pw-pdf-state" role="alert"><strong>模板预览未能完成</strong><pre>{error}</pre>
        <button className="pw-button" onClick={() => setRetry(n => n + 1)}>重试编译</button></div>
        : compiling || loading || !document ? <div className="pw-pdf-state" role="status">
          <Loader2 className="pw-spin" size={20} /><span>{compiling ? '正在按模板编译…' : '正在载入 PDF…'}</span></div>
        : <div className="pw-pdf-pages">{Array.from({ length: document.numPages }, (_, index) =>
          <PdfPage key={`${build?.id}:${index}`} document={document} number={index + 1} width={pageWidth} />)}</div>}
    </div>
  </section>;
}
