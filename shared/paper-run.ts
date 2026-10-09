import type { Candidate, PaperProject, PaperRun } from './paper-types';
import { isCurrentAcceptedCandidate, ProjectConflict, validateCandidate } from './paper-project';

export function validateResumeCandidate(project: PaperProject, candidate: Candidate) {
  if (candidate.status === 'pending') return validateCandidate(project, candidate);
  if (!isCurrentAcceptedCandidate(project, candidate))
    throw new ProjectConflict('已保存的章节或研究材料已变化；请开始新任务，避免覆盖手动修改。');
}

export function runFailureMessage(error: unknown): string {
  const message = String(error instanceof Error ? error.message : error)
    .replace(/sk-or-v1-[a-z0-9]+/gi, '[redacted]');
  if (/Label .* (?:does not fit|cannot fit)/i.test(message))
    return '方法图的文字框空间不足，自动排版未完成。已保存的候选和绘图检查点仍可恢复。';
  return message;
}

export function runStatusLabel(run: PaperRun): string {
  if (run.status === 'running') return '正在执行';
  if (run.status === 'complete') return '执行完成 · 待确认';
  if (run.status === 'partial') return '正文已生成 · 绘图待重试';
  return '执行已停止';
}
