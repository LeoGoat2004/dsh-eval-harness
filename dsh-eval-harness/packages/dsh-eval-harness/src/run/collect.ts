import { readFileSync } from 'node:fs'

/** One durable session event row. */
export interface TraceEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: Record<string, unknown>
}

/** A decoded session log. */
export interface Trace {
  readonly header: Record<string, unknown>
  readonly events: readonly TraceEvent[]
  readonly skippedLines: number
}

/** Fixed metrics folded from one trace. */
export interface TraceMetrics {
  readonly turns: number
  readonly steps: number
  readonly toolCalls: number
  readonly toolResults: number
  readonly toolErrors: number
  readonly retries: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly reasoningTokens: number
  readonly totalTokens: number
  readonly contextTokens: number
  readonly llmMs: number
  readonly toolMs: number
  readonly latencyMs: number
}

/**
 * Read a plain-JSONL session log into a trace.
 * @param path - absolute session JSONL path.
 * @returns the header, decoded events, and how many torn trailing rows were skipped.
 */
export function readTrace(path: string): Trace {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/u).filter((line) => line.trim() !== '')
  if (lines.length === 0) throw new Error('trace: empty session log ' + path)
  const header = parseObject(lines[0] as string, 'header')
  const events: TraceEvent[] = []
  let skippedLines = 0
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index] as string
    try {
      const record = JSON.parse(line) as unknown
      if (!isRecord(record) || typeof record.type !== 'string' || typeof record.seq !== 'number') {
        throw new Error('not an event row')
      }
      const seq = record.seq
      if (seq !== events.length) {
        throw new Error('seq gap: expected ' + events.length + ', got ' + seq)
      }
      events.push({ type: record.type, seq, time: numberOr(record.time, 0), data: isRecord(record.data) ? record.data : {} })
    } catch (error) {
      // A killed process can leave one partial trailing row; any other gap is corruption.
      if (index === lines.length - 1) {
        skippedLines += 1
        break
      }
      throw new Error('trace: corrupt row ' + (index + 1) + ' in ' + path + ': ' + String(error))
    }
  }
  return { header, events, skippedLines }
}

/**
 * Project trace events onto one compact line per event for dashboard drill-down.
 * @param trace - decoded trace.
 * @returns JSONL lines (one JSON object per line).
 */
export function normalizeEvents(trace: Trace): string[] {
  return trace.events.map((event) => {
    const turn = numberOr(event.data.turn, 0)
    const step = numberOr(event.data.step, 0)
    const name = typeof event.data.name === 'string' ? event.data.name : undefined
    const message = event.type === 'tool/result' && isRecord(event.data.message) ? event.data.message : null
    const isToolError = message !== null && message.isError === true
    const isTurnError =
      event.type === 'turn/end' && isRecord(event.data.reason) && event.data.reason.kind === 'error'
    const error = isToolError || isTurnError
    const summary = summarize(event)
    return JSON.stringify({
      seq: event.seq,
      time: event.time,
      type: event.type,
      turn,
      step,
      ...(name === undefined ? {} : { name }),
      ...(summary === undefined ? {} : { summary }),
      ...(error ? { error: true } : {}),
    })
  })
}

/**
 * Fold fixed DSH metrics from one trace. All timings come from the durable log.
 * @param events - trace events in log order.
 * @returns the folded metric set.
 */
