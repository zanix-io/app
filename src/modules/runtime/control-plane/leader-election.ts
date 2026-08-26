import type { ZanixRedisConnectorLike } from '@zanix/datamaster/cache/types'

const KEY_PREFIX = 'zanix:control-plane:lease'
const DEFAULT_LEASE_TTL_SECONDS = 30

// Redlock's own clock-drift allowance: how much of the nominal TTL is discounted for network
// round-trip + clock skew across independent instances before a quorum acquire is trusted — same
// factor (0.01, i.e. 1%) the original Redlock write-up uses. Only relevant with more than one
// connector (see `LeaderElection`'s own doc, "Redlock (N independent instances)").
const CLOCK_DRIFT_FACTOR = 0.01

// Bounds how long ANY single instance's own operation is allowed to take before it's treated as
// unreachable — Redlock's whole fault-tolerance premise (`quorum` only needs a MAJORITY) is
// worthless if one dead instance's own client can silently hang forever instead of rejecting: a
// connector's `getClient()`/command promises reflect however long ITS OWN internal reconnect
// logic keeps retrying, which a genuinely down instance can stretch well past any lease TTL.
// `Promise.allSettled` alone doesn't help — it still waits for every promise to settle, hung ones
// included. This is what actually turns "hangs" into "rejects", so quorum among the REACHABLE
// instances can be reached without waiting on the unreachable ones at all.
const PER_INSTANCE_TIMEOUT_MS = 1500

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Redis operation timed out after ${ms}ms`)),
      ms,
    )
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function leaseKey(appName: string, jobName: string): string {
  return `${KEY_PREFIX}:${appName}:${jobName}`
}

function fencingKey(appName: string, jobName: string): string {
  return `${leaseKey(appName, jobName)}:fencing`
}

function quorumOf(instanceCount: number): number {
  return Math.floor(instanceCount / 2) + 1
}

// Compare-and-extend: only the CURRENT holder's own renewal actually postpones expiry — a holder
// that already lost the lease (another replica's fresh SET NX EX succeeded after this one's TTL
// lapsed) gets `0` back, never silently re-extends a lease it no longer owns. Plain Lua, no cjson
// needed — the lease's own value is just the holder id, a plain string.
const RENEW_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
  return 1
else
  return 0
end
`

const RELEASE_SCRIPT =
  `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`

/** Resolves in the SAME order as `promises`, but a rejection OR a timeout becomes `undefined`
 * instead of failing/stalling the whole batch — one unreachable Redis instance (real, expected
 * under Redlock: that's exactly the fault-tolerance a quorum buys) must never take the rest down
 * with it, and must never make the whole call wait past {@linkcode PER_INSTANCE_TIMEOUT_MS}
 * either (see that constant's own doc for why `Promise.allSettled` alone isn't enough). */
async function settleAll<T>(
  promises: Promise<T>[],
): Promise<(T | undefined)[]> {
  const results = await Promise.allSettled(
    promises.map((promise) => withTimeout(promise, PER_INSTANCE_TIMEOUT_MS)),
  )
  return results.map((
    result,
  ) => (result.status === 'fulfilled' ? result.value : undefined))
}

