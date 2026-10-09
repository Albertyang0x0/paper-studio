import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { Material } from '../../shared/types';

export interface FigureJobInput {
  material: Material[];
  model: string;
  instruction: string;
  outline?: Record<string, unknown>;
  pipeline?: string;
  imageModel?: string;
  connectionIdentity?: unknown;
}

const fingerprint = (identity: unknown) => createHash('sha256')
  .update(JSON.stringify(identity)).digest('hex').slice(0, 20);

export async function figureJobDirectory(parent: string, input: FigureJobInput): Promise<string> {
  const { material, model, instruction, outline } = input;
  if(input.connectionIdentity)return join(parent,fingerprint({material,model,instruction,pipeline:input.pipeline,imageModel:input.imageModel,connectionIdentity:input.connectionIdentity,version:5}));
  if (input.pipeline) return join(parent, fingerprint({material,model,instruction,pipeline:input.pipeline,imageModel:input.imageModel,version:4}));
  // These figures are grounded in source materials, not unaccepted outline
  // prose. Including that prose in the key used to invalidate expensive image
  // proposals as soon as an outline candidate was recovered on resume.
  const current = fingerprint({ material, model, instruction, version: 3 });
  const legacy = [outline, undefined].map(savedOutline => fingerprint({
    material, model, outline: savedOutline, instruction, version: 2,
  }));
  for (const key of [current, ...new Set(legacy)]) {
    const dir = join(parent, key);
    try { await access(dir); return dir; }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
  return join(parent, current);
}
