import { randomUUID } from 'node:crypto';
import type { Candidate, ModuleId, ModuleOutput, PaperProject, PaperRun } from '../../shared/paper-types';
import { moduleLabels } from '../../shared/paper-types';
import { bibliographyMarkdown, newCandidate, touch, validateCandidate } from '../../shared/paper-project';
import { runFailureMessage } from '../../shared/paper-run';
import { executePaperModule } from './adapters';
import { reviewManuscript, reviseReviewedSection } from './research';
import type { PaperStore } from './store';
import { withApiConnections } from '../provider-runtime';

interface GenerationInput {
  baseline: PaperProject;
  run: PaperRun;
  completed: Candidate[];
  store: PaperStore;
  signal: AbortSignal;
  model: string;
  log: (stage: string, message: string) => void;
}

interface GenerationServices {
  execute: typeof executePaperModule;
  review: typeof reviewManuscript;
  revise: typeof reviseReviewedSection;
}

// One orchestration boundary for live execution and zero-cost regression tests.
// An optional visual module may fail without invalidating saved prose. Other
// failures and cancellation still stop the run rather than hiding missing facts.
export async function generatePaperRun(
  input: GenerationInput,
  services: GenerationServices = { execute: executePaperModule, review: reviewManuscript, revise: reviseReviewedSection },
) {
  const { baseline, run, completed, store, signal, model, log } = input;
  const configuration = run.configuration!;
  const selected = configuration.modules;
  const working = structuredClone(baseline);
  const candidateModules = new Map(completed.map(c => [c.id, c.moduleId]));
  const acceptedIds = new Set(completed.filter(c => c.status === 'accepted').map(c => c.id));
  const checkCancelled = () => { if (signal.aborted) throw Error('任务已取消'); };
  checkCancelled();
  for (const c of completed) {
    if (c.status === 'pending') working.modules[c.moduleId].content = c.content;
    if (c.outlineData) working.outlineData = c.outlineData;
    for (const citation of c.citations ?? [])
      if (!working.citations.some(v => v.id === citation.id)) working.citations.push(citation);
    for (const asset of c.assets ?? []) {
      if (!working.assets.some(a => a.id === asset.id)) working.assets.push(asset);
      if (!working.modules.figures.assetIds.includes(asset.id)) working.modules.figures.assetIds.push(asset.id);
    }
  }
  run.moduleFailures = [];
  if (completed.length) log('resume', `恢复任务，保留 ${completed.length} 个已保存候选`);
  const execute = (id: ModuleId) => services.execute({
    contract: 'paper-module/1', project: structuredClone(working), moduleId: id,
    methodId: configuration.methods[id]!, model: configuration.models[id]!,
    connectionId:configuration.connections?.[id],imageConnectionId:configuration.imageConnections?.[id],imageModel:configuration.imageModels?.[id],
    instruction: configuration.instruction, signal,
  }, (stage, message) => log(`${id}/${stage}`, message));
  // Settle rejection immediately so a fast failed figure never creates an
  // unhandled rejection while the prose modules are still running.
  const parallelFigures = run.mode === 'draft' && selected.includes('figures')
    && !completed.some(c => c.moduleId === 'figures') && configuration.methods.figures === 'publication-figures'
    ? execute('figures').then(output => ({ output }), error => ({ error })) : undefined;
  for (const id of selected.filter(id => !completed.some(c => c.moduleId === id))) {
    checkCancelled();
    const methodId = configuration.methods[id]!;
    log(id, `开始 ${moduleLabels[id]}`);
    await store.saveRun(run);
    let output: ModuleOutput;
    try {
      output = id === 'figures' && parallelFigures
        ? await parallelFigures.then(result => { if ('error' in result) throw result.error; return result.output; })
        : id === 'references' && run.mode === 'draft' && configuration.skipReferenceSearch
          ? { content: working.citations.length ? bibliographyMarkdown(working)
            : '[TODO: Retrieve and verify relevant literature before submission.]',
            citations: working.citations, warnings: ['按用户选择跳过联网检索；没有编造文献。'] }
          : id === 'figures' && methodId === 'vector-atelier'
            ? { content: working.modules.figures.content || '[TODO: Add figures using the canvas.]', warnings: [] }
            : await execute(id);
    } catch (error) {
      checkCancelled();
      if (id !== 'figures' || run.mode !== 'draft') throw error;
      const message = runFailureMessage(error);
      run.moduleFailures.push({ moduleId: id, message });
      log('figures/failed', `${message} 正文继续生成；绘图可单独重试。`);
      await store.saveRun(run);
      continue;
    }
    checkCancelled();
    const candidate = newCandidate(baseline, randomUUID(), run.id, id, methodId, configuration.models[id]!, output);
    await store.mutate(baseline.id, current => {
      current.candidates.push(candidate);
      touch(current, '生成模块候选', id);
    });
    run.candidateIds.push(candidate.id);
    candidateModules.set(candidate.id, id);
    working.modules[id].content = output.content;
    if (output.outlineData) working.outlineData = output.outlineData;
    for (const citation of output.citations ?? [])
      if (!working.citations.some(v => v.id === citation.id)) working.citations.push(citation);
    for (const asset of output.assets ?? []) {
      working.assets.push(asset);
      working.modules.figures.assetIds.push(asset.id);
    }
    if (id === 'figures' && output.assets?.length) {
      for (const owner of ['method', 'experiments'] as const) {
        const owned = output.assets.filter(a => a.placement === owner);
        const cid = run.candidateIds.find(cid => candidateModules.get(cid) === owner && !acceptedIds.has(cid));
        if (!owned.length || !cid) continue;
        const refs = owned.filter(a => !working.modules[owner].content.includes(`[fig:${a.key ?? a.id}]`))
          .map(a => `[fig:${a.key ?? a.id}]`).join(' and ');
        if (!refs) continue;
        const note = owner === 'method' ? `An overview of the method is given in ${refs}.`
          : `The source-reported data are visualized in ${refs}.`;
        working.modules[owner].content = note + '\n\n' + working.modules[owner].content;
        await store.mutate(baseline.id, current => {
          current.candidates.find(c => c.id === cid)!.content = working.modules[owner].content;
          touch(current, '关联论文图表', owner);
        });
      }
    }
    log(id, '候选已保存');
    await store.saveRun(run);
  }
  if (run.mode === 'draft' && configuration.reviewRounds) {
    for (let round = run.review?.rounds ?? 0; round < configuration.reviewRounds; round++) {
      checkCancelled();
      const reviewTarget=configuration.models.outline ? 'outline' : selected[0];
      const reviewModel=configuration.models[reviewTarget]||model;
      const report = await withApiConnections({text:configuration.connections?.[reviewTarget]},()=>services.review(working, reviewModel, log, signal));
      report.rounds = round + 1;
      run.review = report;
      await store.saveRun(run);
      // Failed/missing figures cannot be repaired by the prose revision adapter.
      const targets = [...new Set(report.issues.filter(i => i.severity !== 'low').map(i => i.moduleId))]
        .filter(id => id !== 'figures' && selected.includes(id) && !baseline.modules[id].locked
          && run.candidateIds.some(cid => candidateModules.get(cid) === id && !acceptedIds.has(cid)));
      if (!targets.length || round === configuration.reviewRounds - 1) break;
      for (const id of targets) {
        checkCancelled();
        const output = await withApiConnections({text:configuration.connections?.[id]},()=>services.revise({ contract: 'paper-module/1', project: structuredClone(working),
          moduleId: id, methodId: configuration.methods[id]!, model: configuration.models[id]!,
          connectionId:configuration.connections?.[id],instruction: configuration.instruction, signal }, report, (stage, message) => log(`${id}/${stage}`, message)));
        const candidateId = run.candidateIds.find(cid => candidateModules.get(cid) === id)!;
        await store.mutate(baseline.id, current => {
          const candidate = current.candidates.find(c => c.id === candidateId)!;
          validateCandidate(current, candidate);
          Object.assign(candidate, output);
          touch(current, '整稿审查修订候选', id);
        });
        working.modules[id].content = output.content;
        await store.saveRun(run);
      }
    }
    if (run.review?.issues.length) log('review', `审查保留 ${run.review.issues.length} 项供确认`);
  }
  checkCancelled();
  run.status = run.moduleFailures.length ? 'partial' : 'complete';
  if (run.status === 'partial') log('partial', '正文候选已保存；绘图未完成，可重试未完成模块。');
  await store.saveRun(run);
}