/**
 * Redis-backed leader election for scheduled jobs — SETNX+EX, exactly as the framework itself
 * already recommends. Reuses
 * exactly the escape hatch `ZanixKVConnector.withLock()`'s own doc points to for distributed
 * systems ("use a distributed lock (e.g., Redis)") — via `getClient()`, since the atomic
 * conditional `SET ... NX EX` and the compare-and-extend renewal script aren't part of
 * `ZanixCacheConnector`'s own high-level API (confirmed: {@linkcode CacheSetOptions} has no `NX`
 * option).
 *
 * One lease per `${appName}:${jobName}` — a long-lived leadership term, not a per-tick lock: the
 * SAME replica keeps winning `tryAcquireOrRenew` on every tick (as long as it keeps calling this
 * before its previous TTL lapses), so only that one replica's invocation of a scheduled job's
 * handler actually runs it. If that replica stops renewing (crash, network partition), any other
 * live replica's next tick acquires the lease fresh, the moment the old TTL expires.
 *
 * **Fencing token, not just the lease**: a monotonically increasing integer, bumped only on a
 * FRESH acquire (never on a renewal — a continuing leadership term keeps the SAME token). A job
 * handler that produces a side effect must re-validate its own token against
 * {@linkcode LeaderElection.getCurrentFencingToken} immediately before committing that effect —
 * this doesn't remove the double-DISPATCH window (impossible without costly synchronous
 * coordination, a real limit of any TTL-based lease under arbitrary network partition, not
 * specific to Redis), but it does remove the double-EFFECT, which is what actually matters.
 *
 * **Redlock (N independent instances) — upgrade path for a host already running Redis in high
 * availability**: pass an ARRAY of independent connectors instead of one, and every
 * method below switches to majority-quorum semantics automatically — same public API, same
 * `ctx`/manifest contract, nothing a caller needs to change beyond the constructor call itself.
 * A deployment upgrade, not a design one. A single connector (the default, and still the ONLY
 * thing required to use this class at all) keeps the exact single-instance behavior above,
 * unchanged — Redlock is opt-in, never assumed.
 *
 * Quorum mechanics: `tryAcquireOrRenew` tries the renew script on every instance in parallel first
 * — `quorum` (`floor(N/2) + 1`) successes means the lease is still held, no different from the
 * single-instance case except the check is "most instances agree", not "the only instance
 * agrees". Renewal failing quorum falls through to a fresh acquire attempt (`SET NX EX` on every
 * instance in parallel); reaching quorum there ALSO applies the same clock-drift discount the
 * original Redlock algorithm specifies (the nominal TTL minus how long the round trip itself took
 * minus a small drift allowance) — an acquire that technically reached quorum but used up nearly
 * the whole TTL just doing the round trip is correctly treated as failed, not as a wafer-thin
 * "success". A failed quorum releases (best-effort, compare-and-delete) whatever subset DID
 * succeed, so a future attempt — by this replica or another — doesn't have to wait out those
 * instances' own TTLs.
 *
 * An unreachable instance is tolerated, not fatal — `quorum` only needs a MAJORITY, exactly the
 * fault tolerance running N independent instances is meant to buy. `getCurrentFencingToken`
 * queries every reachable instance and returns the highest value seen (an instance a past write
 * never reached, or that's down entirely, can only under-report, never over-report, so the
 * maximum across whichever respond is the safe reading). `release` is always best-effort across
 * every instance regardless of individual outcome — nothing here ever throws for one instance's
 * own failure.
 */
export class LeaderElection {
  #connectors: ZanixRedisConnectorLike[]

  /** Wraps one or more already-constructed Redis cache connectors — this class never constructs
   * its own. A single connector (default single-Redis usage) or an array (Redlock — see this
   * class's own doc) — every other method adapts automatically to however many were given.
   * @param connector Where leases are arbitrated — a lone connector, or several INDEPENDENT ones
   * for Redlock (never several connectors pointed at the same physical Redis — that buys no real
   * fault tolerance, just repeats the same single point of failure under a different name). */
  constructor(
    connector: ZanixRedisConnectorLike | ZanixRedisConnectorLike[],
  ) {
    this.#connectors = Array.isArray(connector) ? connector : [connector]
  }

  /**
   * Renews `holderId`'s own lease if it's still the current holder; otherwise attempts a fresh
   * acquire (succeeds only if the lease is unheld — expired or never taken). Returns the current
   * fencing token on either success, or `null` if a DIFFERENT holder currently holds a live lease
   * (single-instance) or quorum couldn't be reached either way (Redlock).
   *
   * Call this on every tick a replica considers running `jobName` — never just once at startup;
   * a lease this replica doesn't keep renewing simply expires, exactly like
   * `ControlPlaneRegistry.registerInstance`'s own instance leases.
   *
   * @param appName The app that declared this job.
   * @param jobName The job's own (already app-namespaced, by convention) name.
   * @param holderId Stable per-process identity — the SAME value every tick from one replica, so
   * a renewal can recognize its own previous acquire.
   * @param leaseTtlSeconds Defaults to `30`.
   */
  public async tryAcquireOrRenew(
    appName: string,
    jobName: string,
    holderId: string,
    leaseTtlSeconds: number = DEFAULT_LEASE_TTL_SECONDS,
  ): Promise<number | null> {
    const key = leaseKey(appName, jobName)

    // Single-instance: no `settleAll` — a genuine connection failure propagates as a rejection,
    // exactly as it always has (never silently swallowed the way a quorum's fault tolerance
    // requires for N>1). Kept as its own branch instead of unifying into the quorum path below,
    // where `quorumOf(1) === 1` would otherwise make it behave the same EXCEPT for this.
    if (this.#connectors.length === 1) {
      const client = await this.#connectors[0].getClient()
      const renewed = await client.eval(RENEW_SCRIPT, {
        keys: [key],
        arguments: [holderId, String(leaseTtlSeconds)],
      })
      if (renewed === 1) {
        return await this.getCurrentFencingToken(appName, jobName)
      }

      const acquired = await client.set(key, holderId, {
        NX: true,
        EX: leaseTtlSeconds,
      })
      if (acquired !== 'OK') return null

      return await client.incr(fencingKey(appName, jobName))
    }

    const quorum = quorumOf(this.#connectors.length)

    const renewResults = await settleAll(
      this.#connectors.map(async (connector) => {
        const client = await connector.getClient()
        return await client.eval(RENEW_SCRIPT, {
          keys: [key],
          arguments: [holderId, String(leaseTtlSeconds)],
        })
      }),
    )
    if (renewResults.filter((result) => result === 1).length >= quorum) {
      return await this.getCurrentFencingToken(appName, jobName)
    }

