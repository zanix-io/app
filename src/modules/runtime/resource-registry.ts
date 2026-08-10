/**
 * Contract a resource instance must satisfy to be closed by {@link ResourceRegistry.close} —
 * structurally equivalent to `@zanix/server`'s `ZanixConnector` lifecycle shape (a `close()`
 * method), but declared locally rather than reusing that class directly: `ZanixConnector.close()`
 * is `protected abstract`, so an external owner (this registry) cannot call it through a
 * `ZanixConnector`-typed reference at all — only a structural type with a PUBLIC `close()` can be
 * called externally. Any object with a callable `close()` qualifies, `ZanixConnector` subclass
 * instances included (accessed via a type assertion, same as any other externally-owned
 * protected member).
 */
export interface CloseableResource {
  /** Releases whatever this resource holds (connections, handles, timers, ...). */
  close(): Promise<void> | void
}

/**
 * Owns the lifecycle and cache of every resource a Zanix App's `resources`/`uses` resolve to. One
 * instance per process is the intended usage — see `AppContainer`'s own doc for where that
 * singleton gets created once implemented; this class itself has no module-level singleton
 * state, so tests can freely construct isolated instances.
 *
 * Deliberately NOT a service locator: callers must already know the exact `qualifiedKey` they
 * want (resolved at composition time from `resources`/`uses`, never guessed at runtime) and must
 * supply the `factory` that builds it — this class only owns caching/lifecycle, never resource
 * construction logic itself.
 */
export class ResourceRegistry {
  #instances = new Map<string, Promise<unknown>>()

  /**
   * Resolves `qualifiedKey` to its instance, invoking `factory` only on the FIRST call for that
   * key for the lifetime of this registry.
   *
   * Memoized by PROMISE, not by resolved value: the in-flight promise is stored synchronously,
   * before `factory`'s own `await`s run, so a second caller that arrives while construction is
   * still pending receives the exact same promise — `factory` never runs twice for the same key,
   * even under real concurrency (two callers with no `await` between them).
   *
   * If the stored promise rejects, every caller for that key — the one that triggered it and any
   * that arrived while it was in flight — receives that same rejection. `resolve` never retries a
   * failed construction automatically; a fresh `ResourceRegistry` (or a fresh process) is required
   * to try again.
   *
   * @param qualifiedKey Fully-qualified resource key, resolved by the caller before this call —
   * never derived from `factory`'s return type or class (two same-class resources under different
   * keys are two independent instances; same key always means same instance, regardless of how
   * many callers ask for it concurrently).
   * @param factory Constructs the instance. Only invoked once per key, ever, for this registry.
   * @returns The (memoized) instance, once `factory`'s promise settles.
   */
  public resolve<T>(qualifiedKey: string, factory: () => Promise<T>): Promise<T> {
    const existing = this.#instances.get(qualifiedKey)
    if (existing) return existing as Promise<T>

    const pending = factory()
    this.#instances.set(qualifiedKey, pending)
    return pending
  }

  /**
   * Closes every resource resolved so far, via `Promise.allSettled` — one resource's `close()`
   * rejecting never stops the others from being attempted. A key whose construction itself never
   * succeeded (its `resolve()` promise rejected) is skipped — there is no instance to close, and
   * that failure was already surfaced to whoever originally awaited `resolve()` during boot;
   * re-reporting it here would misattribute a construction failure as a close failure.
   *
   * @throws {AggregateError} if one or more resources' `close()` itself rejected/threw. Never
   * thrown for a key whose construction had already failed (see above) — only for a `close()`
   * failure on an instance that DID construct successfully.
   */
  public async close(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.#instances.values()].map(async (pending) => {
        let instance: unknown
        try {
          instance = await pending
        } catch {
          return // never constructed — nothing to close, already reported at construction time
        }
        await (instance as CloseableResource).close()
      }),
    )

    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason)

    if (errors.length) {
      throw new AggregateError(errors, `${errors.length} resource(s) failed to close.`)
    }
  }
}
