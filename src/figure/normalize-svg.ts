import { freezeSvgStyles } from "./svg-css";

const SVG = "http://www.w3.org/2000/svg";
const XLINK = "http://www.w3.org/1999/xlink";
const NUMBER = "[-+]?(?:\\d*\\.\\d+|\\d+\\.?\\d*)(?:[eE][-+]?\\d+)?";
const LIMIT = 12000;
const EXPANDED_TEXT_LIMIT = 64 * 1024 * 1024;
function fail(message: string): never { throw new Error("SVG 导入失败：" + message); }
const elements = (root: Element) => [root, ...Array.from(root.querySelectorAll("*"))];
const reference = (el: Element) => el.getAttribute("href") ?? el.getAttributeNS(XLINK, "href");
function number(value: string | null, fallback: number, basis = fallback): number {
  if (value == null || value === "") return fallback;
  const match = value.trim().match(new RegExp("^(" + NUMBER + ")(px|pt|pc|mm|cm|in|q|%)?$", "i"));
  if (!match) fail("引用实例的长度暂只支持数值、绝对单位或百分比：" + value);
  const unit = match[2]?.toLowerCase() ?? "";
  const scale: Record<string, number> = { "": 1, px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, q: 96 / 101.6, "%": basis / 100 };
  const result = Number(match[1]) * scale[unit];
  if (!Number.isFinite(result) || Math.abs(result) > 1e8) fail("引用实例的长度超出支持范围。");
  return result;
}
function viewBox(el: Element): number[] | undefined {
  const raw = el.getAttribute("viewBox");
  if (!raw) return undefined;
  const values = raw.trim().split(/[\s,]+/).map(Number);
  if (values.length !== 4 || values.some(v => !Number.isFinite(v)) || values[2] <= 0 || values[3] <= 0) fail("symbol 的 viewBox 无效。");
  return values;
}
function attributes(from: Element, to: Element, except = new Set<string>()) {
  for (const attribute of Array.from(from.attributes)) {
    if (!except.has(attribute.localName)) to.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
  }
}
function declarations(value: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const item of value.split(";")) {
    if (!item.trim()) continue;
    const colon = item.indexOf(":");
    if (colon < 1) fail("无效的 SVG 样式。");
    result.set(item.slice(0, colon).trim().toLowerCase(), item.slice(colon + 1).trim());
  }
  return result;
}
function setStyles(el: Element, styles: Map<string, string>) {
  if (styles.size) el.setAttribute("style", [...styles].map(([key, value]) => key + ":" + value).join(";"));
  else el.removeAttribute("style");
}