    const acquireStarted = Date.now()
    const acquiredOn: ZanixRedisConnectorLike[] = []
    const acquireResults = await settleAll(
      this.#connectors.map(async (connector) => {
        const client = await connector.getClient()
        const result = await client.set(key, holderId, {
          NX: true,
          EX: leaseTtlSeconds,
        })
        if (result === 'OK') acquiredOn.push(connector)
        return result
      }),
    )
    const acquiredCount = acquireResults.filter((result) => result === 'OK').length
    const elapsedSeconds = (Date.now() - acquireStarted) / 1000
    const validitySeconds = leaseTtlSeconds - elapsedSeconds -
      leaseTtlSeconds * CLOCK_DRIFT_FACTOR

    if (acquiredCount < quorum || validitySeconds <= 0) {
      await settleAll(
        acquiredOn.map(async (connector) => {
          const client = await connector.getClient()
          await client.eval(RELEASE_SCRIPT, {
            keys: [key],
            arguments: [holderId],
          })
        }),
      )
      return null
    }

    // Only a FRESH, quorum-reaching acquire bumps the fencing token — a renewal (handled above)
    // never reaches here, so a continuing leadership term keeps returning the SAME token across
    // ticks. Incremented only on the instances that actually granted the lease; the highest value
    // among them is what `getCurrentFencingToken` would independently converge on too.
    const newTokens = await settleAll(
      acquiredOn.map(async (connector) => {
        const client = await connector.getClient()
        return await client.incr(fencingKey(appName, jobName))
      }),
    )
    const definedTokens = newTokens.filter((token): token is number => typeof token === 'number')
    return definedTokens.length ? Math.max(...definedTokens) : null
  }

  /**
   * Reads the fencing token currently in effect for `${appName}:${jobName}` — `null` if the lease
   * was never acquired by anyone yet (or, under Redlock, if no instance responded at all). A job
   * handler re-checks its OWN token against this, immediately before committing a side effect —
   * see this class's own doc.
   */
  public async getCurrentFencingToken(
    appName: string,
    jobName: string,
  ): Promise<number | null> {
    if (this.#connectors.length === 1) {
      const value = await this.#connectors[0].get<number | string>(
        fencingKey(appName, jobName),
      )
      return value === undefined ? null : Number(value)
    }

    const values = await settleAll(
      this.#connectors.map((connector) =>
        connector.get<number | string>(fencingKey(appName, jobName))
      ),
    )
    const numbers = values
      .filter((value): value is number | string => value !== undefined)
      .map(Number)

    return numbers.length ? Math.max(...numbers) : null
  }

  /**
   * Best-effort, explicit release — only removes the lease if `holderId` is still its current
   * holder (compare-and-delete, same reasoning as the renewal script: never deletes a lease this
   * caller no longer actually owns). Lets another replica take over immediately on a graceful
   * stop, instead of waiting out the remaining TTL — same spirit as
   * `ControlPlaneRegistry.deregisterInstance`. Run across every instance in parallel (Redlock);
   * one instance's own failure never stops the others from being released.
   */
  public async release(
    appName: string,
    jobName: string,
    holderId: string,
  ): Promise<void> {
    const key = leaseKey(appName, jobName)

    if (this.#connectors.length === 1) {
      const client = await this.#connectors[0].getClient()
      await client.eval(RELEASE_SCRIPT, { keys: [key], arguments: [holderId] })
      return
    }

    await settleAll(
      this.#connectors.map(async (connector) => {
        const client = await connector.getClient()
        await client.eval(RELEASE_SCRIPT, {
          keys: [key],
          arguments: [holderId],
        })
      }),
    )
  }
}
