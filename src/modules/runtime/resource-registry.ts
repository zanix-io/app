import { InternalError } from '@zanix/errors'

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
  /** `qualifiedKey -> Set<appName>` — which apps currently reference each resolved instance. Only
   * populated for callers that pass `ownerApp` to {@link resolve} (hot install/uninstall); a
   * `qualifiedKey` never touched that way simply has no entry here, and {@link release} is a
   * no-op for it. */
  #refs = new Map<string, Set<string>>()
  /** `appName -> Set<qualifiedKey>` — the exact reverse of `#refs`, kept in lockstep by `resolve`/
   * `release`, so {@link setQuota}'s own enforcement never needs to scan `#refs` looking for
   * `ownerApp`'s own entries. */
  #ownedKeys = new Map<string, Set<string>>()
  /** `appName -> maxInstances` — see {@link setQuota}. Absent entirely = unlimited (today's
   * default, unchanged behavior for any caller that never opts in). */
  #quotas = new Map<string, number>()

  /**
   * Caps how many DISTINCT `qualifiedKey`s `ownerApp` may hold a reference to at once —
   * multi-tenancy isolation already works today by installing
   * the same app definition under a distinct name per tenant (`installApp`'s own doc covers this;
   * nothing about resource/config/route resolution needed to change for that). What was actually
   * missing was a real ceiling on how many resource instances (connections, pools) ANY ONE
   * installed app — trusted or not — can cause this process to hold open at once, protecting
   * shared infrastructure from a single misbehaving/greedy tenant install exhausting it.
   *
   * Counts DISTINCT keys `ownerApp` references, not construction events — referencing an
   * already-shared root resource another app also uses still counts as ONE unit of consumption
   * against `ownerApp`'s own quota (it reflects real concurrent dependency count), even though
   * nothing new was actually constructed for it.
   *
   * Setting a quota LOWER than `ownerApp`'s current owned-key count does not retroactively evict
   * anything — it only takes effect on the NEXT attempt to reference a key `ownerApp` doesn't
   * already hold.
   *
   * @param ownerApp The app name to cap — typically a tenant-scoped install's own name (e.g.
   * `billing-acme`), set by the host at `installApp` time (see `InstallAppOptions.maxResources`).
   * @param maxInstances The ceiling — `0` means `ownerApp` may never construct/reference ANY
   * resource (every `resolve()` call on its behalf throws immediately).
   */
  public setQuota(ownerApp: string, maxInstances: number): void {
    this.#quotas.set(ownerApp, maxInstances)
  }

  /** Removes any quota set for `ownerApp` (see {@link setQuota}) — a no-op if none was ever set.
   * Called by `uninstallApp` so a LATER install reusing the same app name never inherits a stale
   * ceiling from a previous tenant's install under that name. */
  public clearQuota(ownerApp: string): void {
    this.#quotas.delete(ownerApp)
  }

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
   * @param ownerApp When given, records this app as a referent of `qualifiedKey` — the bookkeeping
   * {@link release} needs to know whether any OTHER app still needs this instance before actually
   * closing it. `resolveResources()` passes this on every call (boot-time composition included),
   * so a resource shared between a boot-time app and a later hot-installed one is tracked
   * correctly either way — omit only from a call site that will never need `release()` for this
   * key (e.g. a one-off test construction). Also what {@link setQuota} enforces against — omitting
   * it means this call is invisible to any quota (matches "unlimited" being the default).
   * Rejects (never throws synchronously — always a `Promise` a caller can `.catch()`/`await`
   * uniformly, quota check included) with {@link InternalError} `RESOURCE_QUOTA_EXCEEDED` if
   * `ownerApp` has a quota set (see {@link setQuota}) and referencing `qualifiedKey` would exceed
   * it — before `factory` ever runs, so a denied caller never pays construction cost for something
   * it won't get to keep. Never rejected for a `qualifiedKey` `ownerApp` ALREADY references
   * (re-resolving something you already hold never counts against your own quota again).
   * @returns The (memoized) instance, once `factory`'s promise settles.
   */
  public resolve<T>(
    qualifiedKey: string,
    factory: () => Promise<T>,
    ownerApp?: string,
  ): Promise<T> {
    if (ownerApp) {
      const owned = this.#ownedKeys.get(ownerApp) ?? new Set()
      if (!owned.has(qualifiedKey)) {
        const quota = this.#quotas.get(ownerApp)
        if (quota !== undefined && owned.size >= quota) {
          return Promise.reject(
            new InternalError(
              `Zanix App "${ownerApp}" has reached its resource quota (${quota}) — cannot ` +
                `reference "${qualifiedKey}".`,
              {
                code: 'RESOURCE_QUOTA_EXCEEDED',
                meta: {
                  source: 'zanix',
                  ownerApp,
                  qualifiedKey,
                  quota,
                  owned: owned.size,
                },
              },
            ),
          )
        }
        owned.add(qualifiedKey)
        this.#ownedKeys.set(ownerApp, owned)
      }

      const refSet = this.#refs.get(qualifiedKey) ?? new Set()
      refSet.add(ownerApp)
      this.#refs.set(qualifiedKey, refSet)
    }

    const existing = this.#instances.get(qualifiedKey)
    if (existing) return existing as Promise<T>

    const pending = factory()
    this.#instances.set(qualifiedKey, pending)
    return pending
  }

  /**
   * Removes `ownerApp` from `qualifiedKey`'s reference set (recorded by {@link resolve}'s own
   * `ownerApp` argument) — a no-op if `qualifiedKey` was never resolved with an `ownerApp`, or if
   * `ownerApp` wasn't actually one of its referents. If no app references `qualifiedKey` anymore
   * afterward, closes and forgets the instance — the hot-uninstall counterpart to {@link close}
   * (which unconditionally closes everything, for a full process stop), scoped to ONE resource
   * whose last referencing app just went away while the rest of the process keeps running.
   *
   * Never called by ordinary boot-time composition — `deactivateApps` always tears down every
   * tracked app together via {@link close}, never releasing one at a time; only hot-uninstall
   * (`uninstallApp`) calls this, against reference sets `resolveResources()` already populated
   * for every app, boot-time or hot-installed alike.
   *
   * @throws {AggregateError} if the instance's own `close()` rejects — same failure shape as
   * {@link close} for a single resource. Never thrown for a key whose construction itself had
   * already failed (nothing to close).
   */
  public async release(qualifiedKey: string, ownerApp: string): Promise<void> {
    const refSet = this.#refs.get(qualifiedKey)
    if (!refSet) return // never resolved with an ownerApp — nothing to release, nothing to close

    const owned = this.#ownedKeys.get(ownerApp)
    owned?.delete(qualifiedKey)
    if (owned && owned.size === 0) this.#ownedKeys.delete(ownerApp)

    refSet.delete(ownerApp)
    if (refSet.size > 0) return

    this.#refs.delete(qualifiedKey)

    const pending = this.#instances.get(qualifiedKey)
    if (!pending) return
    this.#instances.delete(qualifiedKey)

    let instance: unknown
    try {
      instance = await pending
    } catch {
      return // never constructed — nothing to close
    }

    try {
      await (instance as CloseableResource).close()
    } catch (error) {
      throw new AggregateError(
        [error],
        `Resource "${qualifiedKey}" failed to close.`,
      )
    }
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
      throw new AggregateError(
        errors,
        `${errors.length} resource(s) failed to close.`,
      )
    }
  }
}
