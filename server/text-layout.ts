import { createCanvas } from "@napi-rs/canvas";
import type { Primitive, StyleTokens } from "../shared/types";
import { displayMath } from "../shared/math-text";
import {canvasFont} from './font-metrics';
const ctx = createCanvas(1, 1).getContext("2d");

export function fitModuleText(
  items: Primitive[],
  width: number,
  height: number,
  style: StyleTokens,
): Primitive[] {
  // Labels and their containers share one detached object graph. Resizing a
  // copied label alone leaves the rectangle (and the saved checkpoint) stale.
  const fitted = structuredClone(items);
  return fitted.map((e) => {
    if (e.locked) return e;
    if (e.type === "group") {
      e.children = fitModuleText(
        e.children ?? [],
        (width - e.x) / (e.scaleX ?? 1),
        (height - e.y) / (e.scaleY ?? 1),
        style,
      );
      return e;
    }
    if (e.type !== "text" || !e.text) return e;
    if(style.minimumFontSize)e.fontSize=Math.max(e.fontSize??style.bodySize,style.minimumFontSize);
    const container=e.containerId ? fitted.find(shape=>shape.id===e.containerId&&shape.type==='rect') : undefined;
    if(e.containerId&&!container)throw Error(`Unknown label container ${e.containerId}`);
    if(container){e.x=container.x+8;e.width=container.width!-16;}
    const size = e.fontSize ?? style.bodySize;
    ctx.font = canvasFont(e.fontFamily??style.font,size,e.fontWeight??400,!!e.italic);
    // Without a box, the SVG renderer anchors center/right text at x itself.
    // Introducing a wrap box must preserve that anchor, not move the glyphs
    // to the midpoint of all remaining canvas space.
    const implicitAnchor = e.width === undefined && (e.align === 'center' || e.align === 'right');
    const naturalWidth = Math.max(...e.text.split('\n').map(line => ctx.measureText(displayMath(line)).width)) + 6;
    const limit = implicitAnchor
      ? e.align === 'center' ? Math.min(2*e.x,2*(width-e.x-5)) : e.x
      : width-e.x-5;
    let available = Math.max(1, Math.min(e.width ?? naturalWidth, limit));
    if(implicitAnchor)e.x -= e.align === 'center' ? available/2 : available;
    const originalText = e.text;
    const wrap = (space: number) => {
      const lines: string[] = [];
      for (const paragraph of originalText.split("\n")) {
        if (ctx.measureText(displayMath(paragraph)).width <= space - 3) {
          lines.push(paragraph);
          continue;
        }
        // Preserve words and exact content. Breaking is geometry, not a paraphrase.
        const words = paragraph.match(
          /[\u3400-\u9fff]|[^\s\u3400-\u9fff]+/gu,
        ) ?? [""];
        let line = "";
        for (const word of words) {
          const separator =
            /[\u3400-\u9fff]$/u.test(line) || /^[\u3400-\u9fff]/u.test(word)
              ? ""
              : " ";
          const candidate = line ? line + separator + word : word;
          if (
            line &&
            ctx.measureText(displayMath(candidate)).width > space - 3
          ) {
            lines.push(line);
            line = word;
          } else line = candidate;
        }
        lines.push(line);
      }
      return lines;
    };
    let lines = wrap(available);
    if (container) {
      const tooTall = lines.length * size * 1.24 > container.height! - 8;
      const tooWide = lines.some(line => ctx.measureText(displayMath(line)).width > available - 3);
      if (tooTall || tooWide) {
        if (container.locked || fitted.some(label => label.containerId === container.id && label.locked))
          throw Error(`Label ${e.id} does not fit locked container ${container.id}; unlock the shape before reflowing it`);
        // First recover space lost to unnecessary wrapping, then grow vertically.
        // Never paraphrase, crop, or reduce the readable font to make a box fit.
        const nextWidth = Math.max(container.width!, Math.min(naturalWidth + 19, width - 10));
        const centerX = container.x + container.width! / 2;
        container.width = nextWidth;
        container.x = Math.max(0, Math.min(centerX - nextWidth / 2, width - nextWidth));
        e.x = container.x + 8;
        available = nextWidth - 16;
        lines = wrap(available);
        const nextHeight = Math.max(container.height!, Math.ceil(lines.length * size * 1.24 + 8));
        if (nextHeight > height || lines.some(line => ctx.measureText(displayMath(line)).width > available - 3))
          throw Error(`Label ${e.id} cannot fit module ${width} × ${height}; reflow the module into more space without shrinking the font`);
        container.height = nextHeight;
        container.y = Math.max(0, Math.min(container.y, height - nextHeight));
      }
    }
    e.text = lines.join("\n");
    e.width = available;
    if(container){
      const blockHeight=lines.length*size*1.24;
      e.y=container.y+(container.height!-blockHeight)/2;
    }
    return e;
  });
}
