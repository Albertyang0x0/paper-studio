import type { Primitive } from "./types";
const p = (
  id: string,
  path: string,
  fill = "none",
  stroke = "#24384B",
  strokeWidth = 2,
): Primitive => ({
  id,
  type: "path",
  x: 0,
  y: 0,
  path,
  fill,
  stroke,
  strokeWidth,
});
const rect = (
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  fill: string,
  radius = 5,
): Primitive => ({
  id,
  type: "rect",
  x,
  y,
  width,
  height,
  fill,
  stroke: "#24384B",
  strokeWidth: 2,
  radius,
});
const circle = (
  id: string,
  x: number,
  y: number,
  width: number,
  fill: string,
): Primitive => ({
  id,
  type: "ellipse",
  x,
  y,
  width,
  height: width,
  fill,
  stroke: "#24384B",
  strokeWidth: 1.5,
});
export const symbolNames = [
  "robot",
  "database",
  "document",
  "snowflake",
  "shield",
  "magnifier",
  "tensor",
  "flame",
  "target",
  "network",
  "graduation-cap",
  "lock",
];
export function symbolElements(name: string): Primitive[] {
  if (name === "robot")
    return [
      p("antenna", "M32 14V6"),
      circle("tip", 29, 1, 6, "#A9DBE7"),
      rect("left-ear", 5, 28, 8, 15, "#8DB9CC"),
      rect("right-ear", 51, 28, 8, 15, "#8DB9CC"),
      rect("body", 12, 18, 40, 36, "#BCDDEB", 12),
      rect("face", 17, 24, 30, 23, "#314C63", 8),
      circle("eye-left", 23, 31, 5, "#61E0EA"),
      circle("eye-right", 36, 31, 5, "#61E0EA"),
      p("smile", "M27 41Q32 45 37 41", "none", "#61E0EA", 2),
    ];
  if (name === "database")
    return [
      p("body", "M9 13V51C9 62 55 62 55 51V13", "#566FA8", "#273958"),
      {
        id: "top",
        type: "ellipse",
        x: 9,
        y: 3,
        width: 46,
        height: 20,
        fill: "#8592C1",
        stroke: "#273958",
        strokeWidth: 2,
      },
      p(
        "rings",
        "M9 27C9 38 55 38 55 27M9 40C9 51 55 51 55 40",
        "none",
        "#B6C8E4",
        2,
      ),
      circle("dot1", 43, 27, 4, "#E9BE55"),
      circle("dot2", 43, 40, 4, "#E9BE55"),
      circle("dot3", 43, 52, 4, "#E9BE55"),
    ];
  if (name === "document")
    return [
      p("page", "M14 5H40L51 17V59H14Z", "#F7FAFC"),
      p("fold", "M40 5V18H51"),
      p("lines", "M22 27H43M22 35H43M22 43H43M22 51H35", "none", "#6D91A6", 2),
    ];
  if (name === "snowflake")
    return [
      p(
        "snow",
        "M32 4V60M8 18L56 46M8 46L56 18M24 9L32 17L40 9M24 55L32 47L40 55M8 28L18 24L16 14M48 50L46 40L56 36M8 36L18 40L16 50M48 14L46 24L56 28",
        "none",
        "#237CA7",
        3,
      ),
    ];
  if (name === "graduation-cap")
    return [
      p("cap", "M3 23L32 8L61 23L32 37Z", "#D5E9D9", "#366C4D", 2),
      p("base", "M15 31V46Q32 60 49 46V31", "none", "#366C4D", 3),
      p("tassel", "M59 24V47", "none", "#D39C44", 3),
      circle("end", 56, 46, 6, "#EBC674"),
    ];
  if (name === "lock")
    return [
      p("shackle", "M20 29V18C20 0 44 0 44 18V29", "none", "#587895", 4),
      rect("body", 11, 26, 42, 33, "#E2EAF1", 7),
      circle("key", 29, 36, 6, "#587895"),
      p("slot", "M32 42V49", "none", "#587895", 3),
    ];
  if (name === "shield")
    return [
      p(
        "shield",
        "M32 5L53 14V32Q52 50 32 60Q12 50 11 32V14Z",
        "#E3F1E3",
        "#2C6945",
        3,
      ),
      p("check", "M22 31L29 39L44 23", "none", "#2C6945", 3),
    ];
  if (name === "magnifier")
    return [
      circle("lens", 6, 6, 36, "#F9EEE2"),
      p("handle", "M37 37L58 58", "none", "#B96732", 5),
    ];
  if (name === "flame")
    return [
      p(
        "flame",
        "M34 2C41 16 53 22 51 37C58 47 43 61 30 61C12 61 5 44 16 28C18 37 22 36 24 29C22 17 31 14 34 2Z",
        "#F49B48",
        "#B96930",
        1.5,
      ),
      p(
        "core",
        "M32 32C45 46 38 55 30 55C22 55 20 45 32 32Z",
        "#FFE9A9",
        "none",
      ),
    ];
  if (name === "target")
    return [
      circle("outer", 5, 5, 54, "#FFF7EB"),
      circle("middle", 16, 16, 32, "#EAD2B9"),
      circle("inner", 26, 26, 12, "#D4814F"),
      p("arrow", "M33 30L58 5M46 5H58V17", "none", "#416D82", 3),
    ];
  if (name === "network")
    return [
      p(
        "edges",
        "M12 12L32 23L52 12M12 32L32 23L52 32M12 52L32 42L52 32M32 23V42M12 12V52",
        "none",
        "#729CA7",
        1.5,
      ),
      ...[
        { x: 7, y: 7 },
        { x: 7, y: 27 },
        { x: 7, y: 47 },
        { x: 27, y: 18 },
        { x: 27, y: 37 },
        { x: 47, y: 7 },
        { x: 47, y: 27 },
      ].map((v, i) => circle("n" + i, v.x, v.y, 10, "#C2DFE5")),
    ];
  return Array.from({ length: 12 }, (_, i) =>
    rect(
      "cell" + i,
      5 + (i % 4) * 14,
      11 + Math.floor(i / 4) * 15,
      11,
      11,
      i % 3 === 0 ? "#96B1C3" : "#D6E0E8",
      2,
    ),
  );
}
export function expandPrimitive(item: Primitive): Primitive {
  if (item.type === "symbol")
    return {
      ...item,
      type: "group",
      scaleX: (item.width ?? 64) / 64,
      scaleY: (item.height ?? 64) / 64,
      children: symbolElements(item.symbol ?? "tensor").map((c) => ({
        ...c,
        id: item.id + "-" + c.id,
      })),
    };
  return { ...item, children: item.children?.map(expandPrimitive) };
}
