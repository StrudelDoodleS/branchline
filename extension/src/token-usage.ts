// Branchline fork modifications; see FORK.md.
/** Reported, cumulative API usage. Context fill is tracked separately. */
export interface TokenCounts {
  inputTokens: number // uncached input, excluding cache writes
  outputTokens: number // includes reasoning
  cacheReadTokens: number
  cacheWriteTokens: number // includes the 1h subset below
  cacheWrite1hTokens: number
  reasoningTokens: number // a subset of output, never charged twice
}

export interface UsageTotals extends TokenCounts {
  totalTokens: number
  costUSD: number | null
}

export * from './cost-history'
import type { CostRecord, CostBreakdown, CostGroup } from './cost-history'

export interface ReasoningSettings { effort?: string | null; perTurnEffort?: string | null }
interface UsageCall extends TokenCounts { model?: string; kind?: string; reasoningEffort?: string | null }

const PARTS = ['input', 'output', 'cacheRead', 'cacheWrite', 'unattributed'] as const
const emptyBreakdown = (): CostBreakdown => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unattributed: 0 })
function addBreakdown(target: CostBreakdown, source: CostBreakdown, factor = 1): void {
  for (const key of PARTS) target[key] += source[key] * factor
}
const sumBreakdown = (parts: CostBreakdown) => parts.input + parts.cacheRead + parts.cacheWrite + parts.output + parts.unattributed

type Rates = { input: number; output: number; read: number; write: number; write1h?: number; longAfter?: number; longInput?: number; longOutput?: number }

/** Standard API USD / million tokens, verified 2026-10-20.
 * Sources: https://developers.openai.com/api/docs/pricing
 * https://platform.claude.com/docs/en/about-claude/pricing
 * Exact model versions matter; unknown models have no dollar estimate. */
const PRICES: Record<string, Rates> = {
  'gpt-6.1-sol': { input: 2, output: 10, read: 0.1, write: 2.5, longAfter: 272000 },
  'gpt-6-sol': { input: 2, output: 10, read: 0.2, write: 2.5, longAfter: 272000 },
  'gpt-6-astra': { input: 10, output: 50, read: 1, write: 12.5, longAfter: 272000 },
  'gpt-6-luna': { input: 0.1, output: 0.5, read: 0.01, write: 0.125, longAfter: 272000 },
  'gpt-5.6-sol': { input: 4, output: 20, read: 0.4, write: 5, longAfter: 272000 },
  'gpt-5.6-terra': { input: 2, output: 12, read: 0.2, write: 2.5, longAfter: 272000 },
  'gpt-5.6-luna': { input: 0.2, output: 1.2, read: 0.02, write: 0.25, longAfter: 272000 },
  'gpt-5.5': { input: 5, output: 30, read: 0.5, write: NaN, longAfter: 272000 },
  'gpt-5.4': { input: 2.5, output: 15, read: 0.25, write: NaN, longAfter: 272000 },
  'gpt-5.4-mini': { input: 0.75, output: 4.5, read: 0.075, write: NaN },
  'gpt-5.4-nano': { input: 0.2, output: 1.25, read: 0.02, write: NaN },
  'gpt-5.2': { input: 1.75, output: 14, read: 0.175, write: NaN },
  'gpt-5.3-codex': { input: 1.75, output: 14, read: 0.175, write: NaN },
  'gpt-5.1': { input: 1.25, output: 10, read: 0.125, write: NaN },
  'claude-opus-5-5': { input: 4, output: 20, read: 0.2, write: 5, write1h: 8 },
  'claude-sonnet-5-5': { input: 2, output: 10, read: 0.1, write: 2.5, write1h: 4 },
  'claude-fable-5-1': { input: 10, output: 50, read: 0.25, write: 12.5, write1h: 20 },
  'claude-mythos-5-1': { input: 10, output: 50, read: 0.25, write: 12.5, write1h: 20 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, read: 0.01, write: 0.125, write1h: 0.2, longAfter: 100000, longInput: 5, longOutput: 5 },
  'claude-fable-5': { input: 10, output: 50, read: 1, write: 12.5, write1h: 20 },
  'claude-mythos-5': { input: 10, output: 50, read: 1, write: 12.5, write1h: 20 },
  'claude-opus-5': { input: 5, output: 25, read: 0.5, write: 6.25, write1h: 10 },
  'claude-opus-4-8': { input: 5, output: 25, read: 0.5, write: 6.25, write1h: 10 },
  'claude-opus-4-7': { input: 5, output: 25, read: 0.5, write: 6.25, write1h: 10 },
  'claude-opus-4-6': { input: 5, output: 25, read: 0.5, write: 6.25, write1h: 10 },
  'claude-opus-4-5': { input: 5, output: 25, read: 0.5, write: 6.25, write1h: 10 },
  'claude-sonnet-5': { input: 2, output: 10, read: 0.2, write: 2.5, write1h: 4 },
  'claude-sonnet-4-6': { input: 3, output: 15, read: 0.3, write: 3.75, write1h: 6 },
  'claude-sonnet-4-5': { input: 3, output: 15, read: 0.3, write: 3.75, write1h: 6.0, longAfter: 200000, longInput: 2, longOutput: 1.5 },
  'claude-haiku-4-5': { input: 1, output: 5, read: 0.1, write: 1.25, write1h: 2 },
}

