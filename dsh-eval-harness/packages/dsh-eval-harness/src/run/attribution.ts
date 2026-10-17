/** Attribution vocabulary for findings derived from a run trace. */
export type FindingLayer = 'harness' | 'environment' | 'benchmark' | 'adapter'

/** One tool-failure classification: what kind of failure and which layer owns it. */
export interface FailureClassification {
  /** Stable failure kind used for grouping. */
  readonly kind: string
  /** Layer that owns the failure: DSH harness, lab environment, benchmark, or adapter. */
  readonly layer: FindingLayer
  /** Short explanation shown next to the finding. */
  readonly note: string
}

/**
 * Classify one tool failure message into a kind and an attribution layer.
 *
 * The layer is deliberately conservative: host filesystem and network problems
 * are `environment`, not `harness`, because a lab-side defect must not be
 * reported as a DSH defect. Approval gaps in non-interactive runs are a harness
 * behavior; everything unrecognized stays `harness` until evidence says otherwise.
 * @param text - failure text recorded in the tool result.
 * @returns kind, layer, and a one-line note.
 */
export function classifyToolFailure(text: string): FailureClassification {
  if (/requires approval|no approver|approval (is )?unavailable/iu.test(text)) {
    return { kind: 'approval', layer: 'harness', note: '非交互评测下的审批链路不可用' }
  }
  if (/SetNamedSecurityInfoW|grantWrite\(/u.test(text)) {
    return {
      kind: 'sandbox-acl',
      layer: 'environment',
      note: '宿主文件系统权限导致沙箱预处理失败；需在干净环境复现再定性',
    }
  }
  if (/429|RATE_LIMIT|rate limit|quota/iu.test(text)) {
    return {
      kind: 'rate-limit',
      layer: 'environment',
      note: '模型 provider 限流/配额；不是 Harness 缺陷',
    }
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|network/iu.test(text)) {
    return { kind: 'network', layer: 'environment', note: '评测环境网络出口不可用' }
  }
  if (/timed? ?out|timeout/iu.test(text)) {
    return { kind: 'timeout', layer: 'environment', note: '工具或进程超时' }
  }
  return { kind: 'tool-error', layer: 'harness', note: '工具执行失败，未细分' }
}
