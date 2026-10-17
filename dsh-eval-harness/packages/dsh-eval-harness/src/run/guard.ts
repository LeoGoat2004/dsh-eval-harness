/** Step / repetition circuit breaker for one evaluated episode. */
export interface LoopGuardLimits {
  /** Maximum observed step index before the episode is stopped. */
  readonly maxSteps: number
  /** Maximum consecutive identical tool calls before the episode is stopped. */
  readonly maxIdenticalToolCalls: number
}

/** Why an episode was stopped by the guard. */
export interface LoopGuardTrip {
  readonly reason: string
}

/** Incremental observer over one trace's events. */
export interface LoopGuard {
  /**
   * Feed one durable event row.
   * @param event - decoded trace event (`type`, optional `step`, `data`).
   * @returns a trip record once a limit is crossed, otherwise null.
   */
  observe(event: {
    readonly type?: string
    readonly step?: number
    readonly data?: { readonly name?: string; readonly arguments?: string }
  }): LoopGuardTrip | null
}

/**
 * Build the circuit breaker used while an episode is running.
 *
 * The guard is intentionally cheap and deterministic: it watches step indices
 * and consecutive identical tool calls. It never decides task success; it only
 * stops runaway cost and records why.
 * @param limits - explicit limits from the run definition.
 * @returns an incremental guard.
 */
export function createLoopGuard(limits: LoopGuardLimits): LoopGuard {
  let maxStepSeen = 0
  let lastSignature: string | null = null
  let identical = 0
  return {
    observe(event): LoopGuardTrip | null {
      if (typeof event.step === 'number' && Number.isFinite(event.step)) {
        maxStepSeen = Math.max(maxStepSeen, event.step)
        if (maxStepSeen > limits.maxSteps) {
          return { reason: 'loop-guard: max steps exceeded (' + String(maxStepSeen) + ' > ' + String(limits.maxSteps) + ')' }
        }
      }
      if (event.type === 'tool/call') {
        const signature = String(event.data?.name ?? '') + '\u0000' + String(event.data?.arguments ?? '')
        if (signature === lastSignature) {
          identical += 1
        } else {
          lastSignature = signature
          identical = 1
        }
        if (identical > limits.maxIdenticalToolCalls) {
          return {
            reason:
              'loop-guard: identical tool call repeated ' + String(identical) +
              ' times (' + String(event.data?.name ?? 'tool') + ')',
          }
        }
      }
      return null
    },
  }
}
