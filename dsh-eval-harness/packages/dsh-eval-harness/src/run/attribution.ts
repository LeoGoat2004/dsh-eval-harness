/** Conservative attribution vocabulary for findings derived from a run. */
export type FindingLayer = 'model' | 'harness' | 'benchmark' | 'environment' | 'adapter' | 'unknown'

/** How strongly the evidence supports a finding. */
export type Confidence = 'confirmed' | 'probable' | 'possible' | 'unresolved'

/** One piece of evidence pointing at a task artifact and the rule that fired. */
export interface FindingEvidence {
  readonly taskId: string
  /** Durable trace sequence number, when the evidence is a trace row. */
  readonly eventSeq?: number
  /** Artifact path relative to the task directory, when applicable. */
  readonly artifact?: string
  /** Stable rule id that produced this evidence. */
  readonly rule: string
}

/** One conservative diagnostic entry stored in the run report. */
export interface Diagnostic {
  readonly kind: string
  readonly layer: FindingLayer
  readonly confidence: Confidence
  readonly note: string
  readonly evidence: readonly FindingEvidence[]
}

/** One tool-failure classification: what kind of failure and which layer owns it. */
export interface FailureClassification {
  readonly kind: string
  readonly layer: FindingLayer
  readonly confidence: Confidence
  readonly note: string
}

/**
 * Classify one tool failure message into a kind, layer and confidence.
 *
 * The default is deliberately `unknown/unresolved`: an unrecognized failure is
 * never reported as a confirmed harness defect. Only explicit provider or host
 * errors get confirmed attribution.
 * @param text - failure text recorded in the tool result.
 * @returns classification with conservative confidence.
 */
export function classifyToolFailure(text: string): FailureClassification {
  if (/401|unauthorized|invalid api key|authentication/iu.test(text)) {
    return { kind: 'model-auth', layer: 'model', confidence: 'confirmed', note: '模型凭据或鉴权失败' }
  }
  if (/model (not found|does not exist)|unknown model|context length|content filter/iu.test(text)) {
    return { kind: 'model-request', layer: 'model', confidence: 'probable', note: '模型拒绝了该请求' }
  }
  if (/requires approval|no approver|approval (is )?unavailable/iu.test(text)) {
    return {
      kind: 'approval',
      layer: 'harness',
      confidence: 'probable',
      note: '非交互评测下的审批链路不可用；是否属于配置问题需对照实验',
    }
  }
  if (/SetNamedSecurityInfoW|grantWrite\(/u.test(text)) {
    return {
      kind: 'sandbox-acl',
      layer: 'environment',
      confidence: 'probable',
      note: '宿主文件系统权限导致沙箱预处理失败；需在干净环境复现再定性',
    }
  }
  if (/429|RATE_LIMIT|rate limit|quota/iu.test(text)) {
    return { kind: 'rate-limit', layer: 'environment', confidence: 'confirmed', note: '模型 provider 限流/配额；不是 Harness 缺陷' }
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|network/iu.test(text)) {
    return { kind: 'network', layer: 'environment', confidence: 'probable', note: '评测环境网络出口不可用' }
  }
  if (/timed? ?out|timeout/iu.test(text)) {
    return { kind: 'timeout', layer: 'unknown', confidence: 'unresolved', note: '超时来源无法从该行确定' }
  }
  return { kind: 'tool-error', layer: 'unknown', confidence: 'unresolved', note: '工具执行失败，未识别原因' }
}
