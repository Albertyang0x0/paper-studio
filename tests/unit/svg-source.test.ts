import test from "node:test";
import assert from "node:assert/strict";
import { svgXmlSource } from "../../src/figure/svg-source";

const drawing = '<svg xmlns="http://www.w3.org/2000/svg"><text>&amp; &#65; &#x42;</text></svg>';
const svg11 = "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd";
const svg10 = "http://www.w3.org/TR/2001/REC-SVG-20010904/DTD/svg10.dtd";

test("SVG without a DTD preserves the XML declaration, artwork, and character references", () => {
  const source = '<?xml version="1.0" encoding="UTF-8"?>\n<!-- exported drawing -->\n' + drawing;
  assert.equal(svgXmlSource(source), source);
});

test("standard SVG PUBLIC headers are removed without resolving or expanding the DTD", () => {
  for (const [version, url] of [["1.0", svg10], ["1.1", svg11]]) {
    for (const quote of ['"', "'"]) {
      const header = `<!DOCTYPE svg PUBLIC ${quote}-//W3C//DTD SVG ${version}//EN${quote}\n  ${quote}${url}${quote}>`;
      const source = '<?xml version="1.0"?>\n' + header + "\n" + drawing;
      assert.equal(svgXmlSource(source), '<?xml version="1.0"?>\n\n' + drawing);
    }
  }
  // Unknown entity references remain unresolved for the XML parser to reject;
  // the preflight never supplies definitions from an external SVG DTD.
  const body = '<svg xmlns="http://www.w3.org/2000/svg"><text>&externalName;</text></svg>';
  assert.equal(svgXmlSource(`<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "${svg11}">` + body), body);
});

test("standard SVG SYSTEM headers support either quote style and HTTP or HTTPS", () => {
  for (const url of [svg10, svg11, svg10.replace("http:", "https:"), svg11.replace("http:", "https:")]) {
    for (const quote of ['"', "'"]) {
      assert.equal(svgXmlSource(`<!DOCTYPE svg SYSTEM ${quote}${url}${quote}>` + drawing), drawing);
    }
  }
});

test("a simple SVG DOCTYPE is inert and can be removed", () => {
  for (const header of ["<!DOCTYPE svg>", "<!DOCTYPE\nsvg  >"]) {
    assert.equal(svgXmlSource(header + "\n" + drawing), "\n" + drawing);
  }
});

test("internal subsets and entity declarations are rejected before XML parsing", () => {
  const headers = [
    '<!DOCTYPE svg [<!ENTITY label "expanded text">]>',
    '<!DOCTYPE svg [<!ENTITY external SYSTEM "file:///private-data">]>',
    '<!DOCTYPE svg [<!ENTITY % external SYSTEM "https://example.invalid/entities.dtd">%external;]>',
    `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "${svg11}" [<!ENTITY label "text">]>`,
    "<!DOCTYPE svg []>",
    '<!ENTITY label "text">',
  ];
  for (const header of headers) assert.throws(() => svgXmlSource(header + drawing), /SVG 导入失败/);
});

test("unknown, relative, and local DTD resources remain rejected", () => {
  const headers = [
    '<!DOCTYPE svg SYSTEM "https://example.invalid/svg.dtd">',
    '<!DOCTYPE svg SYSTEM "svg11.dtd">',
    '<!DOCTYPE svg SYSTEM "file:///svg11.dtd">',
    '<!DOCTYPE svg SYSTEM "https://www.w3.org/other.dtd">',
    `<!DOCTYPE svg PUBLIC "-//EXAMPLE//DTD SVG 1.1//EN" "${svg11}">`,
    `<!DOCTYPE html SYSTEM "${svg11}">`,
    `<!DOCTYPE svg SYSTEM "${svg11}?resource=other">`,
  ];
  for (const header of headers) assert.throws(() => svgXmlSource(header + drawing), /标准 SVG 文件头/);
});

test("XML stylesheet instructions are rejected even with an otherwise safe SVG header", () => {
  for (const instruction of [
    '<?xml-stylesheet type="text/css" href="figure.css"?>',
    '<?xml-stylesheet type="text/css" href="https://example.invalid/figure.css"?>',
    '<?XML-STYLESHEET href="figure.css"?>',
  ]) {
    assert.throws(() => svgXmlSource(`<!DOCTYPE svg SYSTEM "${svg11}">` + instruction + drawing), /实体声明或外部样式表/);
  }
});

test("a safe header does not hide a second unsupported DTD or declaration", () => {
  const header = `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "${svg11}">`;
  assert.throws(() => svgXmlSource(header + '<!DOCTYPE svg SYSTEM "https://example.invalid/other.dtd">' + drawing), /标准 SVG 文件头/);
  assert.throws(() => svgXmlSource(header + '<!ENTITY label "text">' + drawing), /实体声明或外部样式表/);
});