export interface CacheWriteEstimate {
  tokens: number
  costUSD: number
  alreadyCountedInputUSD: number
  additionalCostUSD: number
}

/** Scenario, not recovered telemetry: all uncached prompt tokens become 30m
 * writes. Reprice their existing input cost so long-context weighting survives
 * and the caller can show the incremental cost without counting input twice. */
export function estimateCodexCacheWrites(groups: ReadonlyArray<CostGroup>, selected?: string): CacheWriteEstimate | undefined {
  const result = { tokens: 0, costUSD: 0, alreadyCountedInputUSD: 0, additionalCostUSD: 0 }
  for (const group of groups) {
    if (selected && group.id !== selected || !/^gpt-(6|5\.6)/i.test(group.model ?? '')) continue
    const rates = PRICES[(group.model ?? '').toLowerCase().replace(/\[[^\]]*\]/g, '').replace(/-\d{8}$/, '')]
    const inputCost = group.breakdownUSD.input
    if (!rates || !Number.isFinite(rates.write) || group.costUSD === null || !valid(group.tokens)
      || group.tokens.cacheWriteTokens !== 0 || group.tokens.cacheReadTokens <= 0 || group.tokens.inputTokens <= 0
      || !Number.isFinite(inputCost) || inputCost <= 0) continue
    const cost = inputCost * (rates.write / rates.input)
    if (!Number.isFinite(cost)) continue
    result.tokens += group.tokens.inputTokens
    result.costUSD += cost
    result.alreadyCountedInputUSD += inputCost
  }
  result.additionalCostUSD = result.costUSD - result.alreadyCountedInputUSD
  return result.tokens > 0 ? result : undefined
}

const KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'cacheWrite1hTokens', 'reasoningTokens'] as const
const emptyCounts = (): TokenCounts => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0 })
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}
function count(value: unknown): number {
  return value === undefined ? 0 : typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : NaN
}
function valid(tokens: TokenCounts): boolean { return KEYS.every(key => Number.isFinite(tokens[key]) && tokens[key] >= 0) }
function total(tokens: TokenCounts): number { return tokens.inputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens }

function normalizeClaudeCallUsage(raw: unknown): TokenCounts | undefined {
  const u = object(raw)
  if (u.input_tokens === undefined) return
  const tokens: TokenCounts = {
    inputTokens: count(u.input_tokens), outputTokens: count(u.output_tokens),
    cacheReadTokens: count(u.cache_read_input_tokens), cacheWriteTokens: count(u.cache_creation_input_tokens),
    cacheWrite1hTokens: count(object(u.cache_creation).ephemeral_1h_input_tokens),
    reasoningTokens: count(object(u.output_tokens_details).thinking_tokens),
  }
  if (valid(tokens) && tokens.cacheWrite1hTokens <= tokens.cacheWriteTokens && tokens.reasoningTokens <= tokens.outputTokens && total(tokens) > 0) return tokens
}