/** Expand local reference structure without changing the user's source file. */
export function normalizeSvgDocument(root: Element): string[] {
  const doc = root.ownerDocument, warnings = new Set<string>(), original = elements(root);
  if (original.length > LIMIT) fail("元素超过 12000 个，请拆分文件。");
  const idMap = new Map<string, Element>(), allocated = new Set<string>(), missingImages = new Map<Element, string>(), duplicateIds: Element[] = [];
  function inspectText(value: string) {
    if (/@import|@font-face|expression\s*\(|javascript:|vbscript:/i.test(value)) fail("文件包含主动内容或外部样式资源。");
    for (const match of value.matchAll(/url\s*\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
      if (!/^#[\w:.-]+$/.test(match[2].trim())) fail("不支持外部图片、字体或网络资源。");
    }
  }
  // Validate before removing editor metadata or unused definitions.
  for (const el of original) {
    if (["script", "foreignObject", "iframe", "object", "embed"].includes(el.localName)) fail("不支持主动内容 <" + el.localName + ">。");
    for (const attribute of Array.from(el.attributes)) {
      if (/^on/i.test(attribute.localName)) fail("文件包含事件处理代码，不能导入。");
      inspectText(attribute.value);
      if (attribute.localName === "href") {
        const value = attribute.value.trim();
        const local = /^#[\w:.-]+$/.test(value);
        const raster = el.localName === "image" && /^data:image\/(?:png|jpe?g);base64,[a-z0-9+/\s=]+$/i.test(value);
        const relative = el.localName === "image" && !!value && !/^(?:[a-z][a-z0-9+.-]*:|[\\/]|#)/i.test(value) && !/[\u0000-\u001f]/.test(value);
        if (relative && !el.closest("metadata")) missingImages.set(el, value);
        else if (!el.closest("metadata")) {
          if (!local && !raster) fail("只允许文档内引用、内嵌 PNG/JPEG 图片或本地相对图片路径；不会获取网络资源。");
          if (el.localName === "image" && !raster) fail("image 必须包含内嵌 PNG/JPEG 数据。");
        }
      }
      if (attribute.localName === "base") fail("不支持会改变引用地址的 xml:base。");
    }
    if (el.localName === "style") inspectText(el.textContent ?? "");
    if (el.id && !el.closest("metadata")) {
      if (idMap.has(el.id)) duplicateIds.push(el);
      else idMap.set(el.id, el);
      allocated.add(el.id);
    }
  }

  // Resolve author CSS while the original selector ancestry is still intact.
  freezeSvgStyles(root, original);
  // OmniGraffle exports local font metadata rather than embedded glyphs. Modern
  // SVG renderers resolve the text's font-family themselves; keep that fallback.
  for (const face of original.filter(el => el.localName === "font-face" && el.parentElement?.localName === "defs")) {
    if (Array.from(face.querySelectorAll("*")).some(el => !["font-face-src", "font-face-name"].includes(el.localName))) fail("暂不支持嵌入式 SVG 字体或字体资源，请使用本机字体或转曲。");
    face.remove();
    warnings.add("本地字体声明已按文字的 font-family 处理；未安装的字体将使用浏览器替代字体。");
  }
  for (const duplicate of duplicateIds) {
    const id = duplicate.id;
    const referenced = original.some(el => Array.from(el.attributes).some(attribute => {
      const value = attribute.value.trim();
      if (attribute.localName === "href" && value === "#" + id) return true;
      if (["begin", "end"].includes(attribute.localName) && value.split(";").some(event => event.trim().startsWith(id + "."))) return true;
      if (["aria-labelledby", "aria-describedby"].includes(attribute.name) && value.split(/\s+/).includes(id)) return true;
      return Array.from(value.matchAll(/url\(\s*(['"]?)#([\w:.-]+)\1\s*\)/g)).some(match => match[2] === id);
    }));
    if (referenced) fail("重复的 SVG id 被引用，无法确定目标：" + id);
    let index = 2, replacement = `${id}-${index}`;
    while (allocated.has(replacement)) replacement = `${id}-${++index}`;
    allocated.add(replacement); duplicate.id = replacement; idMap.set(replacement, duplicate);
  }
  if (duplicateIds.length) warnings.add(`已为 ${duplicateIds.length} 个未被引用的重复 ID 分配唯一名称；图形和样式保持不变。`);
  let hoverSets = 0;
  for (const el of original.filter(el => el.localName === "set" && !el.closest("metadata"))) {
    const events = (attribute: string, pattern: RegExp) => {
      const values = (el.getAttribute(attribute) ?? "").split(";").map(value => value.trim()).filter(Boolean);
      return values.length > 0 && values.every(value => pattern.test(value));
    };
    if (!["fill", "stroke", "stroke-width", "stroke-dasharray", "opacity", "fill-opacity", "stroke-opacity", "visibility"].includes(el.getAttribute("attributeName") ?? "") ||
      !events("begin", /^(?:[\w:.-]+\.)?(?:mouseover|mouseenter|focusin)$/) ||
      !events("end", /^(?:[\w:.-]+\.)?(?:mouseout|mouseleave|focusout)$/)) fail("暂只支持将鼠标悬停样式切换导入为默认静态外观；请先展开其它 SVG 动画。");
    el.remove(); hoverSets++;
  }
  if (hoverSets) warnings.add(`已按默认静态外观导入，忽略 ${hoverSets} 个悬停样式切换；交互高亮未保留。`);
  const rootBox = viewBox(root);
  const rootWidth = rootBox?.[2] ?? number(root.getAttribute("width"), 300);
  const rootHeight = rootBox?.[3] ?? number(root.getAttribute("height"), 150);
  for (const [el, path] of missingImages) {
    const wrapper = doc.createElementNS(SVG, "g"), label = doc.createElementNS(SVG, "title");
    attributes(el, wrapper, new Set(["href", "x", "y", "width", "height", "preserveAspectRatio"]));
    label.textContent = "缺失资源：" + path; wrapper.append(label);
    const x = number(el.getAttribute("x"), 0, rootWidth), y = number(el.getAttribute("y"), 0, rootHeight);
    const width = number(el.getAttribute("width"), 24, rootWidth), height = number(el.getAttribute("height"), 24, rootHeight);
    if (width < 0 || height < 0) fail("缺失图片的宽高不能为负。");
    if (width && height) {
      const stroke = Math.min(2, width / 20, height / 20), inset = stroke / 2;
      const rect = doc.createElementNS(SVG, "rect"), border = doc.createElementNS(SVG, "path"), cross = doc.createElementNS(SVG, "path");
      for (const [key, value] of Object.entries({ x: x + inset, y: y + inset, width: width - stroke, height: height - stroke })) rect.setAttribute(key, String(value));
      rect.setAttribute("fill", "#fff7ed"); rect.setAttribute("stroke", "none"); rect.setAttribute("fill-opacity", "1");
      // These generated straight segments have exact filled outlines. Keeping
      // them unstroked lets placeholders inherit any affine image transform.
      border.setAttribute("d", `M${x} ${y}H${x + width}V${y + height}H${x}Z M${x + stroke} ${y + stroke}H${x + width - stroke}V${y + height - stroke}H${x + stroke}Z`);
      border.setAttribute("fill-rule", "evenodd");
      const segment = (x1: number, y1: number, x2: number, y2: number) => {
        const dx = x2 - x1, dy = y2 - y1, length = Math.hypot(dx, dy);
        const nx = -dy / length * inset, ny = dx / length * inset;
        return `M${x1 + nx} ${y1 + ny}L${x2 + nx} ${y2 + ny}L${x2 - nx} ${y2 - ny}L${x1 - nx} ${y1 - ny}Z`;
      };
      cross.setAttribute("d", segment(x + inset, y + inset, x + width - inset, y + height - inset) + " " +
        segment(x + width - inset, y + inset, x + inset, y + height - inset));
      cross.setAttribute("fill-rule", "nonzero");
      for (const shape of [border, cross]) {
        shape.setAttribute("fill", "#c2410c"); shape.setAttribute("stroke", "none");
        // Raster images ignore fill/stroke opacity. The replacement contours
        // inherit only the original image's real group opacity and visibility.
        shape.setAttribute("fill-opacity", "1");
      }
      wrapper.append(rect, border, cross);
    }
    el.replaceWith(wrapper);
    if (wrapper.id) idMap.set(wrapper.id, wrapper);
    warnings.add(`缺失本地图片“${path}”：已在原位置保留带叉号的占位框；请提供并嵌入该资源后重新导入。`);
  }
  function textSize(nodes: Element[]): number {
    return nodes.reduce((size, node) => size + Array.from(node.attributes).reduce((sum, attr) => sum + attr.value.length, 0) +
      Array.from(node.childNodes).reduce((sum, child) => sum + (child.nodeType === 3 ? child.textContent?.length ?? 0 : 0), 0), 0);
  }
  let sequence = 0, created = elements(root).length, expandedCount = 0, createdText = textSize(elements(root));
  const unique = (hint: string) => {
    let id: string;
    do id = "svg-normalized-" + (++sequence) + "-" + hint.replace(/[^\w.-]/g, "-").slice(0, 70); while (allocated.has(id));
    allocated.add(id);
    return id;
  };
  function clone(el: Element): Element {
    const nodes = elements(el);
    created += nodes.length;
    createdText += textSize(nodes);
    if (created > LIMIT) fail("引用展开后对象过多，请拆分文件。");
    if (createdText > EXPANDED_TEXT_LIMIT) fail("引用展开后的图像或路径数据过多，请拆分文件。");
    return el.cloneNode(true) as Element;
  }
  function remapIds(tree: Element) {
    const map = new Map<string, string>();
    for (const el of elements(tree)) if (el.id) { const id = unique(el.id); map.set(el.id, id); el.id = id; }
    for (const el of elements(tree)) for (const attr of Array.from(el.attributes)) {
      if (attr.localName === "id") continue;
      let value = attr.value.replace(/url\(\s*(['"]?)#([\w:.-]+)\1\s*\)/g, (full, _quote, id: string) => map.has(id) ? "url(#" + map.get(id) + ")" : full);
      if (attr.localName === "href" && value.startsWith("#") && map.has(value.slice(1))) value = "#" + map.get(value.slice(1));
      if (value !== attr.value) el.setAttributeNS(attr.namespaceURI, attr.name, value);
    }
  }
  // A gradient href is a template: missing coordinates/settings and, only when
  // absent locally, the complete stop list come from the referenced gradient.
  // Resolve before taking <use> snapshots so cloned definitions are standalone.
  const resolvedGradients = new Set<Element>();
  function stopProperty(el: Element, property: string, fallback: string, inherited = false): string {
    for (let node: Element | null = el; node; node = node.parentElement) {
      const value = declarations(node.getAttribute("style") ?? "").get(property) ?? node.getAttribute(property);
      if (value && value !== "inherit" && !(property === "color" && value === "currentColor")) return value;
      if (!value && !inherited) return fallback;
    }
    return fallback;
  }
  function resolveGradient(el: Element, stack: Element[]) {
    if (resolvedGradients.has(el)) return;
    if (stack.includes(el)) fail("检测到循环渐变引用：" + [...stack, el].map(node => node.id || "linearGradient").join(" → "));
    if (stack.length > 32) fail("渐变引用嵌套超过 32 层。");
    const href = reference(el)?.trim();
    if (href != null) {
      if (!/^#[\w:.-]+$/.test(href)) fail("渐变只允许文档内引用。");
      const target = idMap.get(href.slice(1));
      if (!target) fail("渐变引用目标不存在：" + href);
      if (target.localName !== "linearGradient") fail("渐变引用暂只支持 linearGradient，目标为 <" + target.localName + ">。");
      resolveGradient(target, [...stack, el]);
      for (const name of ["x1", "y1", "x2", "y2", "gradientUnits", "gradientTransform", "spreadMethod"]) {
        if (!el.hasAttribute(name) && target.hasAttribute(name)) {
          const value = target.getAttribute(name)!;
          createdText += value.length; el.setAttribute(name, value);
        }
      }
      if (!Array.from(el.children).some(child => child.localName === "stop")) {
        for (const stop of Array.from(target.children).filter(child => child.localName === "stop")) {
          const instance = clone(stop), styles = declarations(instance.getAttribute("style") ?? "");
          // Paint properties of template stops are computed in their original
          // ancestry, not against the gradient that borrows them.
          const color = stopProperty(stop, "color", "#000000", true);
          const paint = stopProperty(stop, "stop-color", "#000000");
          styles.set("color", color);
          styles.set("stop-color", paint === "currentColor" ? color : paint);
          styles.set("stop-opacity", stopProperty(stop, "stop-opacity", "1"));
          setStyles(instance, styles); remapIds(instance);
          createdText += textSize(elements(instance)) - textSize(elements(stop));
          el.append(instance);
        }
      }
      el.removeAttribute("href"); el.removeAttributeNS(XLINK, "href");
      if (createdText > EXPANDED_TEXT_LIMIT) fail("引用展开后的图像或路径数据过多，请拆分文件。");
    }
    resolvedGradients.add(el);
  }
  for (const gradient of original.filter(el => el.localName === "linearGradient" && !el.closest("metadata"))) resolveGradient(gradient, []);
  const definitions = new Map([...idMap].map(([id, el]) => [id, el.cloneNode(true) as Element]));
  let extraDefs: Element | undefined;
  function clipRect(width: number, height: number): string {
    if (!extraDefs) { extraDefs = doc.createElementNS(SVG, "defs"); root.insertBefore(extraDefs, root.firstChild); }
    const clip = doc.createElementNS(SVG, "clipPath"), rect = doc.createElementNS(SVG, "rect"), id = unique("viewport");
    clip.id = id; clip.setAttribute("clipPathUnits", "userSpaceOnUse");
    rect.setAttribute("width", String(width)); rect.setAttribute("height", String(height));
    clip.append(rect); extraDefs.append(clip); return id;
  }
  function expand(el: Element, stack: string[], width: number, height: number): Element | undefined {
    if (stack.length > 32) fail("引用嵌套超过 32 层。");
    if (el.localName === "metadata") return el;
    if (el.localName === "namedview") { el.remove(); return undefined; }
    if (el.localName === "a") {
      const group = doc.createElementNS(SVG, "g");
      attributes(el, group, new Set(["href", "target", "download", "rel", "tabindex", "role"]));
      group.append(...Array.from(el.childNodes)); el.replaceWith(group); el = group;
      warnings.add("链接已转换为普通可编辑分组，保留图形并移除交互链接。");
    }
    if (el.localName === "use") {
      const href = reference(el);
      if (!href?.startsWith("#")) fail("use 缺少本地引用目标。");
      const id = href.slice(1), target = definitions.get(id);
      if (!target) fail("引用目标不存在：" + href);
      if (stack.includes(id)) fail("检测到循环 SVG 引用：" + [...stack, id].join(" → "));
      if (!["symbol", "svg", "g", "use", "rect", "circle", "ellipse", "line", "polyline", "polygon", "path", "text", "image"].includes(target.localName)) fail("use 不能引用 <" + target.localName + ">。");
      const wrapper = doc.createElementNS(SVG, "g");
      attributes(el, wrapper, new Set(["href", "x", "y", "width", "height", "preserveAspectRatio"]));
      const x = number(el.getAttribute("x"), 0, width), y = number(el.getAttribute("y"), 0, height);
      wrapper.setAttribute("transform", (el.getAttribute("transform") ?? "") + " translate(" + x + " " + y + ")");
      let content = clone(target), nestedWidth = width, nestedHeight = height;
      if (target.localName === "symbol" || target.localName === "svg") {
        const w = number(el.getAttribute("width") ?? target.getAttribute("width"), width, width);
        const h = number(el.getAttribute("height") ?? target.getAttribute("height"), height, height);
        if (w < 0 || h < 0) fail("symbol 实例宽高不能为负。");
        if (w === 0 || h === 0) { el.replaceWith(wrapper); return wrapper; }
        const box = viewBox(target), symbolGroup = doc.createElementNS(SVG, "g");
        attributes(content, symbolGroup, new Set(["viewBox", "width", "height", "x", "y", "preserveAspectRatio", "overflow"]));
        symbolGroup.append(...Array.from(content.childNodes));
        const symbolStyles = declarations(symbolGroup.getAttribute("style") ?? "");
        symbolStyles.delete("overflow"); setStyles(symbolGroup, symbolStyles);
        const viewport = doc.createElementNS(SVG, "g");
        const overflow = declarations(target.getAttribute("style") ?? "").get("overflow") ?? target.getAttribute("overflow");
        if (overflow !== "visible") viewport.setAttribute("clip-path", "url(#" + clipRect(w, h) + ")");
        if (box) {
          const [bx, by, bw, bh] = box, aspect = (el.getAttribute("preserveAspectRatio") ?? target.getAttribute("preserveAspectRatio") ?? "xMidYMid meet").trim();
          let sx = w / bw, sy = h / bh, tx = -bx * sx, ty = -by * sy;
          if (aspect !== "none") {
            const match = aspect.match(/^(xMin|xMid|xMax)(YMin|YMid|YMax)(?:\s+(meet|slice))?$/);
            if (!match) fail("不支持该 symbol preserveAspectRatio。");
            sx = sy = match[3] === "slice" ? Math.max(sx, sy) : Math.min(sx, sy);
            tx = (w - bw * sx) * (match[1] === "xMin" ? 0 : match[1] === "xMid" ? .5 : 1) - bx * sx;
            ty = (h - bh * sy) * (match[2] === "YMin" ? 0 : match[2] === "YMid" ? .5 : 1) - by * sy;
          }
          const mapped = doc.createElementNS(SVG, "g");
          mapped.setAttribute("transform", "matrix(" + [sx, 0, 0, sy, tx, ty].join(" ") + ")");
          mapped.append(symbolGroup); viewport.append(mapped);
          nestedWidth = bw; nestedHeight = bh;
        } else { viewport.append(symbolGroup); nestedWidth = w; nestedHeight = h; }
        content = viewport;
      }
      const expanded = expand(content, [...stack, id], nestedWidth, nestedHeight);
      if (expanded) { remapIds(expanded); wrapper.append(expanded); }
      el.replaceWith(wrapper); expandedCount++; return wrapper;
    }
    for (const child of Array.from(el.children)) expand(child, stack, width, height);
    return el;
  }
  expand(root, [], rootWidth, rootHeight);
  for (const symbol of Array.from(root.querySelectorAll("symbol"))) symbol.remove();
  if (expandedCount) warnings.add("已展开 " + expandedCount + " 个本地 SVG 引用，每个实例可独立编辑。");

  // The supplied illustrations use one full-size raster tile per rectangular fill.
  // Normalize only this explicit subset; arbitrary tiling remains an error.
  const patterns = new Map(Array.from(root.querySelectorAll("pattern[id]")).map(el => [el.id, el]));
  function inheritedValue(el: Element, property: string, fallback: string): string {
    for (let node: Element | null = el; node; node = node.parentElement) {
      const value = declarations(node.getAttribute("style") ?? "").get(property) ?? node.getAttribute(property);
      if (value && value !== "inherit") return value;
    }
    return fallback;
  }
  for (const el of elements(root)) {
    if (el.closest("defs,metadata") || ["g", "svg"].includes(el.localName)) continue;
    const styles = declarations(el.getAttribute("style") ?? ""), fill = inheritedValue(el, "fill", "");
    const match = fill.match(/^url\(\s*['"]?#([\w:.-]+)['"]?\s*\)$/), pattern = match ? patterns.get(match[1]) : undefined;
    if (!pattern) continue;
    if (el.localName !== "rect" || (pattern.getAttribute("patternUnits") ?? "objectBoundingBox") !== "objectBoundingBox" ||
        (pattern.getAttribute("patternContentUnits") ?? "userSpaceOnUse") !== "userSpaceOnUse" ||
        number(pattern.getAttribute("width"), 0, 1) !== 1 || number(pattern.getAttribute("height"), 0, 1) !== 1 ||
        number(pattern.getAttribute("x"), 0, 1) !== 0 || number(pattern.getAttribute("y"), 0, 1) !== 0 ||
        pattern.hasAttribute("patternTransform") || pattern.hasAttribute("viewBox") ||
        pattern.querySelectorAll("image").length !== 1 || elements(pattern).some(n => !["pattern", "g", "image"].includes(n.localName))) {
      fail("暂只支持矩形上的单张、整幅图像 pattern；请展开其它平铺图案。");
    }
    const wrapper = doc.createElementNS(SVG, "g");
    attributes(el, wrapper, new Set(["x", "y", "width", "height", "rx", "ry", "fill", "style"]));
    const wrapperStyle = new Map(styles); wrapperStyle.delete("fill"); setStyles(wrapper, wrapperStyle);
    wrapper.setAttribute("fill", "none");
    if (!extraDefs) { extraDefs = doc.createElementNS(SVG, "defs"); root.insertBefore(extraDefs, root.firstChild); }
    const clip = doc.createElementNS(SVG, "clipPath"), clipShape = clone(el), clipId = unique("pattern-clip");
    clip.id = clipId; clip.setAttribute("clipPathUnits", "userSpaceOnUse");
    for (const name of Array.from(clipShape.attributes).map(a => a.name)) if (!["x", "y", "width", "height", "rx", "ry"].includes(name)) clipShape.removeAttribute(name);
    clipShape.setAttribute("fill", "#000"); clip.append(clipShape); extraDefs.append(clip);
    const clipped = doc.createElementNS(SVG, "g"), tile = doc.createElementNS(SVG, "g");
    clipped.setAttribute("clip-path", "url(#" + clipId + ")");
    clipped.setAttribute("opacity", inheritedValue(el, "fill-opacity", "1"));
    tile.setAttribute("transform", "translate(" + number(el.getAttribute("x"), 0, rootWidth) + " " + number(el.getAttribute("y"), 0, rootHeight) + ")");
    for (const child of Array.from(pattern.children)) { const instance = clone(child); remapIds(instance); tile.append(instance); }
    clipped.append(tile); wrapper.append(clipped);
    const outline = clone(el);
    for (const key of ["id", "transform", "opacity", "filter", "clip-path", "mask"]) outline.removeAttribute(key);
    const outlineStyles = new Map(styles);
    for (const key of ["fill", "transform", "opacity", "filter", "clip-path", "mask"]) outlineStyles.delete(key);
    setStyles(outline, outlineStyles); outline.setAttribute("fill", "none"); wrapper.append(outline);
    el.replaceWith(wrapper);
    warnings.add("图像 pattern 已展开为独立图像对象和裁切轮廓；图像像素保持原样。");
  }
  for (const holder of elements(root)) {
    const styles = declarations(holder.getAttribute("style") ?? ""), fill = styles.get("fill") ?? holder.getAttribute("fill") ?? "";
    const match = fill.match(/^url\(\s*['"]?#([\w:.-]+)['"]?\s*\)$/);
    if (match && patterns.has(match[1])) {
      styles.delete("fill"); setStyles(holder, styles); holder.setAttribute("fill", "none");
    }
  }
  // Definitions used only as reference templates no longer need painting semantics.
  for (const pattern of patterns.values()) pattern.remove();
  if (elements(root).length > LIMIT) fail("引用展开后元素超过 12000 个，请拆分文件。");
  return [...warnings];
}
