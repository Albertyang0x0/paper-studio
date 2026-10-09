import { createCanvas, loadImage } from '@napi-rs/canvas';
import { Resvg } from '@resvg/resvg-js';
import type { FigureScene } from '../../shared/types';
import { sceneSvg } from '../../shared/svg';
import { applyReconstructionEdits } from './compiler';
import { textBoxes, textCollisions } from '../typography';
import { iconOverlapPenalty, nativeGlyphOverflow, typographyObstacles } from './type-obstacles';

/** A critic proposal is not evidence that it improves the image. Accept native
 * geometry/paint edits only when actual changed-pixel error does not increase.
 * This is a local rendering tool, not a fabricated publication-quality score. */
export async function guardVisualEdits(before:FigureScene,reference:string,report:any) {
  const read=async(data:Buffer)=>{const picture=await loadImage(data),c=createCanvas(before.width,before.height).getContext('2d');c.drawImage(picture,0,0,before.width,before.height);return c.getImageData(0,0,before.width,before.height).data;};
  const render=async(scene:FigureScene)=>read(new Resvg(sceneSvg(scene,false),{font:{loadSystemFonts:true,defaultFontFamily:scene.style.font}}).render().asPng());
  const target=await read(Buffer.from(reference.split(',')[1],'base64'));
  const typographyPenalty=(s:FigureScene)=>s.modules.reduce((sum,m)=>{
    const boxes=textBoxes(m.elements,s.style),w=m.contentWidth??m.width,h=m.contentHeight??m.height;
    return sum+boxes.reduce((overflow,b)=>overflow+Math.max(0,-b.x-3)+Math.max(0,-b.y-3)+Math.max(0,b.x+b.width-w-3)+Math.max(0,b.y+b.height-h-3),0)+textCollisions(m.elements,s.style).length*20
      +iconOverlapPenalty(m.elements,s.style,typographyObstacles(m,s.style))*.1+nativeGlyphOverflow(m,s.style);
  },0);
  let scene=structuredClone(before),pixels=await render(scene);const audit:any[]=[];
  for(const field of ['edits','nodeEdits','connectorEdits'])for(const edit of report[field]??[]) {
    let candidate:FigureScene;
    try{candidate=applyReconstructionEdits(scene,{[field]:[edit]});}
    catch(error){audit.push({field,id:edit.id,accepted:false,reason:String(error)});continue;}
    const proposed=await render(candidate);let oldLoss=0,newLoss=0,count=0;
    for(let i=0;i<pixels.length;i+=4) {
      if(Math.abs(pixels[i]-proposed[i])+Math.abs(pixels[i+1]-proposed[i+1])+Math.abs(pixels[i+2]-proposed[i+2])<6)continue;
      for(let c=0;c<3;c++){oldLoss+=(pixels[i+c]-target[i+c])**2;newLoss+=(proposed[i+c]-target[i+c])**2;}count++;
    }
    const noNewTypographyDefect=typographyPenalty(candidate)<=typographyPenalty(scene)+1;
    const accepted=noNewTypographyDefect&&(count===0||newLoss<=oldLoss*1.01);
    if(accepted){scene=candidate;pixels=proposed;}
    audit.push({field,id:edit.id,accepted,reason:noNewTypographyDefect?undefined:'Introduces text overflow or collision',changedPixels:count,previousError:count?oldLoss/count:0,proposedError:count?newLoss/count:0});
  }
  return {scene,audit};
}