/** Threshold compaction adds sampling calls omitted from top-level usage. */
export function claudeUsageCalls(raw: unknown): UsageCall[] | undefined {
  const iterations = object(raw).iterations
  const calls: UsageCall[] = []
  for (const rawCall of Array.isArray(iterations) && iterations.length ? iterations : [raw]) {
    const tokens = normalizeClaudeCallUsage(rawCall)
    if (!tokens) return
    const call = object(rawCall)
    const model = call.model
    const hasEffort = 'perTurnEffort' in call || 'effort' in call
    const effort = call.perTurnEffort ?? call.effort
    calls.push({ ...tokens, ...(typeof model === 'string' && model ? { model } : {}),
      ...(typeof call.type === 'string' ? { kind: call.type } : {}),
      ...(hasEffort ? { reasoningEffort: typeof effort === 'string' ? effort.trim() || null : null } : {}) })
  }
  return calls
}

export function normalizeClaudeUsage(raw: unknown): TokenCounts | undefined {
  const calls = claudeUsageCalls(raw)
  if (!calls) return
  const result = emptyCounts()
  for (const call of calls) for (const key of KEYS) result[key] += call[key]
  result.reasoningTokens = Math.max(result.reasoningTokens, count(object(object(raw).output_tokens_details).thinking_tokens))
  if (valid(result) && result.reasoningTokens <= result.outputTokens) return result
}

function normalizeCodexUsage(raw: unknown): TokenCounts | undefined {
  const u = object(raw)
  if (u.input_tokens === undefined || u.output_tokens === undefined) return
  const read = count(u.cached_input_tokens), write = count(u.cache_write_input_tokens)
  const tokens = { inputTokens: count(u.input_tokens) - read - write, outputTokens: count(u.output_tokens), cacheReadTokens: read,
    cacheWriteTokens: write, cacheWrite1hTokens: 0, reasoningTokens: count(u.reasoning_output_tokens) }
  if (valid(tokens) && tokens.reasoningTokens <= tokens.outputTokens) return tokens
}

export function apiCostBreakdown(model: string, tokens: TokenCounts, requestInput = tokens.inputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens): CostBreakdown | null {
  const id = model.toLowerCase().replace(/\[[^\]]*\]/g, '').replace(/-\d{8}$/, '')
  const rates = PRICES[id]
  if (!rates || !valid(tokens)) return null
  const long = rates.longAfter !== undefined && requestInput > rates.longAfter
  const inputMultiplier = long ? rates.longInput ?? 2 : 1
  const outputMultiplier = long ? rates.longOutput ?? 1.5 : 1
  const write5m = tokens.cacheWriteTokens - tokens.cacheWrite1hTokens
  const parts: CostBreakdown = {
    input: tokens.inputTokens * rates.input * inputMultiplier / 1_000_000,
    output: tokens.outputTokens * rates.output * outputMultiplier / 1_000_000,
    cacheRead: tokens.cacheReadTokens * rates.read * inputMultiplier / 1_000_000,
    cacheWrite: ((write5m > 0 ? write5m * rates.write : 0)
      + (tokens.cacheWrite1hTokens > 0 ? tokens.cacheWrite1hTokens * (rates.write1h ?? NaN) : 0)) * inputMultiplier / 1_000_000,
    unattributed: 0,
  }
  return PARTS.every(key => Number.isFinite(parts[key])) ? parts : null
}

export function apiCost(model: string, tokens: TokenCounts, requestInput?: number): number | null {
  const parts = apiCostBreakdown(model, tokens, requestInput)
  return parts ? sumBreakdown(parts) : null
}

/** Replace response snapshots rather than adding every streamed content block.
 * Response IDs are session-wide, so inline progress and subagent files dedup. */
