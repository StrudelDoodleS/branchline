// Branchline fork modifications; see FORK.md.
/** Display capacity within the meter even if estimates exceed the model limit
 *  or composition estimates do not sum to the authoritative usage. */
export function contextMeter(tokens: number, capacity: number, values: readonly number[]) {
  const fraction = Number.isFinite(tokens) && Number.isFinite(capacity) && capacity > 0
    ? Math.max(0, Math.min(1, tokens / capacity)) : 0
  const positive = values.map(value => Number.isFinite(value) && value > 0 ? value : 0)
  const total = positive.reduce((sum, value) => sum + value, 0)
  return { fraction, segments: positive.map(value => total > 0 ? value / total * fraction : 0) }
}