export function foldMetrics(events: readonly TraceEvent[]): TraceMetrics {
  let turns = 0
  let steps = 0
  let toolCalls = 0
  let toolResults = 0
  let toolErrors = 0
  let retries = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let reasoningTokens = 0
  let totalTokens = 0
  let llmMs = 0
  let toolMs = 0
  let firstTime: number | null = null
  let lastTime: number | null = null
  let openStep: { turn: number; step: number; start: number } | null = null
  const pendingCalls = new Map<string, number>()
  const seenTurns = new Set<number>()

  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        seenTurns.add(numberOr(event.data.turn, 0))
        break
      case 'step/start':
        openStep = {
          turn: numberOr(event.data.turn, 0),
          step: numberOr(event.data.step, 0),
          start: event.time,
        }
        break
      case 'assistant/message': {
        if (openStep !== null) {
          llmMs += Math.max(0, event.time - openStep.start)
          openStep = null
        }
        const usage = isRecord(event.data.usage) ? event.data.usage : null
        if (usage !== null) {
          const eventInput = numberOr(usage.inputTokens, 0)
          const eventOutput = numberOr(usage.outputTokens, 0)
          const eventCacheRead = numberOr(usage.cacheReadTokens, 0)
          const eventCacheWrite = numberOr(usage.cacheWriteTokens, 0)
          inputTokens += eventInput
          outputTokens += eventOutput
          cacheReadTokens += eventCacheRead
          cacheWriteTokens += eventCacheWrite
          reasoningTokens += numberOr(usage.reasoningTokens, 0)
          // The trace's own total is authoritative; computing it from parts can
          // double-count reasoning/cache tokens (the provider may already include
          // them in outputTokens or the total).
          totalTokens += numberOr(
            usage.totalTokens,
            eventInput + eventOutput + eventCacheRead + eventCacheWrite,
          )
        }
        break
      }
      case 'tool/call': {
        toolCalls += 1
        const callId = String(event.data.callId ?? '')
        pendingCalls.set(callId, event.time)
        break
      }
      case 'tool/result': {
        toolResults += 1
        const message = isRecord(event.data.message) ? event.data.message : null
        // 0.2.x carries `isError` on the tool result message; older/newer shapes may
        // carry a structured `error` outside content. Count the failure once.
        if (message !== null && message.isError === true) toolErrors += 1
        else if (event.data.error !== undefined) toolErrors += 1
        const callId = toolResultCallId(message)
        const dispatched = callId === null ? undefined : pendingCalls.get(callId)
        if (dispatched !== undefined) {
          toolMs += Math.max(0, event.time - dispatched)
          pendingCalls.delete(callId as string)
        }
        break
      }
      case 'step/end':
        steps += 1
        openStep = null
        break
      case 'turn/end':
        pendingCalls.clear()
        break
      case 'llm/retry':
        retries += 1
        break
      default:
        break
    }
    firstTime = firstTime === null ? event.time : Math.min(firstTime, event.time)
    lastTime = lastTime === null ? event.time : Math.max(lastTime, event.time)
  }

  return {
    turns: seenTurns.size > 0 ? seenTurns.size : turns,
    steps,
    toolCalls,
    toolResults,
    toolErrors,
    retries,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens,
    contextTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
    llmMs,
    toolMs,
    latencyMs: firstTime !== null && lastTime !== null ? Math.max(0, lastTime - firstTime) : 0,
  }
}

/** Compact per-event summary for the normalized stream. */
function summarize(event: TraceEvent): string | undefined {
  switch (event.type) {
    case 'tool/call': {
      const args = typeof event.data.arguments === 'string' ? event.data.arguments : ''
      return (typeof event.data.name === 'string' ? event.data.name : 'tool') + ' ' + args.slice(0, 120)
    }
    case 'tool/result': {
      const content = isRecord(event.data.message) ? event.data.message.content : undefined
      const text = Array.isArray(content)
        ? content
            .map((block) => (isRecord(block) && typeof block.text === 'string' ? block.text : ''))
            .join(' ')
        : ''
      return text.slice(0, 160)
    }
    case 'turn/end': {
      const reason = isRecord(event.data.reason) ? event.data.reason : null
      if (reason === null) return undefined
      if (reason.kind === 'error') {
        const failure = isRecord(reason.error) ? reason.error : null
        const messageText =
          failure !== null && typeof failure.message === 'string' ? failure.message : 'unknown error'
        const code = failure !== null && typeof failure.code === 'string' ? failure.code : ''
        return 'turn error: ' + messageText + (code === '' ? '' : ' (' + code + ')')
      }
      return String(reason.kind ?? '')
    }
    default:
      return undefined
  }
}

/**
 * Resolve the tool call id a result settles. 0.2.x stores it on
 * `message.toolCallId`; the older nested `message.source.callId` remains as a
 * fallback so traces from other revisions still pair correctly.
 * @param message - the tool result message, when present.
 * @returns the call id, or null when the row carries none.
 */
function toolResultCallId(message: Record<string, unknown> | null): string | null {
  if (message === null) return null
  if (typeof message.toolCallId === 'string') return message.toolCallId
  const source = isRecord(message.source) ? message.source : null
  if (source !== null && typeof source.callId === 'string') return source.callId
  return null
}

function parseObject(text: string, label: string): Record<string, unknown> {  const parsed = JSON.parse(text) as unknown
  if (!isRecord(parsed)) throw new Error('trace: ' + label + ' is not an object')
  return parsed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Provider/model observed in one request header. */
export interface ObservedModel {
  readonly provider: string
  readonly model: string
}

/**
 * Collect every distinct provider/model observed in request headers, in order.
 * Verifying only the first header would miss a mid-run or later task switch.
 * @param events - trace events in log order.
 * @returns unique observed model targets.
 */
export function readObservedModels(events: readonly unknown[]): ObservedModel[] {
  const observed: ObservedModel[] = []
  const seen = new Set<string>()
  for (const event of events) {
    const candidate = event as {
      readonly type?: string
      readonly data?: { readonly header?: { readonly config?: { readonly provider?: string; readonly model?: string } } }
    }
    if (candidate.type !== 'request/header') continue
    const config = candidate.data?.header?.config
    if (config?.provider === undefined || config.model === undefined) continue
    const key = config.provider + '\u0000' + config.model
    if (seen.has(key)) continue
    seen.add(key)
    observed.push({ provider: config.provider, model: config.model })
  }
  return observed
}