export class UsageLedger {
  private responses = new Map<string, { agent: string; model: string; tokens: TokenCounts; cost: number | null;
    breakdown: CostBreakdown | null; timestamp?: number; effort?: string; perTurnEffort?: string; records: CostRecord[] }>()
  private agents = new Map<string, { tokens: TokenCounts; cost: number; unpriced: number }>()

  record(id: string, agent: string, model: string, tokens: TokenCounts, requestInput?: number, timestamp?: number,
    calls?: ReadonlyArray<UsageCall>, settings: ReasoningSettings = {}): string | undefined {
    const old = this.responses.get(id)
    const at = timestamp !== undefined && Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : undefined
    if (old && tokens.outputTokens < old.tokens.outputTokens) return
    model ||= old?.model ?? ''
    const effort = settings.effort === undefined ? old?.effort : settings.effort?.trim() || undefined
    const perTurnEffort = settings.perTurnEffort === undefined ? old?.perTurnEffort : settings.perTurnEffort?.trim() || undefined
    const reasoningEffort = perTurnEffort || effort
    let breakdown: CostBreakdown | null = emptyBreakdown()
    const records: CostRecord[] = []
    for (const call of calls ?? [tokens]) {
      const callModel = 'model' in call && typeof call.model === 'string' ? call.model : model
      const parts = apiCostBreakdown(callModel, call, calls ? undefined : requestInput)
      const callEffort = 'reasoningEffort' in call ? call.reasoningEffort ?? undefined
        : (!('kind' in call) || call.kind === 'message') && callModel === model ? reasoningEffort : undefined
      const callTokens = emptyCounts()
      for (const key of KEYS) callTokens[key] = call[key]
      records.push({ model: callModel || undefined, reasoningEffort: callEffort, tokens: callTokens,
        timestamp: old?.timestamp ?? at, costUSD: parts ? sumBreakdown(parts) : null, breakdownUSD: parts ?? undefined })
      if (!parts) breakdown = null
      else if (breakdown) addBreakdown(breakdown, parts)
    }
    if (old && model === old.model && KEYS.every(key => tokens[key] === old.tokens[key])
      && PARTS.every(key => old.breakdown?.[key] === breakdown?.[key]) && old.effort === effort && old.perTurnEffort === perTurnEffort
      && old.records.length === records.length && records.every((record, index) => {
        const previous = old.records[index]
        return record.model === previous.model && record.reasoningEffort === previous.reasoningEffort
          && record.costUSD === previous.costUSD && KEYS.every(key => record.tokens?.[key] === previous.tokens?.[key])
      })) {
      if (old.timestamp === undefined && at !== undefined) { old.timestamp = at; old.records = records; return old.agent }
      return
    }
    const owner = old?.agent ?? agent
    const entry = this.agents.get(owner) ?? { tokens: emptyCounts(), cost: 0, unpriced: 0 }
    const cost = breakdown ? sumBreakdown(breakdown) : null
    for (const key of KEYS) entry.tokens[key] += tokens[key] - (old?.tokens[key] ?? 0)
    entry.cost += (cost ?? 0) - (old?.cost ?? 0)
    entry.unpriced += Number(cost === null) - Number(old?.cost === null)
    this.agents.set(owner, entry)
    this.responses.set(id, { agent: owner, model, tokens: { ...tokens }, cost, breakdown, timestamp: old?.timestamp ?? at,
      effort, perTurnEffort, records })
    return owner
  }

  *costRecords(): IterableIterator<CostRecord> {
    for (const response of this.responses.values()) yield* response.records
  }

  snapshot(agent: string): UsageTotals | undefined {
    const entry = this.agents.get(agent)
    if (!entry) return
    return { ...entry.tokens, totalTokens: total(entry.tokens), costUSD: entry.unpriced > 0 ? null : Math.max(0, entry.cost) }
  }
}

/** Codex counters are cumulative; only the increase belongs to the next call. */
export class CodexUsageTracker {
  private previous = emptyCounts()
  private ledger = new UsageLedger()
  private revision = 0
  private beforeLast?: UsageTotals
  private responses?: UsageLedger
  private responseSettings = new Map<string, { model: string; effort: string | null }>()
  private prefix?: UsageTotals
  private prefixRecords?: CostRecord[]

