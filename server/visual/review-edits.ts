import type { FigureScene } from '../../shared/types';
import { applyReconstructionEdits } from './compiler';

/** Reject malformed model patches individually, so a hallucinated ID cannot discard
 * valid repairs elsewhere. The strict compiler and scientific/lock checks still apply. */
export function applyReviewEdits(scene:FigureScene,report:any) {
  let next=scene;const rejected:{field:string;id:string;reason:string}[]=[];
  for(const field of ['edits','nodeEdits','connectorEdits'])for(const edit of report[field]??[]) {
    try{next=applyReconstructionEdits(next,{[field]:[edit]});}
    catch(error){rejected.push({field,id:String(edit.id),reason:String(error)});}
  }
  return {scene:next,rejected};
}
