import type { ReconstructionPlan } from '../../shared/visual-contract';
import { normalizedBox } from './compiler';

export const localAssetGeometryPrompt=`You locate small illustrations INSIDE one cropped parent object. The supplied image is the entire parent object, NOT the full paper figure. Detect each assigned illustration's COMPLETE visible silhouette (including protruding tips, handles and highlights), excluding neighboring text and the card itself.
Return JSON {assets:[{id,box_2d:[ymin,xmin,ymax,xmax]}],notes:string}. Every coordinate is normalized 0..1000 relative to THIS CROPPED IMAGE. Return all assigned IDs exactly once. Match the actual colored illustration, not a convenient horizontal row or guessed dimensions. Do not clip a round bullseye, a tall bulb, or the endpoints of a diagonal instrument. Give 1-2 pixels of visual breathing room but no excess background. No input approximate boxes are supplied. Return only detections, not drawing code or a new design.`;

/** Local detection avoids losing half of a 20px illustration in a full-page detection. */
export function applyLocalAssetGeometry(plan:ReconstructionPlan,nodeId:string,raw:any,representatives:Set<string>) {
  const node=plan.nodes.find(n=>n.id===nodeId);if(!node)throw Error('Unknown illustration parent');
  if(!Array.isArray(raw.assets))throw Error('Missing local illustration detections');
  const touched:string[]=[];
  for(const patch of raw.assets) {
    const slot=node.assets.find(s=>s.assetId===patch.id),asset=plan.assets.find(a=>a.id===patch.id);
    if(!slot||!asset||touched.includes(patch.id))throw Error('Unknown or duplicate local illustration');
    const box=normalizedBox(patch.box_2d,node.width,node.height);
    if(box.width<4||box.height<4)throw Error('Implausibly small illustration detection');
    Object.assign(slot,box);touched.push(asset.id);
    if(!representatives.has(asset.id)) {
      asset.crop={...box,x:node.x+box.x,y:node.y+box.y};
      asset.width=Math.max(8,Math.round(box.width));asset.height=Math.max(8,Math.round(box.height));representatives.add(asset.id);
    }
  }
  return touched;
}
