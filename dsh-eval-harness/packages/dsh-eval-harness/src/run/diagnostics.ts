import type { TaskSummary } from './runner.ts'
import type { Diagnostic } from './attribution.ts'

/**
 * Derive conservative diagnostics from task summaries.
 *
 * Every diagnostic carries an evidence pointer and a confidence level. A task
 * that failed without an identifiable execution error yields `unknown/
 * unresolved`; the report must never claim a confirmed harness defect by default.
 * @param tasks - per-task summaries of one run.
 * @param declaredModel - the model target the run confirmed.
 * @returns diagnostics, ordered deterministically by task order.
 */
export function deriveDiagnostics(
  tasks: readonly TaskSummary[],
  declaredModel: { readonly provider: string; readonly model: string },
): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  for (const task of tasks) {
    const evidence = (rule: string, extra: { eventSeq?: number; artifact?: string } = {}): Diagnostic['evidence'] => [
      {
        taskId: task.id,
        rule,
        ...(extra.eventSeq === undefined ? {} : { eventSeq: extra.eventSeq }),
        ...(extra.artifact === undefined ? {} : { artifact: extra.artifact }),
      },
    ]

    if (task.observedModel !== null) {
      const observed = task.observedModel
      if (observed.provider !== declaredModel.provider || observed.model !== declaredModel.model) {
        diagnostics.push({
          kind: 'model-mismatch',
          layer: 'model',
          confidence: 'confirmed',
          note:
            'trace 请求的模型与确认的模型不一致：' +
            observed.provider +
            '/' +
            observed.model +
            ' ≠ ' +
            declaredModel.provider +
            '/' +
            declaredModel.model,
          evidence: evidence('model-mismatch', { artifact: 'trace' }),
        })
      }
    }

    if (task.homeLeaks.length > 0) {
      diagnostics.push({
        kind: 'isolation-home-leak',
        layer: 'harness',
        confidence: 'probable',
        note: 'trace 中出现用户 home 路径：隔离未生效，评测结论不可全信',
        evidence: task.homeLeaks.map((leak) => ({
          taskId: task.id,
          eventSeq: leak.seq,
          artifact: 'trace',
          rule: 'isolation-home-leak',
        })),
      })
    }

    if (task.graderVisibility !== undefined && task.graderVisibility.exposedToAgent.length > 0) {
      diagnostics.push({
        kind: 'grader-visible-to-agent',
        layer: 'adapter',
        confidence: 'confirmed',
        note: 'agent 容器可见判据路径：' + task.graderVisibility.exposedToAgent.join(', '),
        evidence: evidence('grader-visible-to-agent', { artifact: 'agent' }),
      })
    }

    switch (task.executionStatus) {
      case 'timeout':
        diagnostics.push({
          kind: 'episode-timeout',
          layer: 'unknown',
          confidence: 'unresolved',
          note: 'episode 超时且任务未评级；无法区分模型慢、harness 卡住或环境慢',
          evidence: evidence('episode-timeout', { artifact: 'agent' }),
        })
        break
      case 'guard_stopped':
        diagnostics.push({
          kind: 'guard-stopped',
          layer: 'harness',
          confidence: 'possible',
          note: 'loop guard 主动终止 episode；可能是模型循环，也可能是 harness 未收敛',
          evidence: evidence('guard-stopped', { artifact: 'agent' }),
        })
        break
      case 'agent_crashed':
        diagnostics.push({
          kind: 'agent-crashed',
          layer: 'unknown',
          confidence: 'unresolved',
          note: 'agent 进程非零退出（' + String(task.exitCode) + '）；退出原因未识别',
          evidence: evidence('agent-crashed', { artifact: 'agent' }),
        })
        break
      case 'trace_corrupt':
        diagnostics.push({
          kind: 'trace-corrupt',
          layer: 'harness',
          confidence: 'probable',
          note: 'trace 无法读取或缺失，后续步骤级归因不可用',
          evidence: evidence('trace-corrupt', { artifact: 'trace' }),
        })
        break
      case 'verifier_error':
        diagnostics.push({
          kind: 'verifier-error',
          layer: 'benchmark',
          confidence: 'possible',
          note: '判据进程未能给出可用结果：' + (task.verify?.error ?? 'unknown'),
          evidence: evidence('verifier-error', { artifact: 'checks' }),
        })
        break
      case 'not_started':
        diagnostics.push({
          kind: 'task-not-started',
          layer: 'adapter',
          confidence: 'confirmed',
          note: '任务未能启动（workspace 或环境准备失败）',
          evidence: evidence('task-not-started', { artifact: 'task' }),
        })
        break
      case 'completed':
        if (task.taskOutcome === 'failed') {
          const toolErrors = task.metrics?.toolErrors ?? 0
          diagnostics.push({
            kind: 'verifier-failed',
            layer: 'unknown',
            confidence: 'unresolved',
            note:
              '判据失败，但没有足够证据归因到模型/harness/benchmark' +
              (toolErrors > 0 ? '；trace 中有 ' + String(toolErrors) + ' 次工具错误，可进一步钻取' : '；trace 中没有工具级错误'),
            evidence: evidence('verifier-failed', { artifact: 'checks' }),
          })
        }
        break
    }
  }
  return diagnostics
}
