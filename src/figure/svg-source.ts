/** Strip inert SVG export headers without resolving a DTD or XML entities. */
export function svgXmlSource(source: string): string {
  if (/<!ENTITY|<\?xml-stylesheet/i.test(source)) throw new Error("SVG 导入失败：不支持实体声明或外部样式表。");
  const header = /<!DOCTYPE\s+svg\s+(?:PUBLIC\s+(["'])-\/\/W3C\/\/DTD SVG (?:1\.0|1\.1)\/\/EN\1\s+)?(["'])https?:\/\/www\.w3\.org\/(?:Graphics\/SVG\/1\.1\/DTD\/svg11\.dtd|TR\/2001\/REC-SVG-20010904\/DTD\/svg10\.dtd)\2\s*>/i;
  // SYSTEM and PUBLIC declarations differ only in the keyword before the URL.
  const safe = source.replace(/<!DOCTYPE\s+svg\s+SYSTEM\s+/gi, '<!DOCTYPE svg ')
    .replace(header, '').replace(/<!DOCTYPE\s+svg\s*>/i, '');
  if (/<!DOCTYPE/i.test(safe)) throw new Error("SVG 导入失败：仅支持无内部实体的标准 SVG 文件头。");
  return safe;
}
