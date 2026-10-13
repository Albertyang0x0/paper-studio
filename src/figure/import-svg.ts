import { Color, Ellipse, IText, Path, Point, Rect, util, type FabricObject } from "fabric";
import type { FigureScene, Primitive, PrimitiveClip, SceneImageAsset, SceneModule, SvgShadow } from "../../shared/types";
import { promoteSvgConnectors, type SvgConnectorSource } from "./import-svg-connectors";
import { normalizeSvgDocument } from "./normalize-svg";
import { svgXmlSource } from "./svg-source";
import { markerPoints } from "./svg-marker-points";

type Matrix = [number, number, number, number, number, number];
type Style = Record<string, string>;
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const SVG_NS = "http://www.w3.org/2000/svg";
const MAX_SIZE = 5 * 1024 * 1024;
const MAX_ELEMENTS = 12000;
const NUMBER = "[-+]?(?:\\d*\\.\\d+|\\d+\\.?\\d*)(?:[eE][-+]?\\d+)?";
const numberPattern = new RegExp(NUMBER, "g");
const inherited = new Set(["fill", "stroke", "fill-opacity", "stroke-opacity", "fill-rule", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "font-family", "font-size", "font-weight", "font-style", "text-anchor", "visibility", "color", "dominant-baseline", "alignment-baseline", "letter-spacing", "word-spacing", "marker-start", "marker-mid", "marker-end"]);
inherited.add("clip-rule");
inherited.add("color-interpolation-filters");
inherited.add("paint-order");
inherited.add("white-space");
const supported = new Set([...inherited, "opacity", "display", "stop-color", "stop-opacity", "overflow", "clip-path", "clip-rule", "filter", "background", "shape-inside", "writing-mode", "text-decoration"]);
const ignoredStyle = new Set(["isolation", "enable-background", "shape-rendering", "text-rendering", "color-rendering", "color-interpolation", "color-interpolation-filters", "font-variant", "font-stretch", "line-height", "-inkscape-font-specification"]);
const defaults: Style = { fill: "#000000", stroke: "none", "stroke-width": "1", "fill-opacity": "1", "stroke-opacity": "1", "font-family": "sans-serif", "font-size": "16", "font-weight": "400", "text-anchor": "start", "text-decoration": "none", color: "#000000" };
function fail(message: string): never { throw new Error(`SVG 导入失败：${message}`); }
function finite(value: number, name: string) { if (!Number.isFinite(value) || Math.abs(value) > 1e8) fail(`${name} 超出支持范围。`); return value; }
function numbers(value: string, name: string): number[] {
  const residue = value.replace(numberPattern, "").replace(/[\s,]/g, "");
  if (residue) fail(`${name} 包含无效数字。`);
  return (value.match(numberPattern) ?? []).map(n => finite(Number(n), name));
}
function scalar(value: string | null | undefined, fallback = 0) { if (value == null || value === "") return fallback; const n = numbers(value, "数值"); if (n.length !== 1) fail(`不支持多值属性 ${value}。`); return n[0]; }
function length(value: string | null | undefined, basis: number, font = 16, fallback = 0): number {
  if (value == null || value === "") return fallback;
  const match = value.trim().match(new RegExp(`^(${NUMBER})(%|px|pt|pc|mm|cm|in|em|ex)?$`, "i"));
  if (!match) fail(`暂不支持长度“${value}”。`);
  const unit = match![2]?.toLowerCase() ?? "", scale = ({ "": 1, px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, em: font, ex: font / 2, "%": basis / 100 } as Record<string, number>)[unit];
  return finite(Number(match![1]) * scale, "长度");
}
function mul(a: Matrix, b: Matrix): Matrix { return [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]].map(n => finite(n, "变换")) as Matrix; }
function at(m: Matrix, x: number, y: number) { return { x: m[0]*x+m[2]*y+m[4], y: m[1]*x+m[3]*y+m[5] }; }
function inverse(m:Matrix):Matrix {
  const d=m[0]*m[3]-m[1]*m[2];if(Math.abs(d)<1e-12)fail("箭头变换不可逆。");
  return [m[3]/d,-m[1]/d,-m[2]/d,m[0]/d,(m[2]*m[5]-m[3]*m[4])/d,(m[1]*m[4]-m[0]*m[5])/d];
}
function transform(value: string | null): Matrix {
  if (!value?.trim()) return [...IDENTITY];
  let result = [...IDENTITY] as Matrix, end = 0;
  for (const item of value.matchAll(/([A-Za-z]+)\s*\(([^)]*)\)/g)) {
    if (value.slice(end, item.index).replace(/[\s,]/g, "")) fail("无效的 transform。");
    const n = numbers(item[2], "transform"), name = item[1]; let m: Matrix;
    if (name === "matrix" && n.length === 6) m = n as Matrix;
    else if (name === "translate" && (n.length === 1 || n.length === 2)) m = [1,0,0,1,n[0],n[1]??0];
    else if (name === "scale" && (n.length === 1 || n.length === 2)) m = [n[0],0,0,n[1]??n[0],0,0];
    else if (name === "rotate" && (n.length === 1 || n.length === 3)) { const a = n[0]*Math.PI/180, c = Math.cos(a), s = Math.sin(a); m=[c,s,-s,c,0,0]; if(n.length===3) m=mul(mul([1,0,0,1,n[1],n[2]],m),[1,0,0,1,-n[1],-n[2]]); }
    else if ((name === "skewX" || name === "skewY") && n.length === 1) { const t=Math.tan(n[0]*Math.PI/180); m=name === "skewX" ? [1,0,t,1,0,0] : [1,t,0,1,0,0]; }
    else fail(`暂不支持变换 ${name}。`);
    result=mul(result,m!); end=item.index!+item[0].length;
  }
  if (value.slice(end).trim()) fail("无效的 transform。");
  return result;
}
function opacity(value: string | undefined, fallback = 1) { const n = value?.endsWith("%") ? scalar(value.slice(0,-1))/100 : scalar(value,fallback); return Math.max(0,Math.min(1,n)); }
function paint(value: string, alpha: number, current: string): string {
  if (value === "none") return "none";
  const color = new Color(value === "currentColor" ? current : value);
  if (color.isUnrecognised) fail(`暂不支持颜色“${value}”。`);
  color.setAlpha(color.getAlpha()*alpha);
  return "#" + (color.getAlpha() < 1 ? color.toHexa() : color.toHex());
}
function viewport(viewBox: number[], width: number, height: number, aspect: string | null): Matrix {
  const [x,y,w,h]=viewBox;
  if (w<=0 || h<=0) fail("viewBox 的宽高必须大于 0。");
  if ((aspect??"").trim()==="none") return [width/w,0,0,height/h,-x*width/w,-y*height/h];
  const match=(aspect?.trim()||"xMidYMid meet").match(/^(xMin|xMid|xMax)(YMin|YMid|YMax)(?:\s+(meet|slice))?$/);
  if(!match) fail("暂不支持该 preserveAspectRatio。");
  if(match![3]==="slice") fail("暂不支持会裁切内容的 preserveAspectRatio=slice。");
  const scale=Math.min(width/w,height/h), ax=match![1]==="xMin"?0:match![1]==="xMid"?.5:1, ay=match![2]==="YMin"?0:match![2]==="YMid"?.5:1;
  return [scale,0,0,scale,(width-w*scale)*ax-x*scale,(height-h*scale)*ay-y*scale];
}

