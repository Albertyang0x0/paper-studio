import test from "node:test";
import assert from "node:assert/strict";
import { getEnv } from "fabric/node";
import { Resvg } from "@resvg/resvg-js";
import { normalizeSvgDocument } from "../../src/figure/normalize-svg";

const env = getEnv().window;
function document(content: string) {
  const source = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="160" height="80">${content}</svg>`;
  const root: Element = new env.DOMParser().parseFromString(source, "image/svg+xml").documentElement;
  return { source, root };
}

test("local gradient chains inherit missing settings and stops without overriding child coordinates", () => {
  const { root } = document(`<defs>
    <linearGradient id="child" href="#middle" x2="120" gradientTransform="translate(3 4)"/>
    <linearGradient id="middle" xlink:href="#base" y2="70"/>
    <linearGradient id="base" x1="10" y1="20" x2="100" y2="60" gradientUnits="userSpaceOnUse" gradientTransform="scale(2)" spreadMethod="pad">
      <stop id="red" offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/>
    </linearGradient></defs><rect width="160" height="80" fill="url(#child)"/>`);
  normalizeSvgDocument(root);
  const child = root.querySelector("#child")!;
  for (const [name, value] of Object.entries({ x1: "10", y1: "20", x2: "120", y2: "70", gradientUnits: "userSpaceOnUse", gradientTransform: "translate(3 4)", spreadMethod: "pad" })) {
    assert.equal(child.getAttribute(name), value, name);
  }
  assert.equal(child.querySelectorAll("stop").length, 2);
  assert.equal(root.querySelectorAll("[href], [*|href]").length, 0);
  const ids = Array.from(root.querySelectorAll("[id]"), el => el.id);
  assert.equal(new Set(ids).size, ids.length, "borrowed stops receive unique IDs");
});

test("one local stop replaces the borrowed stop list and href takes precedence over xlink:href", () => {
  const { root } = document(`<defs>
    <linearGradient id="base" x1="25"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>
    <linearGradient id="child" href="#base" xlink:href="#missing"><stop stop-color="green"/></linearGradient>
    </defs>`);
  normalizeSvgDocument(root);
  const child = root.querySelector("#child")!;
  assert.equal(child.getAttribute("x1"), "25");
  assert.equal(child.children.length, 1);
  assert.equal(child.children[0].getAttribute("stop-color"), "green");
  assert.equal(child.hasAttributeNS("http://www.w3.org/1999/xlink", "href"), false);
});

test("materialized gradient preserves pixels, frozen CSS, currentColor and explicit inherited stop opacity", () => {
  const { root, source } = document(`<style>#base stop { stop-color:currentColor }</style><defs color="#d81b60">
    <linearGradient id="base" x1="0" x2="160" gradientUnits="userSpaceOnUse" stop-opacity="0.6">
      <stop id="first" offset="0" stop-opacity="inherit"/><stop offset="1" style="color:#1565c0"/>
    </linearGradient>
    <linearGradient id="middle" href="#base" color="yellow"/>
    <linearGradient id="child" xlink:href="#middle" color="green" stop-opacity="0.1"/>
    </defs><rect width="160" height="80" fill="url(#child)"/>`);
  normalizeSvgDocument(root);
  const normalized = new env.XMLSerializer().serializeToString(root);
  assert.deepEqual(new Resvg(normalized).render().pixels, new Resvg(source).render().pixels);
});

test("use templates receive standalone gradients before local IDs are remapped", () => {
  const { root, source } = document(`<defs><g id="tile"><defs>
    <linearGradient id="base"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>
    <linearGradient id="child" href="#base"/>
    </defs><rect width="60" height="70" fill="url(#child)"/></g></defs>
    <use href="#tile"/><use href="#tile" x="80"/>`);
  normalizeSvgDocument(root);
  assert.equal(root.querySelectorAll("use").length, 0);
  assert.equal(root.querySelectorAll("linearGradient[href]").length, 0);
  const normalized = new env.XMLSerializer().serializeToString(root);
  assert.deepEqual(new Resvg(normalized).render().pixels, new Resvg(source).render().pixels);
});

test("gradient references reject cycles, missing targets, wrong types and network resources", () => {
  for (const [content, message] of [
    ['<defs><linearGradient id="a" href="#b"/><linearGradient id="b" href="#a"/></defs>', /循环渐变引用/],
    ['<defs><linearGradient href="#missing"/></defs>', /渐变引用目标不存在/],
    ['<defs><rect id="target"/><linearGradient href="#target"/></defs>', /目标为 <rect>/],
    ['<defs><linearGradient href="https://example.com/a.svg#gradient"/></defs>', /不会获取网络资源/],
    ['<defs><linearGradient id="base"><stop onload="alert(1)"/></linearGradient><linearGradient href="#base"/></defs>', /事件处理代码/],
  ] as const) assert.throws(() => normalizeSvgDocument(document(content).root), message);
});

test("gradient template expansion respects reference depth and element budgets", () => {
  const chain = Array.from({ length: 35 }, (_, index) => `<linearGradient id="g${index}" ${index < 34 ? `href="#g${index + 1}"` : ""}/>`).join("");
  assert.throws(() => normalizeSvgDocument(document(`<defs>${chain}</defs>`).root), /渐变引用嵌套超过 32 层/);
  const stops = Array.from({ length: 100 }, (_, index) => `<stop offset="${index / 100}"/>`).join("");
  const copies = Array.from({ length: 125 }, (_, index) => `<linearGradient id="copy${index}" href="#base"/>`).join("");
  assert.throws(() => normalizeSvgDocument(document(`<defs><linearGradient id="base">${stops}</linearGradient>${copies}</defs>`).root), /引用展开后对象过多/);
});