  record(info: Record<string, unknown>, model: string, timestamp?: number, reasoningEffort?: string | null): void {
    if (this.responses) return // legacy token_count mirrors omit compaction calls
    const tokens = normalizeCodexUsage(info.total_token_usage)
    if (!tokens || KEYS.some(key => tokens[key] < this.previous[key])) return
    const delta = emptyCounts()
    for (const key of KEYS) delta[key] = tokens[key] - this.previous[key]
    if (total(delta) === 0) return
    const last = object(info.last_token_usage)
    const requestInput = typeof last.input_tokens === 'number' ? last.input_tokens : delta.inputTokens + delta.cacheReadTokens + delta.cacheWriteTokens
    this.beforeLast = this.ledger.snapshot('orchestrator')
    this.ledger.record(String(++this.revision), 'orchestrator', model, delta, requestInput, timestamp, undefined, { effort: reasoningEffort })
    this.previous = tokens
  }

  recordResponse(payload: Record<string, unknown>, model: string, timestamp?: number, reasoningEffort?: string | null): void {
    const id = payload.response_id
    const tokens = normalizeCodexUsage(payload.usage)
    if (typeof id !== 'string' || !id || !tokens) return
    if (!this.responses) {
      const thread = normalizeCodexUsage(payload.thread_token_usage)
      const prior = emptyCounts()
      if (thread) for (const key of KEYS) prior[key] = thread[key] - tokens[key]
      if (!valid(prior)) return
      // A CLI upgrade can append response records to an older rollout. Retain
      // its already-priced prefix, excluding a legacy mirror of this response.
      const snapshots = [this.ledger.snapshot('orchestrator'), this.beforeLast]
      const knownIndex = snapshots.findIndex(snapshot => snapshot &&
        KEYS.every(key => key === 'reasoningTokens' || snapshot[key] === prior[key]))
      const known = snapshots[knownIndex]
      this.prefix = { ...prior, totalTokens: total(prior), costUSD: total(prior) === 0 ? 0 : known?.costUSD ?? null }
      if (knownIndex >= 0) {
        this.prefixRecords = [...this.ledger.costRecords()]
        if (knownIndex === 1) this.prefixRecords.pop()
      } else if (total(prior) === 0) this.prefixRecords = []
      this.responses = new UsageLedger()
    }
    const captured = this.responseSettings.get(id)
    const responseModel = typeof payload.model === 'string' && payload.model ? payload.model : captured?.model || model
    const reported = payload.effort ?? payload.reasoning_effort
    const effort = 'effort' in payload || 'reasoning_effort' in payload ? typeof reported === 'string' ? reported : null
      : captured?.model === responseModel ? captured.effort : responseModel === model ? reasoningEffort : null
    this.responseSettings.set(id, { model: responseModel, effort: effort ?? null })
    this.responses.record(id, 'orchestrator', responseModel, tokens, undefined, timestamp, undefined, { effort })
  }

  *costRecords(): IterableIterator<CostRecord> {
    if (!this.responses) { yield* this.ledger.costRecords(); return }
    if (this.prefixRecords) yield* this.prefixRecords
    else if (this.prefix && (this.prefix.totalTokens > 0 || this.prefix.costUSD === null)) yield { costUSD: this.prefix.costUSD, tokens: this.prefix }
    yield* this.responses.costRecords()
  }

  snapshot(): UsageTotals | undefined {
    if (!this.responses) return this.ledger.snapshot('orchestrator')
    const response = this.responses.snapshot('orchestrator')
    if (!response || !this.prefix) return response
    const result = { ...response }
    for (const key of KEYS) result[key] += this.prefix[key]
    result.totalTokens += this.prefix.totalTokens
    result.costUSD = response.costUSD === null || this.prefix.costUSD === null ? null : response.costUSD + this.prefix.costUSD
    return result
  }
}