/** Convert visible SVG geometry into native editable primitives. Never trust embedded project JSON. */
export async function importSvg(source: string, filename: string): Promise<{ scene: FigureScene; warnings: string[] }> {
  if (source.length > MAX_SIZE || new Blob([source]).size > MAX_SIZE) fail("文件超过 5 MB，请精简后重试。");
  const documentSvg = new DOMParser().parseFromString(svgXmlSource(source), "image/svg+xml");
  if(documentSvg.getElementsByTagName("parsererror").length) fail("文件不是有效的 SVG XML。");
  const root=documentSvg.documentElement;
  if(root.localName!=="svg" || (root.namespaceURI && root.namespaceURI!==SVG_NS)) fail("文件根元素必须是 SVG。");
  const normalizationWarnings = normalizeSvgDocument(root);
  const all=[root,...Array.from(root.querySelectorAll("*"))];
  if(all.length>MAX_ELEMENTS) fail("元素超过 12000 个，请拆分文件。");
  const warnings=new Set<string>(normalizationWarnings), ids=new Map<string,Element>();
  let emptyTextNodes=0;
  const approved=new Set(["svg","g","defs","title","desc","metadata","style","rect","circle","ellipse","line","polyline","polygon","path","text","tspan","linearGradient","stop","marker","clipPath","image","filter","feOffset","feMorphology","feComposite","feColorMatrix"]);
  for(const el of all){
    let depth=0; for(let p=el.parentElement;p;p=p.parentElement) if(++depth>48) fail("分组嵌套超过 48 层。");
    const inMetadata=el.closest("metadata");
    if(!inMetadata && (!approved.has(el.localName) || (el.namespaceURI && el.namespaceURI!==SVG_NS))) fail(`暂不支持 <${el.localName}>；请先在原软件中转换为普通路径或文字。`);
    for(const attribute of Array.from(el.attributes)){
      const name=attribute.localName.toLowerCase(), value=attribute.value;
      if(/^on/.test(name) || (!inMetadata && name==="href" && el.localName!=="image") || /javascript:|@import|@font-face|expression\s*\(/i.test(value)) fail("文件包含事件、外部引用或主动内容，不能导入。");
      for(const url of value.matchAll(/url\s*\(\s*([^)]+)\s*\)/gi)) if(!/^['"]?#[\w:.-]+['"]?$/.test(url[1].trim())) fail("不支持外部图片、字体或网络资源。");
    }
    if(!inMetadata && el.id){ if(ids.has(el.id)) fail(`重复的 SVG id：${el.id}。`); ids.set(el.id,el); }
  }
  const assets: Record<string, SceneImageAsset> = {}, imageAssets = new Map<Element, string>();
  let decodedPixels = 0;
  for (const el of all.filter(node => node.localName === "image" && !node.closest("metadata"))) {
    const href = el.getAttribute("href") ?? el.getAttributeNS("http://www.w3.org/1999/xlink", "href") ?? "";
    const match = href.match(/^data:(image\/(?:png|jpe?g));base64,([A-Za-z0-9+/=\s]+)$/i);
    if (!match) fail("图片仅支持内嵌的 PNG 或 JPEG 数据。");
    let bytes: Uint8Array<ArrayBuffer>;
    try { bytes = Uint8Array.from(atob(match![2].replace(/\s/g, "")), character => character.charCodeAt(0)); }
    catch { fail("图片包含无效的 base64 数据。"); }
    const key = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes!))).map(byte => byte.toString(16).padStart(2, "0")).join("");
    const assetId = "image-" + key;
    if (!assets[assetId]) {
      const mimeType: SceneImageAsset["mimeType"] = match![1].toLowerCase() === "image/png" ? "image/png" : "image/jpeg";
      const dataUrl = `data:${mimeType};base64,${match![2].replace(/\s/g, "")}`;
      const img = new Image(); img.src = dataUrl;
      try { await img.decode(); } catch { fail("内嵌图片无法解码。"); }
      if (!img.naturalWidth || !img.naturalHeight || img.naturalWidth > 8192 || img.naturalHeight > 8192) fail("图片尺寸超出支持范围（单边最多 8192 像素）。");
      decodedPixels += img.naturalWidth * img.naturalHeight;
      if (decodedPixels > 64_000_000) fail("图片解码后的总像素超过 6400 万，请拆分文件。");
      assets[assetId] = { dataUrl, mimeType, width: img.naturalWidth, height: img.naturalHeight };
    }
    imageAssets.set(el, assetId);
  }
  const rules:{selector:string;style:Style;weight:number;order:number}[]=[];
  function declarations(text:string):Style {
    const result:Style={};
    if(/@/i.test(text)) fail("不支持外部 CSS 资源或 CSS 指令。");
    for(const url of text.matchAll(/url\s*\(\s*([^)]+)\s*\)/gi)) if(!/^['"]?#[\w:.-]+['"]?$/.test(url[1].trim())) fail("不支持外部 CSS 资源。");
    for(const entry of text.split(";")){
      if(!entry.trim())continue;
      const colon=entry.indexOf(":"); if(colon<0) fail("无效的 SVG 样式。");
      const key=entry.slice(0,colon).trim().toLowerCase(),value=entry.slice(colon+1).trim();
      if(/!important/i.test(value)) fail("暂不支持 !important 样式，请先展开为元素属性。");
      if(supported.has(key)) result[key]=value;
      else if(ignoredStyle.has(key)){ if((key==="font-variant"||key==="font-stretch")&&value!=="normal")fail(`暂不支持 ${key}=${value}。`); }
      else if(key==="text-align" && ["start","left"].includes(value)) continue;
      else if(value!=="none" && value!=="normal" && value!=="auto") fail(`暂不支持样式 ${key}；请先转换为普通路径或文字。`);
    }
    return result;
  }
  for(const sheet of all.filter(e=>e.localName==="style"&&!e.closest("metadata"))){
    const css=(sheet.textContent??"").replace(/\/\*[\s\S]*?\*\//g,"");
    let end=0;
    for(const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)){
      if(css.slice(end,rule.index).trim())fail("暂不支持嵌套 CSS 规则。");
      const style=declarations(rule[2]);
      for(const selector of rule[1].split(",").map(v=>v.trim())){
        if(!/^(?:\*|[\w-]+)?(?:[.#][\w-]+)*$/.test(selector)||!selector) fail(`暂不支持 CSS 选择器 ${selector}；请展开为元素属性。`);
        rules.push({selector,style,weight:(selector.match(/#/g)?.length??0)*100+(selector.match(/\./g)?.length??0)*10+(/^[A-Za-z]/.test(selector)?1:0),order:rules.length});
      }
      end=rule.index!+rule[0].length;
    }
    if(css.slice(end).trim())fail("无效或暂不支持的 SVG 样式表。");
  }
  function styleOf(el:Element,parent:Style):Style {
    const result:Style={...defaults}; for(const [key,value] of Object.entries(parent))if(inherited.has(key))result[key]=value;
    for(const key of supported)if(el.hasAttribute(key))result[key]=el.getAttribute(key)!.trim();
    for(const key of ["mask","vector-effect","pathLength"]){const v=el.getAttribute(key);if(v&&v!=="none")fail(`暂不支持 ${key}；请先在原软件中展开效果。`);}
    for(const [key,allowed] of Object.entries({direction:["ltr"],"unicode-bidi":["normal"],"mix-blend-mode":["normal"]})){
      const v=el.getAttribute(key);if(v&&!allowed.includes(v))fail(`暂不支持 ${key}=${v}。`);
    }
    for(const key of ["baseline-shift","font-variant","font-stretch"]){const v=el.getAttribute(key);if(v&&!["none","normal","0","baseline"].includes(v))fail(`暂不支持 ${key}=${v}。`);}
    for(const rule of rules.filter(r=>el.matches(r.selector)).sort((a,b)=>a.weight-b.weight||a.order-b.order))Object.assign(result,rule.style);
    Object.assign(result,declarations(el.getAttribute("style")??""));
    for(const [key,value] of Object.entries(result)) if(value==="inherit")result[key]=parent[key]??defaults[key]??"";
    if(!["none","underline"].includes(result["text-decoration"]))fail(`暂不支持 text-decoration=${result["text-decoration"]}；当前支持普通文字和下划线。`);
    // Decorations propagate through the text subtree independently of CSS
    // inheritance: a child's `none` does not erase an ancestor's underline.
    result["svg-underline"]=parent["svg-underline"]==="true"||result["text-decoration"]==="underline"?"true":"false";
    result["font-size"]=String(length(result["font-size"],Number(parent["font-size"])||16,Number(parent["font-size"])||16,16));
    if(Number(result["font-size"])<0||Number(result["font-size"])>10000)fail("字号超出支持范围。");
    if(result["letter-spacing"]&&result["letter-spacing"]!=="normal")result["letter-spacing"]=String(length(result["letter-spacing"],Number(result["font-size"]),Number(result["font-size"])));
    if(result["writing-mode"] && !["lr","lr-tb","horizontal-tb"].includes(result["writing-mode"]))fail("暂不支持竖排文字。");
    if(result["white-space"] && !["normal","pre"].includes(result["white-space"]))fail("暂不支持自动换行文字，请先转换为定位 tspan。");
    return result;
  }
  const vb=root.hasAttribute("viewBox")?numbers(root.getAttribute("viewBox")!,"viewBox"):undefined;
  if(vb&&vb.length!==4)fail("viewBox 必须含四个数字。");
  const width=length(root.getAttribute("width"),vb?.[2]??300,16,vb?.[2]??300),height=length(root.getAttribute("height"),vb?.[3]??150,16,vb?.[3]??150);
  if(width<=0||height<=0||width>20000||height>20000)fail("画布宽高必须在 0 到 20000 像素之间。");
  const basisX=vb?.[2]??width,basisY=vb?.[3]??height,diagonal=Math.hypot(basisX,basisY)/Math.SQRT2;
  let sequence=0; const primitives:Primitive[]=[], owners=new Map<Primitive,Element|undefined>();
  const connectorSources=new Map<Element,SvgConnectorSource>();
  function connectorSource(el:Element){
    const group=el.closest("g[data-connector-id]");if(!group||group.closest("defs,metadata"))return;
    let source=connectorSources.get(group);if(!source){source={element:group,paths:[],labels:[]};connectorSources.set(group,source);}return source;
  }
  const nonDrawing=new Set(["title","desc","metadata","defs","style","linearGradient","stop","marker","clipPath","filter","feOffset","feMorphology","feComposite","feColorMatrix"]);
  const explicitGroups=all.filter(el=>el.localName==="g"&&el.hasAttribute("data-module-id")&&!el.closest("defs,metadata"));
  // A sole outer group is commonly an editor's document wrapper, not one module.
  // Keep its transforms in visit(), but use its child groups as editing boundaries.
  let groupRoot:Element=root;
  if(!explicitGroups.length){
    for(;;){
      const children=Array.from(groupRoot.children).filter(el=>!nonDrawing.has(el.localName));
      if(children.length!==1||children[0].localName!=="g")break;
      const candidate=children[0],nestedGroups=Array.from(candidate.children).some(el=>el.localName==="g");
      const named=candidate.hasAttribute("aria-label")||candidate.hasAttribute("inkscape:label")||Array.from(candidate.children).some(el=>el.localName==="title"&&el.textContent?.trim());
      if(!nestedGroups||named)break;
      groupRoot=candidate;
    }
  }
  const moduleGroups=new Set(explicitGroups.length?explicitGroups:Array.from(groupRoot.children).filter(el=>el.localName==="g"&&!el.hasAttribute("data-connector-id")&&!el.hasAttribute("data-region-id")));
  function addPrimitive(primitive:Primitive,owner?:Element){
    primitives.push(primitive);owners.set(primitive,owner);
    if(sequence>16000 || primitives.length>8000)fail("可编辑对象过多，请拆分文件。");
  }
  const unique=(el:Element,suffix="")=>`svg-${(++sequence).toString(36)}-${((el.closest("g[data-connector-id]")?.getAttribute("data-connector-id")??"")+"-"+(el.getAttribute("data-object-id")||el.id||el.localName)).replace(/[^\w.-]/g,"-").slice(0,100)}${suffix}`;
  const styleRoot=styleOf(root,defaults);
  const definitionStyles=new Map<Element,Style>([[root,styleRoot]]);
  function definitionStyle(el:Element):Style {
    const cached=definitionStyles.get(el);if(cached)return cached;
    const result=styleOf(el,el.parentElement?definitionStyle(el.parentElement):defaults);
    definitionStyles.set(el,result);return result;
  }
  const textCanvas=document.createElement("canvas"),measure=textCanvas.getContext("2d");
  function preservesSpaces(el: Element) {
    for (let node: Element | null = el; node; node = node.parentElement) {
      const value = node.getAttributeNS("http://www.w3.org/XML/1998/namespace", "space");
      if (value) return value === "preserve";
    }
    return false;
  }
  function letterSpacing(s:Style){return !s["letter-spacing"]||s["letter-spacing"]==="normal"?0:length(s["letter-spacing"],Number(s["font-size"]),Number(s["font-size"]));}
  function textWidth(text:string,s:Style){if(!measure)fail("当前浏览器不支持文字测量。");measure!.font=`${s["font-style"]??"normal"} ${s["font-weight"]} ${s["font-size"]}px ${s["font-family"]}`;return measure!.measureText(text).width+Math.max(0,Array.from(text).length-1)*letterSpacing(s);}
  function localPath(el:Element):string {
    const n=(name:string,basis=diagonal,fallback=0)=>length(el.getAttribute(name),basis,16,fallback);
    if(el.localName==="path")return el.getAttribute("d")??"";
    if(el.localName==="line")return `M${n("x1",basisX)} ${n("y1",basisY)}L${n("x2",basisX)} ${n("y2",basisY)}`;
    if(el.localName==="polygon"||el.localName==="polyline"){
      const p=numbers(el.getAttribute("points")??"","points");if(p.length<4||p.length%2)fail("多边形 points 必须包含完整的坐标对。");return `M${p[0]} ${p[1]}`+p.slice(2).reduce((v,x,i)=>v+(i%2?` ${x}`:`L${x}`),"")+(el.localName==="polygon"?"Z":"");
    }
    if(el.localName==="rect"){
      const x=n("x",basisX),y=n("y",basisY),w=n("width",basisX),h=n("height",basisY);if(w<0||h<0)fail("矩形宽高不能为负。");
      let rx=n("rx",basisX,n("ry",basisY)),ry=n("ry",basisY,rx);rx=Math.min(Math.max(rx,0),w/2);ry=Math.min(Math.max(ry,0),h/2);
      return rx&&ry?`M${x+rx} ${y}H${x+w-rx}A${rx} ${ry} 0 0 1 ${x+w} ${y+ry}V${y+h-ry}A${rx} ${ry} 0 0 1 ${x+w-rx} ${y+h}H${x+rx}A${rx} ${ry} 0 0 1 ${x} ${y+h-ry}V${y+ry}A${rx} ${ry} 0 0 1 ${x+rx} ${y}Z`:`M${x} ${y}H${x+w}V${y+h}H${x}Z`;
    }
    const cx=n("cx",basisX),cy=n("cy",basisY),rx=el.localName==="circle"?n("r"):n("rx",basisX),ry=el.localName==="circle"?rx:n("ry",basisY);
    if(rx<0||ry<0)fail("圆或椭圆的半径不能为负。");return `M${cx-rx} ${cy}A${rx} ${ry} 0 1 0 ${cx+rx} ${cy}A${rx} ${ry} 0 1 0 ${cx-rx} ${cy}Z`;
  }
  function parsedPath(d:string){
    if(d.length>250000)fail("单一路径过长，请简化路径。");
    if(d.replace(new RegExp(`[MmZzLlHhVvCcSsQqTtAa]|${NUMBER}|[\\s,]`,"g"),""))fail("路径包含无效指令。");
    if(!/^\s*[Mm]/.test(d))fail("路径必须以 M 指令开始。");
    // Fabric's permissive parser drops empty commands and malformed arc tails.
    // Validate every command's full argument list before using its geometry.
    const parameter=`\\s*,?\\s*(?:${NUMBER})`,arity:Record<string,number>={m:2,l:2,h:1,v:1,c:6,s:4,q:4,t:2};
    for(const command of d.matchAll(/([MmZzLlHhVvCcSsQqTtAa])([^MmZzLlHhVvCcSsQqTtAa]*)/g)){
      const name=command[1].toLowerCase(),args=command[2];
      const group=name==="a"?`${parameter}${parameter}${parameter}\\s*,?\\s*[01]\\s*,?\\s*[01]${parameter}${parameter}`:parameter.repeat(arity[name]??0);
      if(name==="z"?args.trim().length>0:!new RegExp(`^(?:${group})+\\s*$`).test(args))fail(`路径 ${command[1]} 指令的参数不完整或无效。`);
    }
    const parsed=util.parsePath(d);
    if(!parsed.length||!/^m$/i.test(String(parsed[0][0])))fail("路径必须以 M 指令开始。");
    if(parsed.some(command=>command.slice(1).some(v=>typeof v!=="number"||!Number.isFinite(v)||Math.abs(v)>1e8)))fail("路径坐标无效或超出支持范围。");
    const simplified=util.makePathSimpler(parsed);
    if(simplified.some(command=>command.slice(1).some(v=>typeof v!=="number"||!Number.isFinite(v)||Math.abs(v)>1e8)))fail("路径转换结果超出支持范围。");
    return simplified;
  }
  function gradient(value:string,el:Element,m:Matrix,bounds:{left:number;top:number;width:number;height:number},fillAlpha:number):Primitive["gradient"] {
    const match=value.match(/^url\(\s*['"]?#([\w:.-]+)['"]?\s*\)$/);if(!match)fail(`不支持填充 ${value}。`);
    const def=ids.get(match![1]);if(!def||def.localName!=="linearGradient")fail("只支持本地 linearGradient 线性渐变。");
    if(def.getAttribute("spreadMethod")&&!['pad'].includes(def.getAttribute("spreadMethod")!))fail("暂不支持重复或反射渐变。");
    const units=def.getAttribute("gradientUnits")??"objectBoundingBox";
    let gm:Matrix;
    const get=(name:string,basis:number,fallback:string)=>length(def.getAttribute(name)??fallback,basis);
    let x1:number,y1:number,x2:number,y2:number;
    if(units==="objectBoundingBox"){
      const path=new Path(localPath(el),{strokeWidth:0}),bw=path.width,bh=path.height;
      if(bw<=0||bh<=0)fail("零面积图形不支持渐变。");
      gm=mul(m,mul([bw,0,0,bh,path.left,path.top],transform(def.getAttribute("gradientTransform"))));
      x1=get("x1",1,"0");y1=get("y1",1,"0");x2=get("x2",1,"1");y2=get("y2",1,"0");
    }else if(units==="userSpaceOnUse") {gm=mul(m,transform(def.getAttribute("gradientTransform")));x1=get("x1",basisX,"0");y1=get("y1",basisY,"0");x2=get("x2",basisX,"100%");y2=get("y2",basisY,"0");}
    else fail(`不支持 gradientUnits=${units}。`);
    const start=at(gm!,x1!,y1!),vx=x2!-x1!,vy=y2!-y1!,det=gm![0]*gm![3]-gm![1]*gm![2];
    if(Math.abs(det)<1e-12)fail("渐变变换不可逆。");
    // Convert the gradient's covector into the target object's normalized box.
    // Transforming endpoints alone would distort diagonal gradients on non-square boxes.
    const nx=(gm![3]*vx-gm![1]*vy)/det*(bounds.width||1),ny=(-gm![2]*vx+gm![0]*vy)/det*(bounds.height||1),den=nx*nx+ny*ny,delta=den?(vx*vx+vy*vy)/den:0;
    const stops=Array.from(def.children).filter(e=>e.localName==="stop").map(stop=>{
      const s=definitionStyle(stop),offset=opacity(stop.getAttribute("offset")??"0",0),color=paint(s["stop-color"]??"#000000",1,s.color),alpha=opacity(s["stop-opacity"])*fillAlpha;
      return {offset,color,opacity:alpha};
    });
    if(!stops.length)fail("线性渐变没有色标。");
    if(stops.some((s,i)=>i>0&&s.offset<stops[i-1].offset))fail("渐变色标必须按位置排序。");
    const x1n=(start.x-bounds.left)/(bounds.width||1),y1n=(start.y-bounds.top)/(bounds.height||1);
    return {type:"linear",x1:x1n,y1:y1n,x2:x1n+nx*delta,y2:y1n+ny*delta,stops};
  }
  function appearance(el:Element,s:Style,m:Matrix,alpha:number):Partial<Primitive>{
    const sx=Math.hypot(m[0],m[1]),sy=Math.hypot(m[2],m[3]),strokeScale=Math.sqrt(Math.abs(m[0]*m[3]-m[1]*m[2]));
    if(s.stroke!=="none"&&length(s["stroke-width"],diagonal)>0&&(Math.abs(sx-sy)>1e-6||Math.abs(m[0]*m[2]+m[1]*m[3])>1e-6))fail("带描边图形的非等比缩放或倾斜暂不能无损导入；请先在原软件中将描边转换为轮廓。");
    const fillRule=s["fill-rule"]??"nonzero",cap=s["stroke-linecap"]??"butt",join=s["stroke-linejoin"]??"miter";
    if(!["nonzero","evenodd"].includes(fillRule)||!["butt","round","square"].includes(cap)||!["miter","round","bevel"].includes(join))fail("暂不支持该填充或描边规则。");
    const dash=s["stroke-dasharray"]&&s["stroke-dasharray"]!=="none"?numbers(s["stroke-dasharray"],"stroke-dasharray").map(n=>n*strokeScale):undefined;
    if(dash?.some(n=>n<0))fail("虚线长度不能为负。");
    const result:Partial<Primitive>={fill:s.fill.startsWith("url(")?"none":paint(s.fill,opacity(s["fill-opacity"]),s.color),stroke:paint(s.stroke,opacity(s["stroke-opacity"]),s.color),strokeWidth:length(s["stroke-width"],diagonal)*strokeScale,opacity:alpha,fillRule:fillRule as Primitive["fillRule"],strokeLineCap:cap as Primitive["strokeLineCap"],strokeLineJoin:join as Primitive["strokeLineJoin"],strokeMiterLimit:scalar(s["stroke-miterlimit"],4),strokeDashOffset:length(s["stroke-dashoffset"],diagonal)*strokeScale,dash};
    const order=s["paint-order"]&&s["paint-order"]!=="normal"?s["paint-order"].split(/\s+/):[];
    if(new Set(order).size!==order.length||order.some(part=>!["fill","stroke","markers"].includes(part)))fail("无效的 paint-order。");
    for(const part of ["fill","stroke","markers"])if(!order.includes(part))order.push(part);
    if(order.indexOf("markers")<2&&["start","mid","end"].some(side=>s[`marker-${side}`]&&s[`marker-${side}`]!=="none"))fail("暂不支持先于填充或描边绘制的 marker，请先展开箭头。");
    if(order.indexOf("stroke")<order.indexOf("fill"))result.paintOrder="stroke fill";
    if(result.strokeWidth!<0||result.strokeMiterLimit!<1)fail("描边宽度或斜接限制无效。");
    return result;
  }
  function addText(el:Element,s:Style,m:Matrix,alpha:number,owner?:Element){
    if(el.textContent==="")return;
    if(s.fill.startsWith("url("))fail("暂不支持渐变文字，请改为纯色文字。");
    if(s["word-spacing"]&&s["word-spacing"]!=="normal"&&length(s["word-spacing"],1)!==0)fail("暂不支持非零 word-spacing，请先展开文字间距。");
    for(const key of ["dominant-baseline","alignment-baseline"]){if(s[key]&&!["auto","alphabetic","baseline"].includes(s[key]))fail(`暂不支持文字 ${key}=${s[key]}。`);}
    const sx=Math.hypot(m[0],m[1]),sy=Math.hypot(m[2],m[3]);
    if(sx<1e-8||sy<1e-8)return;
    if(m[0]*m[3]-m[1]*m[2]<=0||Math.abs(m[0]*m[2]+m[1]*m[3])>1e-6*sx*sy)fail("暂不支持倾斜或镜像文字，请在原软件中取消该变换。");
    const rootFont=Number(s["font-size"]),cursor={x:length(el.getAttribute("x"),basisX,rootFont),y:length(el.getAttribute("y"),basisY,rootFont)};
    cursor.x+=length(el.getAttribute("dx"),basisX,rootFont);cursor.y+=length(el.getAttribute("dy"),basisY,rootFont);
    const runs:{text:string;x:number;y:number;style:Style;chunk:number;preserve:boolean}[]=[];
    let chunk=0;
    const flowed=s["shape-inside"]&&s["shape-inside"]!=="none";
    function walkText(node:Element,st:Style,top=false,positionedX=false,positionedY=false){
      const font=Number(st["font-size"]);
      positionedX ||= node.hasAttribute("x"); positionedY ||= node.hasAttribute("y");
      if(!top){
        if(node.hasAttribute("transform")||node.hasAttribute("rotate"))fail("暂不支持单个 tspan 的旋转或变换。");
        if(node.hasAttribute("textLength"))fail("暂只支持单个 text 对象的 textLength，请先合并分段文字。");
        if(node.hasAttribute("x")||node.hasAttribute("y"))chunk++;
        if(node.hasAttribute("x"))cursor.x=length(node.getAttribute("x"),basisX,font);
        if(node.hasAttribute("y"))cursor.y=length(node.getAttribute("y"),basisY,font);
        cursor.x+=length(node.getAttribute("dx"),basisX,font);cursor.y+=length(node.getAttribute("dy"),basisY,font);
      }
      for(const child of Array.from(node.childNodes)){
        if(child.nodeType===3||child.nodeType===4){
          const preserve=st["white-space"]==="pre"||preservesSpaces(node);
          if(st["white-space"]==="pre"&&/\S[^\r\n]*[\r\n]+[\s\S]*\S/.test(child.textContent??""))fail("暂不支持未定位的预格式多行文字；请转换为具有 x/y 坐标的 tspan。");
          const text=(child.textContent??"").replace(preserve?/[\t\n\r]/g:/[\t\n\r ]+/g," ");
          if(!text)continue;
          if(flowed&&text.trim()&&(!positionedX||!positionedY))fail("流式文字没有已定位的 tspan，暂不能还原自动换行；请在原软件中转换为普通文字。");
          if(st.visibility!=="hidden"&&st.visibility!=="collapse")runs.push({text,x:cursor.x,y:cursor.y,style:st,chunk,preserve});
          cursor.x+=textWidth(text,st);
        }
        else if(child.nodeType===1){
          const span=child as Element;if(span.localName!=="tspan")fail(`暂不支持文字内的 <${span.localName}>。`);
          // With no characters, positioning and baseline attributes have no
          // glyph to affect. Do not discard whitespace: it can carry advance,
          // especially under xml:space="preserve". Input safety was checked
          // for every original element before reaching this rendering pass.
          if(span.textContent===""){emptyTextNodes++;continue;}
          const spanStyle=styleOf(span,st);if(spanStyle.display==="none")continue;
          // SVG decorations keep the declaring text's paint/font metrics. A
          // native underline can represent uniform runs, but not a decoration
          // with a different color or thickness than the child glyphs.
          if(st["svg-underline"]==="true"&&["fill","fill-opacity","stroke","stroke-opacity","stroke-width","color","font-size","font-family","font-weight","font-style"].some(key=>spanStyle[key]!==st[key]))fail("暂不支持下划线文字内混合不同颜色或字体，请将这些文字分别定位或将下划线转为路径。");
          if(opacity(spanStyle.opacity)!==1)fail("暂不支持单个 tspan 的透明度，请改用文字填充透明度。");for(const key of ["word-spacing","dominant-baseline","alignment-baseline"]){if(spanStyle[key]!==st[key])fail(`暂不支持 tspan 内单独设置 ${key}。`);}walkText(span,spanStyle,false,positionedX,positionedY);
        }
      }
    }
    if(el.hasAttribute("rotate"))fail("暂不支持逐字旋转文字。");
    walkText(el,s,true);
    if(flowed)warnings.add("Inkscape 流式文字已使用 SVG 内已定位的 tspan 导入；不重新计算自动换行。");
    // XML indentation is not visible leading/trailing text. Collapse adjacent
    // whitespace across styled runs while preserving explicit xml:space/pre.
    for(const id of new Set(runs.map(run=>run.chunk))){
      const group=runs.filter(run=>run.chunk===id);let removed=0,space=false,contentSeen=false;
      const lastContent=group.reduce((last,run,index)=>run.preserve||run.text.trim()?index:last,-1);
      for(const [index,run] of group.entries()){
        run.x-=removed;
        if(!run.preserve){
          let value=run.text;
          if(!contentSeen||space)value=value.replace(/^ +/,"");
          if(index>=lastContent)value=value.replace(/ +$/,"");
          removed+=textWidth(run.text,run.style)-textWidth(value,run.style);run.text=value;
        }
        if(run.text){space=run.text.endsWith(" ");contentSeen=true;}
      }
    }
    for(let index=runs.length-1;index>=0;index--)if(!runs[index].text)runs.splice(index,1);
    // Anchor a continuous text chunk once, including styled tspans in that chunk.
    for(const id of new Set(runs.map(run=>run.chunk))){
      const group=runs.filter(run=>run.chunk===id);if(group.length<2)continue;
      const anchor=group[0].style["text-anchor"],end=group.at(-1)!;
      const advance=end.x+textWidth(end.text,end.style)-group[0].x;
      const shift=anchor==="middle"?advance/2:anchor==="end"?advance:0;
      for(const run of group){run.x-=shift;run.style={...run.style,"text-anchor":"start"};}
    }
    // Recombine the regular multiline tspans produced by our SVG exporter.
    const combined=runs.length>1&&runs.every((r,i)=>JSON.stringify(r.style)===JSON.stringify(runs[0].style)&&Math.abs(r.x-runs[0].x)<1e-5&&Math.abs(r.y-runs[0].y-i*Number(r.style["font-size"])*1.24)<1e-4);
    const content=combined?[{...runs[0],text:runs.map(r=>r.text).join("\n")}]:runs;
    if(el.hasAttribute("textLength")&&(content.length!==1||content[0].text.includes("\n")))fail("暂只支持单行单对象的 textLength，请先合并分段文字。");
    for(const run of content){
      if(run.style.fill.startsWith("url("))fail("暂不支持渐变文字，请改为纯色文字。");
      if(!["normal","italic","oblique"].includes(run.style["font-style"]??"normal"))fail(`暂不支持 font-style=${run.style["font-style"]}。`);
      const font=Number(run.style["font-size"]),anchor=run.style["text-anchor"];
      let w=Math.max(...run.text.split("\n").map(t=>textWidth(t,run.style)),0),glyphScale=1,spacing=letterSpacing(run.style);
      if(!font)continue;
      if(!["start","middle","end"].includes(anchor))fail(`暂不支持 text-anchor=${anchor}。`);
      if(el.hasAttribute("textLength")){
        const target=length(el.getAttribute("textLength"),basisX,font),adjust=el.getAttribute("lengthAdjust")??"spacing";
        if(target<=0||w<=0)fail("textLength 必须大于 0。");
        if(adjust==="spacingAndGlyphs")glyphScale=target/w;
        else if(adjust==="spacing"){
          const gaps=Array.from(run.text).length-1;
          if(gaps>0){spacing+=(target-w)/gaps;w=target;}
        }else fail(`暂不支持 lengthAdjust=${adjust}。`);
      }
      const position=at(m,run.x-(anchor==="middle"?w*glyphScale/2:anchor==="end"?w*glyphScale:0),run.y-.92*font);
      const weight=run.style["font-weight"]==="normal"?400:run.style["font-weight"]==="bold"?700:scalar(run.style["font-weight"],400);
      const p:Primitive={id:unique(el),type:"text",x:position.x,y:position.y,text:run.text,width:w,height:font*1.24*run.text.split("\n").length,fontSize:font,fontFamily:run.style["font-family"],fontWeight:weight,italic:run.style["font-style"]==="italic"||run.style["font-style"]==="oblique",align:anchor==="middle"?"center":anchor==="end"?"right":"left",...appearance(el,run.style,IDENTITY,alpha),...(spacing?{letterSpacing:spacing}:{}),...(run.style["svg-underline"]==="true"?{underline:true}:{}),rotation:Math.atan2(m[1],m[0])*180/Math.PI,scaleX:sx*glyphScale,scaleY:sy};
      if(p.underline&&p.stroke!=="none"&&(p.strokeWidth??0)>0)fail("暂不支持带描边的文字下划线，请将描边效果转为路径。");
      addPrimitive(p,owner);
    }
  }
  let markerDepth=0,markerViewport:{inverse:Matrix;width:number;height:number}|undefined;
  function marker(el:Element,s:Style,m:Matrix,d:string,alpha:number,owner?:Element){
    if(!["start","mid","end"].some(side=>s[`marker-${side}`]&&s[`marker-${side}`]!=="none"))return;
    for(const p of markerPoints(parsedPath(d))){
      const side=p.side;
      const value=s[`marker-${side}`];if(!value||value==="none")continue;
      const match=value.match(/^url\(\s*['"]?#([\w:.-]+)['"]?\s*\)$/),def=match?ids.get(match[1]):undefined;
      if(!def||def.localName!=="marker")fail("箭头标记引用无效。");
      if(markerDepth)fail("不支持嵌套 marker。");
      if(alpha!==1)fail("带箭头对象的整体透明度暂不能无损导入，请改用填充或描边颜色透明度。");
      const orient=def.getAttribute("orient")??"0";let angle=orient==="auto"||orient==="auto-start-reverse"?p.angle:scalar(orient)*Math.PI/180;
      if(orient==="auto-start-reverse"&&side==="start")angle+=Math.PI;
      const unit=def.getAttribute("markerUnits")??"strokeWidth";if(!["strokeWidth","userSpaceOnUse"].includes(unit))fail("不支持该 markerUnits。");
      const scale=unit==="strokeWidth"?length(s["stroke-width"],diagonal):1,mw=length(def.getAttribute("markerWidth"),basisX,16,3),mh=length(def.getAttribute("markerHeight"),basisY,16,3);
      if(mw<0||mh<0)fail("marker 宽高不能为负。");
      if(mw===0||mh===0||scale===0)continue;
      const box=def.hasAttribute("viewBox")?numbers(def.getAttribute("viewBox")!,"marker viewBox"):[0,0,mw,mh];if(box.length!==4)fail("marker viewBox 无效。");
      const vm=viewport(box,mw,mh,def.getAttribute("preserveAspectRatio")),ref=at(vm,length(def.getAttribute("refX"),box[2]),length(def.getAttribute("refY"),box[3]));
      const c=Math.cos(angle)*scale,si=Math.sin(angle)*scale,placement=mul(m,mul([c,si,-si,c,p.x,p.y],[1,0,0,1,-ref.x,-ref.y])),mm=mul(placement,vm);
      markerDepth++;const st=definitionStyle(def);
      if(opacity(st.opacity)!==1)fail("暂不支持 marker 的整体透明度。");
      if(st.overflow&&!["visible","hidden","auto","scroll"].includes(st.overflow))fail(`暂不支持 marker overflow=${st.overflow}。`);
      markerViewport=st.overflow==="visible"?undefined:{inverse:inverse(placement),width:mw,height:mh};
      for(const child of Array.from(def.children))visit(child,st,mm,alpha,owner);
      markerViewport=undefined;markerDepth--;
    }
  }
  function localReference(value: string, tag: string): Element {
    const match = value.match(/^url\(\s*['"]?#([\w:.-]+)['"]?\s*\)$/);
    const node = match ? ids.get(match[1]) : undefined;
    if (!node || node.localName !== tag) fail(`${tag} 引用无效。`);
    return node!;
  }
  function clipPaths(value: string, matrix: Matrix): PrimitiveClip[] {
    const definition = localReference(value, "clipPath");
    if ((definition.getAttribute("clipPathUnits") ?? "userSpaceOnUse") !== "userSpaceOnUse") fail("暂只支持 userSpaceOnUse 裁剪坐标。");
    const parts: { path: string; rule: string }[] = [];
    function collect(node: Element, parent: Style, parentMatrix: Matrix) {
      const style = styleOf(node, parent), m = mul(parentMatrix, transform(node.getAttribute("transform")));
      if (style.display === "none") return;
      if (node.localName === "g" || node.localName === "clipPath") {
        for (const child of Array.from(node.children)) collect(child, style, m);
      } else if (["path", "rect", "circle", "ellipse", "polygon", "polyline"].includes(node.localName)) {
        if (style.visibility === "hidden" || style.visibility === "collapse") return;
        parts.push({ path: util.joinPath(util.transformPath(parsedPath(localPath(node)), m, new Point(0, 0)), 8), rule: style["clip-rule"] ?? "nonzero" });
      } else fail(`裁剪中暂不支持 <${node.localName}>。`);
    }
    collect(definition, defaults, matrix);
    // A compound path can represent one clip contour, not arbitrary unions with conflicting winding.
    if (parts.length !== 1 || !["nonzero", "evenodd"].includes(parts[0].rule)) fail("暂只支持含一个形状的裁剪定义。");
    return [{ path: parts[0].path, fillRule: parts[0].rule as PrimitiveClip["fillRule"] }];
  }
  function shadow(value: string, matrix: Matrix, children: Primitive[]): SvgShadow {
    const definition = localReference(value, "filter"), nodes = Array.from(definition.children);
    const tags = nodes.map(node => node.localName).join(",");
    const knockout = tags === "feMorphology,feOffset,feComposite,feColorMatrix";
    if (!knockout && tags !== "feOffset,feColorMatrix") fail("暂不支持该滤镜组合；支持偏移着色阴影及扩边扣除阴影。");
    if (Math.abs(matrix[1]) > 1e-8 || Math.abs(matrix[2]) > 1e-8 || Math.abs(matrix[0]) < 1e-8 || Math.abs(Math.abs(matrix[0]) - Math.abs(matrix[3])) > 1e-8) fail("暂不支持阴影滤镜的旋转或非等比变换。");
    const morphology = knockout ? nodes[0] : undefined, offset = nodes[knockout ? 1 : 0], composite = knockout ? nodes[2] : undefined, colorNode = nodes.at(-1)!;
    const output = (node: Element) => node.getAttribute("result") ?? "";
    if ((morphology && (morphology.getAttribute("operator") !== "dilate" || morphology.getAttribute("in") !== "SourceAlpha")) ||
        offset.getAttribute("in") !== (morphology ? output(morphology) : "SourceAlpha") ||
        (composite && (composite.getAttribute("operator") !== "out" || composite.getAttribute("in2") !== "SourceAlpha" || composite.getAttribute("in") !== output(offset))) ||
        colorNode.getAttribute("in") !== output(composite ?? offset)) fail("阴影滤镜输入连接不受支持。");
    if ((colorNode.getAttribute("type") ?? "matrix") !== "matrix") fail("只支持矩阵形式的阴影着色。");
    const values = numbers(colorNode.getAttribute("values") ?? "", "阴影颜色矩阵");
    if (values.length !== 20 || [0,1,2,3,5,6,7,8,10,11,12,13,15,16,17,19].some(i => values[i] !== 0) || [4,9,14,18].some(i => values[i] < 0 || values[i] > 1)) fail("暂不支持该阴影颜色矩阵。");
    if ((definition.getAttribute("primitiveUnits") ?? "userSpaceOnUse") !== "userSpaceOnUse") fail("暂只支持用户坐标的阴影滤镜操作。");
    if ([definition, ...nodes].some(node => (definitionStyle(node)["color-interpolation-filters"] ?? "linearRGB") !== "linearRGB")) fail("暂只支持 linearRGB 阴影滤镜。");
    const boxes = children.map(child => boundsOf(child, true));
    const bounds = { x: Math.min(...boxes.map(b => b.left)), y: Math.min(...boxes.map(b => b.top)), width: 0, height: 0 };
    bounds.width = Math.max(...boxes.map(b => b.right)) - bounds.x; bounds.height = Math.max(...boxes.map(b => b.bottom)) - bounds.y;
    const units = definition.getAttribute("filterUnits") ?? "objectBoundingBox";
    if (!["objectBoundingBox", "userSpaceOnUse"].includes(units)) fail("不支持该 filterUnits。");
    const part = (name: string, basis: number, fallback: string) => {
      const raw = definition.getAttribute(name) ?? fallback;
      return units === "objectBoundingBox" ? (raw.endsWith("%") ? scalar(raw.slice(0, -1)) / 100 : scalar(raw)) * basis : length(raw, name === "x" || name === "width" ? basisX : basisY);
    };
    const rx = part("x", bounds.width, "-10%"), ry = part("y", bounds.height, "-10%");
    const rw = part("width", bounds.width, "120%"), rh = part("height", bounds.height, "120%");
    if (rw <= 0 || rh <= 0) fail("阴影滤镜区域的宽高必须大于 0。");
    const region = {
      x: units === "objectBoundingBox" ? bounds.x + (matrix[0] < 0 ? bounds.width - rx - rw : rx) : matrix[4] + matrix[0] * (rx + (matrix[0] < 0 ? rw : 0)),
      y: units === "objectBoundingBox" ? bounds.y + (matrix[3] < 0 ? bounds.height - ry - rh : ry) : matrix[5] + matrix[3] * (ry + (matrix[3] < 0 ? rh : 0)),
      width: rw * (units === "objectBoundingBox" ? 1 : Math.abs(matrix[0])), height: rh * (units === "objectBoundingBox" ? 1 : Math.abs(matrix[3])),
    };
    const radii = morphology ? numbers(morphology.getAttribute("radius") ?? "0", "阴影扩边") : [0];
    if (radii.length > 2 || radii.length < 1 || radii[0] < 0 || (radii.length === 2 && radii[0] !== radii[1])) fail("暂只支持等宽的阴影扩边。");
    return { dx: scalar(offset.getAttribute("dx")) * matrix[0], dy: scalar(offset.getAttribute("dy")) * matrix[3], spread: radii[0] * Math.abs(matrix[0]), color: `rgba(${values[4]*255},${values[9]*255},${values[14]*255},${values[18]})`, knockout, region };
  }
  function addImage(el: Element, s: Style, matrix: Matrix, alpha: number, owner?: Element) {
    const assetId = imageAssets.get(el), asset = assetId ? assets[assetId] : undefined;
    if (!asset || !assetId) fail("图片资源缺失。");
    const w = length(el.getAttribute("width"), basisX, 16, asset!.width), h = length(el.getAttribute("height"), basisY, 16, asset!.height);
    if (w < 0 || h < 0) fail("图片宽高不能为负。");
    if (!w || !h) return;
    const x = length(el.getAttribute("x"), basisX), y = length(el.getAttribute("y"), basisY);
    const aspect = el.getAttribute("preserveAspectRatio")?.replace(/^defer\s+/, "") ?? "xMidYMid meet";
    const slice = /\bslice$/.test(aspect), alignment = aspect.replace(/\bslice$/, "meet");
    let vm = viewport([0,0,asset!.width,asset!.height], w, h, alignment);
    if (slice) {
      const scale = Math.max(w / asset!.width, h / asset!.height), ax = aspect.startsWith("xMin") ? 0 : aspect.startsWith("xMax") ? 1 : .5, ay = aspect.includes("YMin") ? 0 : aspect.includes("YMax") ? 1 : .5;
      vm = [scale,0,0,scale,(w-asset!.width*scale)*ax,(h-asset!.height*scale)*ay];
    }
    const m = mul(matrix, mul([1,0,0,1,x,y], vm)), sx = Math.hypot(m[0],m[1]), sy = (m[0]*m[3]-m[1]*m[2]) / sx;
    if (sx < 1e-8 || Math.abs(sy) < 1e-8) return;
    if (Math.abs(m[0]*m[2]+m[1]*m[3]) > 1e-7 * sx * Math.abs(sy)) fail("暂不支持倾斜图片。");
    const image: Primitive = { id: unique(el), type: "image", assetId, x: m[4], y: m[5], width: asset!.width, height: asset!.height, rotation: Math.atan2(m[1],m[0])*180/Math.PI, scaleX: sx, scaleY: sy, opacity: alpha, strokeWidth: 0 };
    if (slice) {
      const path = `M${x} ${y}H${x+w}V${y+h}H${x}Z`;
      addPrimitive({ id: unique(el,"-viewport"), type: "group", x: 0, y: 0, children: [image], clip: [{ path: util.joinPath(util.transformPath(parsedPath(path),matrix,new Point(0,0)),8) }] }, owner);
    } else addPrimitive(image,owner);
  }
  function visit(el:Element,parent:Style,parentMatrix:Matrix,parentOpacity:number,owner?:Element){
    const tag=el.localName;if(nonDrawing.has(tag))return;
    if(tag==="text"&&el.textContent===""){emptyTextNodes++;return;}
    const s=styleOf(el,parent);if(s.display==="none")return;
    if(moduleGroups.has(el))owner=el;
    const ownOpacity=opacity(s.opacity),m=mul(parentMatrix,transform(el.getAttribute("transform")));
    if (ownOpacity === 0 || parentOpacity === 0) return;
    const clips = s["clip-path"] && s["clip-path"] !== "none" ? clipPaths(s["clip-path"], m) : undefined;
    const filter = s.filter && s.filter !== "none" ? s.filter : undefined;
    // SVG element opacity composites its geometry and markers together. Apply
    // it once after expanding the arrowheads, including their overlap region.
    const hasMarkers=["start","mid","end"].some(side=>s[`marker-${side}`]&&s[`marker-${side}`]!=="none");
    const composite = !!clips || !!filter || ((tag === "g" || tag === "svg" || hasMarkers) && ownOpacity !== 1);
    const first = primitives.length;
    visitContents(el,s,m,composite ? parentOpacity : parentOpacity*ownOpacity,owner);
    if (composite && primitives.length > first) {
      const children = primitives.splice(first);
      const primitive: Primitive = { id: unique(el,"-composite"), type: "group", x: 0, y: 0, children, opacity: ownOpacity, ...(clips ? {clip:clips} : {}), ...(filter ? {svgShadow:shadow(filter,m,children)} : {}) };
      addPrimitive(primitive,owner);
    }
  }
  function visitContents(el:Element,s:Style,m:Matrix,alpha:number,owner?:Element){
    const tag=el.localName;
    if(tag==="g"||tag==="svg"){
      if(tag==="svg"&&el!==root)fail("暂不支持嵌套 SVG 画布，请展开为普通分组。");
      for(const child of Array.from(el.children))visit(child,s,m,alpha,owner);return;
    }
    if(s.visibility==="hidden"||s.visibility==="collapse"||alpha===0)return;
    if(tag==="image") {addImage(el,s,m,alpha,owner);return;}
    if(tag==="text"){
      if(markerViewport)fail("带裁切视口的文字箭头暂不能无损导入，请将文字移出 marker 或设置 overflow=visible。");
      const first=primitives.length;addText(el,s,m,alpha,owner);
      if(!markerDepth)connectorSource(el)?.labels.push(...primitives.slice(first));return;
    }
    if(tag==="tspan")fail("tspan 必须位于 text 内。");
    if(tag==="rect"&&(length(el.getAttribute("width"),basisX)===0||length(el.getAttribute("height"),basisY)===0))return;
    if(tag==="circle"&&length(el.getAttribute("r"),diagonal)===0)return;
    if(tag==="ellipse"&&(length(el.getAttribute("rx"),basisX)===0||length(el.getAttribute("ry"),basisY)===0))return;
    const d=localPath(el);if(!d.trim())return;
    if(markerViewport){
      const clipTransform=mul(markerViewport.inverse,m),clipPath=new Path(util.joinPath(util.transformPath(parsedPath(d),clipTransform,new Point(0,0)),8),{strokeWidth:0});
      const stroke=s.stroke==="none"?0:length(s["stroke-width"],diagonal)*Math.max(Math.hypot(clipTransform[0],clipTransform[1]),Math.hypot(clipTransform[2],clipTransform[3]))/2;
      if(clipPath.left-stroke< -1e-6||clipPath.top-stroke< -1e-6||clipPath.left+clipPath.width+stroke>markerViewport.width+1e-6||clipPath.top+clipPath.height+stroke>markerViewport.height+1e-6)fail("箭头图形超出 marker 视口，需要裁切；请先展开箭头或设置 overflow=visible。");
    }
    let geometryMatrix=m,scaleX=1,scaleY=1;
    const columnX=Math.hypot(m[0],m[1]),columnY=Math.hypot(m[2],m[3]);
    const nonUniform=Math.abs(columnX-columnY)>1e-6||Math.abs(m[0]*m[2]+m[1]*m[3])>1e-6;
    if(s.stroke!=="none"&&length(s["stroke-width"],diagonal)>0&&nonUniform){
      // Keep axis-aligned anisotropic stroke scaling in the existing primitive
      // scale fields instead of approximating it with one average stroke width.
      scaleX=Math.hypot(m[0],m[2]);scaleY=Math.hypot(m[1],m[3]);
      if(scaleX<1e-8||scaleY<1e-8||Math.abs(m[0]*m[1]+m[2]*m[3])>1e-6*scaleX*scaleY)fail("带描边图形的倾斜或旋转后的非等比缩放暂不能无损导入；请先将描边转换为轮廓。");
      geometryMatrix=[m[0]/scaleX,m[1]/scaleY,m[2]/scaleX,m[3]/scaleY,m[4]/scaleX,m[5]/scaleY];
    }
    const local=parsedPath(d),transformed=util.transformPath(local,geometryMatrix,new Point(0,0)),path=util.joinPath(transformed,8),boundsPath=new Path(path,{strokeWidth:0});
    const base:Primitive={id:unique(el),type:"path",x:0,y:0,path,...appearance(el,s,geometryMatrix,alpha),...(scaleX!==1||scaleY!==1?{scaleX,scaleY}:{})};
    if(s.fill.startsWith("url("))base.gradient=gradient(s.fill,el,geometryMatrix,{left:boundsPath.left,top:boundsPath.top,width:boundsPath.width,height:boundsPath.height},opacity(s["fill-opacity"]));
    // Keep basic axis-aligned geometry as native shapes; transformed curves remain editable paths.
    const axis=Math.abs(m[1])<1e-9&&Math.abs(m[2])<1e-9&&scaleX===1&&scaleY===1;
    const n=(name:string,basis:number,fallback=0)=>length(el.getAttribute(name),basis,16,fallback);
    if(axis&&tag==="rect"){
      const x=n("x",basisX),y=n("y",basisY),w=n("width",basisX),h=n("height",basisY),a=at(m,x,y),b=at(m,x+w,y+h),rx=n("rx",basisX,n("ry",basisY)),ry=n("ry",basisY,rx);
      if(Math.abs(rx*Math.abs(m[0])-ry*Math.abs(m[3]))<1e-6){base.type="rect";base.x=Math.min(a.x,b.x);base.y=Math.min(a.y,b.y);base.width=Math.abs(b.x-a.x);base.height=Math.abs(b.y-a.y);base.radius=Math.min(rx*Math.abs(m[0]),base.width/2,base.height/2);delete base.path;}
    }else if(axis&&(tag==="circle"||tag==="ellipse")){
      const rx=tag==="circle"?n("r",diagonal):n("rx",basisX),ry=tag==="circle"?rx:n("ry",basisY),center=at(m,n("cx",basisX),n("cy",basisY));base.type="ellipse";base.width=2*rx*Math.abs(m[0]);base.height=2*ry*Math.abs(m[3]);base.x=center.x-base.width/2;base.y=center.y-base.height/2;delete base.path;
    }
    addPrimitive(base,owner);const markerFirst=primitives.length;marker(el,s,m,d,alpha,owner);
    if(!markerDepth){
      const source=connectorSource(el);
      if(source){
        const heads=primitives.slice(markerFirst),name=source.element.getAttribute("data-connector-id")!.replace(/[^\w.-]/g,"-").slice(0,70);
        for(const head of heads)head.id=`${head.id}-${name}-arrowhead`;
        source.paths.push({primitive:base,heads,markerStart:!!s["marker-start"]&&s["marker-start"]!=="none",markerEnd:!!s["marker-end"]&&s["marker-end"]!=="none"});
      }
    }
  }
  if(styleRoot.display==="none")fail("文件中没有可导入的可见矢量对象。");
  if (styleRoot.background && !["none","transparent"].includes(styleRoot.background)) addPrimitive({id:unique(root,"-background"),type:"rect",x:0,y:0,width,height,fill:paint(styleRoot.background,1,styleRoot.color),strokeWidth:0,locked:true,layer:"background"});
  visit(root,defaults,vb?viewport(vb,width,height,root.getAttribute("preserveAspectRatio")):IDENTITY,1);
  if(!primitives.length)fail("文件中没有可导入的可见矢量对象。");
  const title=Array.from(root.children).find(e=>e.localName==="title")?.textContent?.trim()||filename.replace(/\.svg$/i,"")||"导入 SVG";
  if(all.some(e=>e.localName==="metadata"))warnings.add("已按 SVG 当前图形导入，未使用工程元数据中可能过期的图形、文字或坐标。");
  if(primitives.some(p=>p.type==="text"))warnings.add("文字保持可编辑；缺少原图字体时，浏览器会使用替代字体。");
  // Calculate bounds from current SVG geometry, including transformed text and
  // stroke extents. Embedded metadata may describe a different, older drawing.
  function boundsOf(p:Primitive, geometryOnly = false): {left:number;top:number;right:number;bottom:number} {
    if (p.type === "group") {
      const boxes = (p.children ?? []).map(child => boundsOf(child, geometryOnly));
      if (!boxes.length) return {left:p.x,top:p.y,right:p.x,bottom:p.y};
      let left = Math.min(...boxes.map(b=>b.left)), top = Math.min(...boxes.map(b=>b.top)), right = Math.max(...boxes.map(b=>b.right)), bottom = Math.max(...boxes.map(b=>b.bottom));
      if (!geometryOnly && p.svgShadow) {
        const r = p.svgShadow.region; left=r.x;top=r.y;right=r.x+r.width;bottom=r.y+r.height;
      }
      const a=(p.rotation??0)*Math.PI/180, c=Math.cos(a),s=Math.sin(a),sx=p.scaleX??1,sy=p.scaleY??1;
      const corners=[[left,top],[right,top],[left,bottom],[right,bottom]].map(([x,y])=>({x:p.x+c*x*sx-s*y*sy,y:p.y+s*x*sx+c*y*sy}));
      return {left:Math.min(...corners.map(v=>v.x)),top:Math.min(...corners.map(v=>v.y)),right:Math.max(...corners.map(v=>v.x)),bottom:Math.max(...corners.map(v=>v.y))};
    }
    // Match CanvasEditor's actual object bounds, not just visible SVG ink:
    // Fabric includes strokeWidth even when stroke="none" and rotates that
    // complete box. Missing it makes Group's fit layout shift module contents.
    const options={strokeWidth:geometryOnly||p.type==="image"?0:p.strokeWidth??1,angle:0,originX:"left" as const,originY:"top" as const,objectCaching:false};
    let object:FabricObject;
    if(p.type==="path")object=new Path(p.path??"",options);
    else if(p.type==="ellipse")object=new Ellipse({...options,rx:(p.width??0)/2,ry:(p.height??0)/2});
    else if(p.type==="text"){
      const text=new IText(p.text??"",{...options,fontSize:p.fontSize??16,fontFamily:p.fontFamily??"Arial",charSpacing:(p.letterSpacing??0)/(p.fontSize??16)*1000,fontWeight:p.fontWeight??400,fontStyle:p.italic?"italic":"normal",underline:p.underline??false,lineHeight:1.24,textAlign:p.align??"left",padding:3});
      text._fontSizeMult=1;text._fontSizeFraction=.08;text.initDimensions();object=text;
    }else object=new Rect({...options,width:p.width??0,height:p.height??0});
    const preserveBounds=p.type==="path",shape=p.type==="rect"||p.type==="ellipse"||p.type==="text";
    let localX=preserveBounds?object.left:shape?-options.strokeWidth/2:0;
    const localY=preserveBounds?object.top:shape?-options.strokeWidth/2:0;
    if(p.type==="text"&&p.align==="center")localX+=((p.width??0)-object.width)/2;
    if(p.type==="text"&&p.align==="right")localX+=(p.width??0)-object.width;
    const angle=(p.rotation??0)*Math.PI/180,offsetX=localX*(p.scaleX??1),offsetY=localY*(p.scaleY??1);
    object.set({left:p.x+offsetX*Math.cos(angle)-offsetY*Math.sin(angle),top:p.y+offsetX*Math.sin(angle)+offsetY*Math.cos(angle),angle:p.rotation??0,scaleX:p.scaleX??1,scaleY:p.scaleY??1});
    object.setCoords();const bounds=object.getBoundingRect();object.dispose();
    return {left:bounds.left,top:bounds.top,right:bounds.left+bounds.width,bottom:bounds.top+bounds.height};
  }
  const moduleIds=new Set<string>(), modules:SceneModule[]=[], annotations:Primitive[]=[];
  function createModule(elements:Primitive[],owner?:Element){
    const bounds=elements.map(p=>boundsOf(p)),padding=2,x=Math.min(...bounds.map(b=>b.left))-padding,y=Math.min(...bounds.map(b=>b.top))-padding;
    const moduleWidth=Math.max(1,Math.max(...bounds.map(b=>b.right))-x+padding),moduleHeight=Math.max(1,Math.max(...bounds.map(b=>b.bottom))-y+padding);
    const requestedId=owner?.getAttribute("data-module-id")||owner?.id||`svg-${owner?"group":"object"}-${modules.length+1}`;
    let id=requestedId,index=2;while(moduleIds.has(id))id=`${requestedId}-${index++}`;moduleIds.add(id);
    const label=owner?.getAttribute("aria-label")||owner?.getAttribute("inkscape:label")||Array.from(owner?.children??[]).find(el=>el.localName==="title")?.textContent?.trim();
    const heading=elements.find(p=>p.type==="text"&&p.text?.trim())?.text?.replace(/\s+/g," ").trim();
    const moduleTitle=(label||heading||owner?.getAttribute("data-module-id")||owner?.id||`SVG ${owner?"分组":"对象"} ${modules.length+1}`).slice(0,160);
    const localElements=elements.map(p=>{
      if(p.type==="path"){
        const path=util.joinPath(util.transformPath(parsedPath(p.path??""),[1,0,0,1,-x/(p.scaleX??1),-y/(p.scaleY??1)],new Point(0,0)),8);
        return {...p,path};
      }
      return {...p,x:p.x-x,y:p.y-y};
    });
    modules.push({id,title:moduleTitle,role:"illustration",brief:`从 ${filename} 导入的 SVG 分组。`,componentIds:[],labels:[],sourceRefs:[],x,y,width:moduleWidth,height:moduleHeight,contentWidth:moduleWidth,contentHeight:moduleHeight,ports:[],method:"vector-agent",status:"ready",elements:localElements});
  }
  const firstOwned=primitives.findIndex(p=>owners.get(p)!==undefined),lastOwned=primitives.reduce((last,p,index)=>owners.get(p)!==undefined?index:last,-1);
  for(let index=0;index<primitives.length;){
    const p=primitives[index],owner=owners.get(p);
    if(owner){
      const elements:Primitive[]=[];do{elements.push(primitives[index++]);}while(index<primitives.length&&owners.get(primitives[index])===owner);
      createModule(elements,owner);
    }else if(index>firstOwned&&index<lastOwned){
      // An annotation between two SVG groups cannot be moved to the scene's
      // front/back annotation planes without changing painter order.
      createModule([p]);index++;
    }else{
      const isWhiteCanvas=index===0&&p.type==="rect"&&!p.gradient&&p.fill?.toLowerCase()==="#ffffff"&&(p.opacity??1)===1&&p.x<=0&&p.y<=0&&p.x+(p.width??0)>=width&&p.y+(p.height??0)>=height;
      annotations.push({...p,layer:firstOwned>=0&&index<firstOwned?"background":"foreground",...(isWhiteCanvas?{locked:true}:{})});index++;
    }
  }
  if(modules.length)warnings.add("已按 SVG 分组建立独立模块；模块内的文字和图形可进入模块后分别编辑。");
  else warnings.add("SVG 未包含独立分组，图形和文字已作为独立对象导入。");
  const scene:FigureScene={schema:"paper-atelier/1",id:crypto.randomUUID(),figureType:"svg-import",title,width,height,style:{font:"Arial",ink:"#000000",muted:"#64748B",accent:"#2563EB",palette:["#2563EB","#10B981","#F59E0B"],lineWidth:1,bodySize:16,titleSize:24,illustrationStyle:"导入 SVG"},regions:[],connectors:[],annotations,modules,...(Object.keys(assets).length?{assets}:{})};
  if (Object.keys(assets).length) warnings.add("内嵌图片已保留为可移动、缩放的图片对象；图片内部像素不会转换成矢量或文字。");
  if (emptyTextNodes) warnings.add(`已忽略 ${emptyTextNodes} 个不含字符的空文字节点；包含空格的文字仍按原排版处理。`);
  promoteSvgConnectors(scene,root,[...connectorSources.values()],primitives,firstOwned,warnings);
  return {scene,warnings:[...warnings]};
}
