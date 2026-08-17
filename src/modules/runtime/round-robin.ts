/**
 * Picks the next item from a list, round-robin, keyed by an arbitrary string — the shared
 * mechanism `HttpRemoteAdapter.dispatch()` and the Gateway (`gateway.ts`) both use to spread calls
 * across a target's live endpoints. Deliberately simple: a per-key counter, no atomicity under
 * concurrent calls (a rare double-pick under heavy concurrency is harmless for load-balancing
 * purposes, unlike a lease) — chosen over plain random selection because it spreads consecutive
 * calls evenly even when the endpoint count is small or call volume is low, where random can
 * still pick the same endpoint several times in a row purely by chance. Chosen over anything
 * fancier (least-connections, latency-aware) because nothing here has evidence that plain
 * round-robin falls short — same "don't build a cloud provider" boundary as the rest of this
 * package.
 *
 * One instance's counters are scoped to ITS OWN lifetime (a fresh `HttpRemoteAdapter`/Gateway
 * starts back at the beginning) — never persisted or shared across processes, since which
 * endpoint "comes next" has no meaning beyond the single process doing the picking.
 */
export class RoundRobinPicker {
  #counters = new Map<string, number>()

  /**
   * Returns `items[current % items.length]` for `key`, advancing `key`'s own counter for next
   * time. `items` is expected non-empty — callers already know this (an empty `endpoints` list
   * means "no live target", checked before ever reaching here).
   */
  public pick<T>(key: string, items: readonly T[]): T {
    const index = (this.#counters.get(key) ?? 0) % items.length
    this.#counters.set(key, index + 1)
    return items[index]
  }
}
