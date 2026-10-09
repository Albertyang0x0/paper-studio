import type { SceneModule, Primitive, StyleTokens } from '../../shared/types';
import { renderedBounds } from '../bounds';
import { allPrimitives } from '../../shared/svg';
import { textBoxes } from '../typography';

type Bounds={x:number;y:number;width:number;height:number};
const cache=new Map<string,Bounds|null>();
/** Small native pictograms are obstacles, while card washes and frames are not.
 * Measure actual path ink instead of a path's usually empty width/height fields. */
export function typographyObstacles(module:SceneModule,style:StyleTokens) {
  const width=module.contentWidth??module.width,height=module.contentHeight??module.height;
  const result:Bounds[]=[];
  const walk=(elements:Primitive[],tx=0,ty=0,sx=1,sy=1)=>{
    for(const e of elements) {
      if(e.type==='text'||e.opacity===0||e.locked&&e.fill==='none')continue;
      if(e.type==='group'&&allPrimitives(e.children??[]).some(p=>p.type==='text')) {
        if(!e.rotation)walk(e.children??[],tx+e.x*sx,ty+e.y*sy,sx*(e.scaleX??1),sy*(e.scaleY??1));continue;
      }
      const key=JSON.stringify([e,style.font]);let bounds=cache.get(key);
      if(bounds===undefined){bounds=renderedBounds([e],width,height,style);if(cache.size>1500)cache.clear();cache.set(key,bounds);}
      if(!bounds)continue;
      const b={x:tx+bounds.x*sx,y:ty+bounds.y*sy,width:bounds.width*sx,height:bounds.height*sy};
      if(b.width<3||b.height<3||b.width>width*.4||b.height>height*.92||b.width*b.height>width*height*.2)continue;
      result.push(b);
    }
  };
  walk(module.elements);return result;
}
export function iconOverlapPenalty(elements:Primitive[],style:StyleTokens,obstacles:Bounds[]) {
  return textBoxes(elements,style).reduce((sum,b)=>sum+obstacles.reduce((n,o)=>{
    const w=Math.min(b.x+b.width,o.x+o.width+3)-Math.max(b.x,o.x-3);
    const h=Math.min(b.y+b.height,o.y+o.height+2)-Math.max(b.y,o.y-2);
    return n+(w>1&&h>2?w*h:0);
  },0),0);
}
/** Canvas and SVG may resolve a font differently. The rendered glyph footprint
 * is the final authority for overflow, including unsupported condensed faces. */
export function nativeGlyphOverflow(module:SceneModule,style:StyleTokens) {
  const onlyType=(elements:Primitive[]):Primitive[]=>elements.flatMap(e=>e.type==='text'?[e]:e.type==='group'?[{...e,children:onlyType(e.children??[])}]:[]);
  const glyphs=onlyType(module.elements);if(!allPrimitives(glyphs).some(e=>e.type==='text'))return 0;
  const width=module.contentWidth??module.width,height=module.contentHeight??module.height;
  const key=JSON.stringify(['glyphs',glyphs,style.font]);let bounds=cache.get(key);
  if(bounds===undefined){bounds=renderedBounds(glyphs,width,height,style);if(cache.size>1500)cache.clear();cache.set(key,bounds);}
  if(!bounds)return 0;
  return Math.max(0,-bounds.x)+Math.max(0,-bounds.y)+Math.max(0,bounds.x+bounds.width-width)+Math.max(0,bounds.y+bounds.height-height);
}
