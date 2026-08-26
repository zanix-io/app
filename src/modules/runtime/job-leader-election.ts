// `typings/manifest.ts` is the ONE place in this package that imports `@zanix/asyncmq/jobs`'s
// `Job` type directly (see that module's own doc, and `deno.jsonc`'s own `imports`/`scopes` doc
// comment, for the specifier this resolves through) — re-used here via its own
// `export type { Job }` rather than a second import of the same type.
import type { Job } from 'typings/manifest.ts'
import type { MessageQueue } from '@zanix/server'
import { resolveControlPlaneProvider } from './control-plane/mod.ts'

/** Stable for this process's whole lifetime — the identity `LeaderElection` compares a renewal
 * against. Regenerating it per call would make every "renew" attempt look like a brand-new
 * holder, defeating the whole point of a long-held lease. */
const PROCESS_HOLDER_ID = crypto.randomUUID()

const DEFAULT_LEASE_TTL_SECONDS = 30

/** Fencing token in effect for the invocation CURRENTLY running under `context.id` — populated by
 * {@linkcode wrapWithLeaderElection} right before calling the real handler, cleared right after.
 * Keyed by `context.id` (unique per execution, `@zanix/server`'s own `BaseContext.id`) rather than
 * by `${appName}:${jobName}`, so two overlapping executions of the SAME job in one process (the
 * one residual race this whole mechanism doesn't claim to close — see `LeaderElection`'s own doc)
 * never clobber each other's token. */
const fencingTokensByContextId = new Map<string, number>()

/**
 * Reads the fencing token the CURRENTLY running scheduled-job invocation acquired — `undefined`
 * if this job isn't running under leader election at all (no `@zanix/app/core` control plane
 * registered — the single-process case, where no coordination is needed in the first
 * place) or if `context` doesn't correspond to a job invocation `wrapWithLeaderElection` wrapped.
 *
 * @param context Any object carrying the invoking job's own `context.id` — a scheduled job's
 * handler is invoked with `this.context: HandlerContext & {...}`, so pass `this.context` as-is.
 */
export function getJobFencingToken(
  context: { id: string },
): number | undefined {
  return fencingTokensByContextId.get(context.id)
}

/**
 * Re-validates the CURRENTLY running invocation's fencing token against the value actually
 * current in Redis right now: any scheduled job that produces a side effect must validate its
 * fencing token against the value current in Redis immediately before committing that effect.
 * Call this immediately before a scheduled
 * job's handler commits any side effect — `true` means it's still safe to proceed; `false` means
 * a newer leadership term has already started elsewhere (this invocation is stale) and the side
 * effect must be skipped.
 *
 * Returns `true` (nothing to invalidate) when no leader election is in effect for this job at all
 * — the single-process case, where `wrapWithLeaderElection` never wrapped the handler to begin
 * with.
 *
 * @param appName The app that declared this job.
 * @param jobName The job's own short name, exactly as passed to `wrapWithLeaderElection`.
 * @param context `this.context` from inside the job handler — see {@linkcode getJobFencingToken}.
 */
export async function isJobFencingTokenCurrent(
  appName: string,
  jobName: string,
  context: { id: string },
): Promise<boolean> {
  const localToken = getJobFencingToken(context)
  if (localToken === undefined) return true

  const provider = resolveControlPlaneProvider()
  if (!provider) return true

  const currentToken = await provider.leaderElection.getCurrentFencingToken(
    appName,
    jobName,
  )
  return currentToken === localToken
}

/**
 * Wraps a scheduled job's handler so only the replica CURRENTLY holding `${appName}:${jobName}`'s
 * lease actually runs it: a job with a `schedule` runs exactly once per tick, regardless of how
 * many replicas are running.
 *
 * On every invocation (every tick, from every replica): attempts to acquire-or-renew the lease
 * (`LeaderElection.tryAcquireOrRenew`, this process's own stable identity as holder). If a
 * DIFFERENT replica currently holds a live lease, this invocation is skipped entirely — no call to
 * the real `handler`, `undefined` returned. Otherwise, the acquired fencing token is exposed via
 * {@linkcode getJobFencingToken}/{@linkcode isJobFencingTokenCurrent} for the duration of this
 * call, then the real handler runs.
 *
 * A no-op passthrough (the real `handler`, unwrapped) when no `'controlPlane'` core-provider slot
 * is registered (`@zanix/app/core` was never imported) — the single-process case, where
 * there is inherently only one replica and nothing to coordinate.
 *
 * @param appName The app that declared this job.
 * @param jobName The job's own short name (already app-namespaced by `registerNamespacedJobs`'s
 * own `${appName}:${jobName}` convention — passed here as the SEPARATE `appName`/`jobName` pair
 * `LeaderElection` itself expects, not the pre-joined namespaced string).
 * @param handler The app author's own job handler, exactly as declared in the manifest.
 * @param leaseTtlSeconds Defaults to `30`. A job whose own `schedule` fires more often than this
 * keeps the SAME replica renewing successfully every tick; one that fires less often than this
 * effectively re-acquires fresh each tick instead (still correct — see `LeaderElection`'s own doc
 * on why a "fresh acquire" and a "renewal" are equally valid ways to hold the lease for a tick).
 */
export function wrapWithLeaderElection(
  appName: string,
  jobName: string,
  handler: Job,
  leaseTtlSeconds: number = DEFAULT_LEASE_TTL_SECONDS,
): Job {
  return async function (
    this: ThisParameterType<Job>,
    args: MessageQueue,
  ): Promise<unknown> {
    const provider = resolveControlPlaneProvider()
    if (!provider) return await handler.call(this, args)

    const token = await provider.leaderElection.tryAcquireOrRenew(
      appName,
      jobName,
      PROCESS_HOLDER_ID,
      leaseTtlSeconds,
    )
    if (token === null) return undefined

    fencingTokensByContextId.set(this.context.id, token)
    try {
      return await handler.call(this, args)
    } finally {
      fencingTokensByContextId.delete(this.context.id)
    }
  } as never
}
