type Declaration = { property: string; value: string; important: boolean };
type Specificity = [number, number, number];
type Rule = { selector: string; specificity: Specificity; declarations: Declaration[]; order: number };
function fail(message: string): never { throw new Error("SVG 导入失败：" + message); }

/** Split CSS lists without splitting quoted font names or attribute values. */
function split(value: string, delimiter: string): string[] {
  const result: string[] = []; let start = 0, quote = "", depth = 0;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === "\\") fail("暂不支持 CSS 转义，请先展开样式。");
    if (quote) { if (character === quote) quote = ""; continue; }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === "(" || character === "[") depth++;
    if (character === ")" || character === "]") depth--;
    if (depth < 0) fail("CSS 括号不匹配。");
    if (character === delimiter && depth === 0) { result.push(value.slice(start, index)); start = index + 1; }
  }
  if (quote || depth) fail("CSS 字符串或括号未闭合。");
  result.push(value.slice(start)); return result;
}

function fontDeclarations(value: string): [string, string][] {
  const properties = ["font-style", "font-variant", "font-weight", "font-stretch", "font-size", "line-height", "font-family"];
  if (value === "inherit") return properties.map(property => [property, "inherit"]);
  // Parse the portable, explicit-size subset. CSSOM implementations disagree on
  // slash line-height parsing, so never let a failed parser discard font size.
  const match = value.match(/^((?:[^"'\s]+\s+)*?)(0|(?:\d*\.\d+|\d+\.?\d*)(?:px|pt|pc|mm|cm|in|q|em|ex|rem|%))(?:\s*\/\s*([^\s]+))?\s+(.+)$/i);
  if (!match) fail("暂不支持该 font 简写或系统字体，请指定字号和字体名称。");
  const result = new Map(properties.map(property => [property, "normal"]));
  for (const token of match[1].trim().split(/\s+/).filter(Boolean)) {
    const word = token.toLowerCase();
    if (word === "normal") continue;
    let property: string;
    if (["italic", "oblique"].includes(word)) property = "font-style";
    else if (word === "small-caps") property = "font-variant";
    else if (["bold", "bolder", "lighter"].includes(word) || /^(?:[1-9]\d{0,2}|1000)$/.test(word)) property = "font-weight";
    else if (/^(?:(?:ultra|extra|semi)-)?(?:condensed|expanded)$/.test(word)) property = "font-stretch";
    else return fail("暂不支持 font 简写中的字段：" + token);
    if (result.get(property) !== "normal") fail("font 简写包含重复字段：" + token);
    result.set(property, word);
  }
  const lineHeight = match[3] ?? "normal", family = match[4].trim();
  if (!/^(?:normal|(?:\d*\.\d+|\d+\.?\d*)(?:px|pt|pc|mm|cm|in|q|em|ex|rem|%)?)$/i.test(lineHeight)) fail("font 简写包含不支持的行高。");
  for (const name of split(family, ",").map(name => name.trim())) {
    if (!/^(?:"[^"\r\n]+"|'[^'\r\n]+'|[A-Za-z_-][\w-]*(?:\s+[A-Za-z_-][\w-]*)*)$/.test(name)) fail("font 简写中的字体名称无效。");
  }
  result.set("font-size", match[2]); result.set("line-height", lineHeight); result.set("font-family", family);
  return [...result];
}

function declarations(value: string): Declaration[] {
  const result: Declaration[] = [];
  for (const entry of split(value, ";")) {
    if (!entry.trim()) continue;
    const colon = entry.indexOf(":");
    if (colon < 1) fail("无效的 SVG 样式。");
    const property = entry.slice(0, colon).trim().toLowerCase();
    let content = entry.slice(colon + 1).trim();
    if (!/^-?[a-z][a-z0-9-]*$/.test(property) || !content) fail("无效的 SVG CSS 属性。");
    const important = /!\s*important\s*$/i.test(content);
    if (important) content = content.replace(/!\s*important\s*$/i, "").trim();
    if (/[!@]/.test(content)) fail("暂不支持该 CSS 指令或优先级写法。");
    const expanded = property === "font" ? fontDeclarations(content) : [[property, content]];
    for (const [property, value] of expanded) result.push({ property, value, important });
  }
  return result;
}

/** Accept static compounds joined only by descendant or child combinators. */
function specificity(selector: string): Specificity {
  let index = 0, ids = 0, classes = 0, tags = 0;
  const identifier = /^[A-Za-z_][\w-]*/;
  while (index < selector.length) {
    let count = 0;
    const tag = selector.slice(index).match(/^(?:\*|[A-Za-z_][\w-]*)/);
    if (tag) { index += tag[0].length; count++; if (tag[0] !== "*") tags++; }
    for (;;) {
      const character = selector[index];
      if (character === "." || character === "#") {
        const value = selector.slice(index + 1).match(identifier);
        if (!value) fail("无效的 SVG CSS 选择器：" + selector);
        if (character === "#") ids++; else classes++;
        index += value[0].length + 1; count++;
      } else if (character === "[") {
        let end = index + 1, quote = "";
        for (; end < selector.length; end++) {
          const ch = selector[end];
          if (ch === "\\") fail("暂不支持 CSS 选择器转义。");
          if (quote) { if (ch === quote) quote = ""; }
          else if (ch === '"' || ch === "'") quote = ch;
          else if (ch === "]") break;
        }
        const body = selector.slice(index + 1, end);
        if (end === selector.length || !/^\s*[A-Za-z_][\w-]*(?:\s*(?:[~|^$*]?=)\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[\w-]+)(?:\s+[is])?)?\s*$/.test(body)) fail("暂不支持该 CSS 属性选择器：" + selector);
        index = end + 1; classes++; count++;
      } else break;
    }
    if (!count) fail("暂不支持该 CSS 选择器：" + selector);
    const beforeSpace = index;
    while (/\s/.test(selector[index] ?? "") && index < selector.length) index++;
    if (index === selector.length) break;
    if (selector[index] === ">") {
      index++;
      while (/\s/.test(selector[index] ?? "") && index < selector.length) index++;
      if (index === selector.length) fail("CSS 子元素选择器缺少目标。");
    } else if (beforeSpace === index) fail("暂不支持动态、伪类或兄弟 CSS 选择器：" + selector);
  }
  return [ids, classes, tags];
}

function compare(a: number[], b: number[]): number {
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

/** Freeze author CSS before use expansion changes IDs, ancestry, or tag names. */
export function freezeSvgStyles(root: Element, original: Element[]): void {
  const sheets = original.filter(el => el.localName === "style" && !el.closest("metadata"));
  const rules: Rule[] = [];
  for (const sheet of sheets) {
    const css = (sheet.textContent ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
    let end = 0;
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (css.slice(end, match.index).trim() || /@/.test(match[1])) fail("暂不支持嵌套 CSS 或 @ 指令。");
      const parsed = declarations(match[2]);
      for (const selector of split(match[1], ",").map(value => value.trim())) {
        if (!selector) fail("SVG CSS 选择器不能为空。");
        const weight = specificity(selector);
        try { root.matches(selector); } catch { fail("无效的 SVG CSS 选择器：" + selector); }
        rules.push({ selector, specificity: weight, declarations: parsed, order: rules.length });
      }
      end = match.index! + match[0].length;
    }
    if (css.slice(end).trim()) fail("无效或暂不支持的 SVG 样式表。");
  }
  const frozen: { element: Element; style: string }[] = [];
  for (const el of original.filter(el => !el.closest("metadata"))) {
    const values = new Map<string, { value: string; priority: number[] }>();
    const apply = (entries: Declaration[], inline: boolean, weight: Specificity, order: number) => entries.forEach((entry, index) => {
      const priority = [entry.important ? 1 : 0, inline ? 1 : 0, ...weight, order, index];
      const previous = values.get(entry.property);
      if (!previous || compare(priority, previous.priority) >= 0) values.set(entry.property, { value: entry.value, priority });
    });
    for (const rule of rules) if (el.matches(rule.selector)) apply(rule.declarations, false, rule.specificity, rule.order);
    apply(declarations((el.getAttribute("style") ?? "").replace(/\/\*[\s\S]*?\*\//g, "")), true, [0, 0, 0], rules.length);
    frozen.push({ element: el, style: [...values].map(([key, result]) => key + ":" + result.value).join(";") });
  }
  // Attribute selectors must see only the source DOM. Writing a parent's
  // computed style early would spuriously make `[style] child` match later.
  for (const { element, style } of frozen) {
    if (style) element.setAttribute("style", style);
    else element.removeAttribute("style");
  }
  for (const sheet of sheets) sheet.remove();
}
