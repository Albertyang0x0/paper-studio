import { mkdir, readFile, readdir, rename, writeFile, unlink } from "node:fs/promises";
import { setTimeout as delay } from 'node:timers/promises';
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { PaperProject, PaperRun } from "../../shared/paper-types";
import { outputPath } from '../storage';
const validId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function assertId(id: string) {
  if (!validId.test(id)) throw Error("Invalid ID");
}
// Windows may momentarily hold the destination open during reads or AV scans.
// Retry the SAME atomic replacement, never truncate or delete the valid snapshot.
export async function replaceSnapshot(source:string,destination:string,operation:typeof rename=rename){
  for(let attempt=0;;attempt++){
    try{await operation(source,destination);return;}
    catch(error:any){
      if(attempt>=5||!['EPERM','EBUSY','EACCES'].includes(error.code))throw error;
      await delay(Math.min(25*2**attempt,250));
    }
  }
}
export class PaperStore {
  readonly root: string;
  private queues = new Map<string, Promise<unknown>>();
  constructor(root = outputPath('papers')) {
    this.root = resolve(root);
  }
  path(id: string) {
    assertId(id);
    return join(this.root, id, "project.json");
  }
  async load(id: string): Promise<PaperProject> {
    return JSON.parse(await readFile(this.path(id), "utf8"));
  }
  async save(project: PaperProject) {
    await this.atomic(this.path(project.id), project);
  }
  async atomic(path: string, value: unknown) {
    await mkdir(resolve(path, ".."), { recursive: true });
    const temporary = path + "." + randomUUID() + ".tmp";
    await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
    try{await replaceSnapshot(temporary,path);}
    catch(error){await unlink(temporary).catch(()=>{});throw error;}
  }
  async mutate(id: string, change: (p: PaperProject) => void | Promise<void>) {
    assertId(id);
    const previous = this.queues.get(id) ?? Promise.resolve();
    const operation = previous
      .catch(() => {})
      .then(async () => {
        const project = await this.load(id);
        await change(project);
        await this.save(project);
        return project;
      });
    this.queues.set(id, operation);
    void operation
      .finally(() => {
        if (this.queues.get(id) === operation) this.queues.delete(id);
      })
      .catch(() => {});
    return operation;
  }
  async list() {
    let ids: string[];
    try {
      ids = await readdir(this.root);
    } catch (e: any) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
    const projects = await Promise.all(
      ids
        .filter((id) => validId.test(id))
        .map(async (id) => {
          try {
            const p = await this.load(id);
            return {
              id,
              title: p.title,
              updatedAt: p.updatedAt,
              revision: p.revision,
            };
          } catch {
            return null;
          }
        }),
    );
    return projects
      .filter((p) => p !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async saveRun(run: PaperRun) {
    assertId(run.id);
    await this.atomic(join(this.root, "_runs", run.id + ".json"), run);
  }
  async loadRun(id: string): Promise<PaperRun> {
    assertId(id);
    return JSON.parse(
      await readFile(join(this.root, "_runs", id + ".json"), "utf8"),
    );
  }
  async listRuns(projectId: string) {
    assertId(projectId);
    const ids=await readdir(join(this.root,'_runs')).catch(()=>[]);
    const records=await Promise.all(ids.filter(name=>name.endsWith('.json')&&validId.test(name.slice(0,-5))).map(async name=>{
      try{return await this.loadRun(name.slice(0,-5));}catch{return undefined;}
    }));
    return records.filter((run):run is PaperRun=>run?.projectId===projectId)
      .sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,6);
  }
}
