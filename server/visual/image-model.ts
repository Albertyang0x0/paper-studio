import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { outputPath } from "../storage";
import type { VisualAsset } from "../../shared/visual-contract";
import { runtimeConnection } from '../provider-runtime';
import { providerImage } from '../provider-transport';
import { recordProviderUsage } from '../provider-usage';

export async function rasterBlueprint(data: string | Buffer) {
  if (typeof data === "string" && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z\d+/=]+$/.test(data))
    throw Error("Blueprint must be a local PNG/JPEG/WebP data URL");
  const image = await loadImage(typeof data === "string" ? Buffer.from(data.split(",")[1],"base64") : data);
  const scale = Math.min(1,1600/image.width);
  const canvas = createCanvas(Math.round(image.width*scale),Math.round(image.height*scale));
  canvas.getContext("2d").drawImage(image,0,0,canvas.width,canvas.height);
  const bytes=canvas.toBuffer("image/png");
  return {width:canvas.width,height:canvas.height,bytes,dataUrl:`data:image/png;base64,${bytes.toString("base64")}`};
}
export async function cropBlueprint(dataUrl: string, asset: VisualAsset) {
  const image=await loadImage(Buffer.from(dataUrl.split(",")[1],"base64"));
  const zoom=Math.max(2,160/Math.min(asset.width,asset.height));
  const canvas=createCanvas(Math.round(asset.width*zoom),Math.round(asset.height*zoom));
  const c=canvas.getContext("2d");
  c.fillStyle="#ffffff";c.fillRect(0,0,canvas.width,canvas.height);
  const crop=asset.crop;
  c.drawImage(image,crop.x,crop.y,crop.width,crop.height,0,0,canvas.width,canvas.height);
  return `data:image/png;base64,${canvas.toBuffer("image/png").toString("base64")}`;
}
/** A coordinate guide for the geometry planner, not a deliverable or raster asset. */
export async function blueprintGuide(dataUrl:string,normalized=false) {
  const original=await loadImage(Buffer.from(dataUrl.split(',')[1],'base64'));
  const canvas=createCanvas(original.width,original.height),c=canvas.getContext('2d');
  c.drawImage(original,0,0);c.font='12px Arial';c.textBaseline='top';
  for(let x=0;x<canvas.width;x+=normalized?canvas.width/10:100){c.strokeStyle='#245cab44';c.lineWidth=.6;c.beginPath();c.moveTo(x,0);c.lineTo(x,canvas.height);c.stroke();c.fillStyle='#ffffffdd';c.fillRect(x+2,2,38,16);c.fillStyle='#153a80';c.fillText(String(Math.round(normalized?x/canvas.width*1000:x)),x+4,3);}
  for(let y=0;y<canvas.height;y+=normalized?canvas.height/10:100){c.strokeStyle='#245cab44';c.beginPath();c.moveTo(0,y);c.lineTo(canvas.width,y);c.stroke();c.fillStyle='#ffffffdd';c.fillRect(2,y+2,38,16);c.fillStyle='#153a80';c.fillText(String(Math.round(normalized?y/canvas.height*1000:y)),4,y+3);}
  return `data:image/png;base64,${canvas.toBuffer('image/png').toString('base64')}`;
}
export async function modelImage(model: string, prompt: string, references: string[], signal: AbortSignal, connectionId?: string) {
  const connection=runtimeConnection(connectionId,'image');
  const started=Date.now();
  const result=await providerImage(connection,model,prompt,references,AbortSignal.any([signal,AbortSignal.timeout(360000)]));
  await recordProviderUsage(connection,model,result,started,{kind:'image-design'});
  return rasterBlueprint(result.image!);
}
