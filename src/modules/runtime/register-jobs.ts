import type { NormalizedAppDefinition } from 'typings/manifest.ts'
import { wrapWithLeaderElection } from './job-leader-election.ts'
import { ASYNCMQ_SPECIFIER } from '../lazy/specifiers.ts'

/**
 * Narrow, hand-declared shape for exactly the two `@zanix/asyncmq/jobs` exports this module
 * calls — deliberately NOT `typeof import('@zanix/asyncmq/jobs')`, even though that subpath is
 * itself narrow (no RabbitMQ/`amqplib`, see `modules/lazy/specifiers.ts`'s own doc). The constraint
 * driving this shape is independent of the subpath's own narrowness: `ASYNCMQ_SPECIFIER`
 * is a non-literal (a variable, not an inline string), by design — see this file's own doc on
 * `registerNamespacedJobs` — and TypeScript can only infer a dynamic `import()`'s shape from a
 * LITERAL specifier argument; a `typeof import(SOME_VARIABLE)` isn't valid syntax at all, so
 * there's no automatic shape to fall back to regardless of what `./jobs` itself contains. Call
 * sites already cast the job/cron shape to `never` (the real, precise shapes are
 * `@zanix/asyncmq/jobs`'s own, re-exported from `typings/manifest.ts`), so this only needs to
 * describe the two functions themselves.
 */
interface AsyncmqExports {
  registerJob: (job: never) => void
  registerCronJob: (job: never) => void
}

/** What a namespaced job name resolves back to, for logs/errors that want to show the app author
 * the name they actually wrote, not the namespaced one `@zanix/asyncmq` sees. */
export interface NamespacedJobOrigin {
  /** The app that declared this job in its own manifest. */
  appName: string
  /** The short job name the app author actually wrote, before namespacing. */
  originalName: string
}

/**
 * Lateral map from `${appName}:${jobName}` back to `{appName, originalName}` — `@zanix/asyncmq`
 * itself never sees the short name, only ever the namespaced one, so anything (logs, error
 * messages this module itself emits) that wants to show the author's own name back needs this.
 * Module-level, not per-call: populated once per job as apps register, read by
 * {@link getNamespacedJobOrigin} for the lifetime of the process.
 */
const namespacedJobOrigins = new Map<string, NamespacedJobOrigin>()

/**
 * Registers every job in `def.jobs`, namespaced to `${def.name}:${jobName}` — the only way a
 * job declared through an installed app's manifest ever reaches `@zanix/asyncmq`'s own registry,
 * so two apps declaring a job of the same short name never collide. Never called for a job
 * registered outside an app's own manifest (a plain service's direct `registerJob` call is
 * untouched by this module entirely — that call never runs through here).
 *
 * A `schedule` present on the entry routes it to `registerCronJob`; absent, to `registerJob` —
 * same discriminator `NormalizedAppDefinition.jobs` itself already uses.
 *
 * A scheduled (`schedule` present) job's own `handler` is additionally wrapped with
 * {@link wrapWithLeaderElection}: only the ONE replica currently holding
 * `${appName}:${jobName}`'s lease actually runs a given tick, everyone else's own delivery of that
 * same tick is a no-op. Never applied to a non-scheduled job (`registerJob`): its own delivery is
 * already exactly-once-per-message via the underlying queue's competing-consumer semantics
 * (confirmed against `@zanix/asyncmq`'s actual RabbitMQ dispatch — same reasoning as events), so
 * there's nothing for leader election to add there.
 *
 * `@zanix/asyncmq/jobs` itself is reached through a DELIBERATELY non-literal `import()` specifier
 * (assigned to a local variable first, never `import('@zanix/asyncmq/jobs')` inline) — Deno's
 * module graph builder (and, transitively, the Vite/Rolldown dependency scan that walks it during
 * `zanix space build`) only follows a dynamic import whose argument is a string literal it can
 * analyze statically; routing it through a variable keeps this VALUE-level `import()` itself from
 * ever running for any app that declares no `jobs` at all — real, executed module evaluation
 * (actually loading `@zanix/asyncmq/jobs`'s code and whatever it needs at runtime), as opposed to
 * `typings/manifest.ts`'s own separate, unconditional TYPE-level import of the same subpath (see
 * that module's own doc — a zero-`jobs` app still pays that one, since it's a real static import).
 * It's fetched, once, lazily — never merely by importing `@zanix/app/runtime` or calling
 * `registerApp` for an app with an empty `jobs` manifest (checked BEFORE the import, not after).
 *
 * @param def The app whose jobs are being registered — expected to already be inside the
 * `ProgramModule.defineApplication(def.name, ...)` scope that owns this app's composition.
 */
export async function registerNamespacedJobs(
  def: NormalizedAppDefinition,
): Promise<void> {
  const entries = Object.entries(def.jobs)
  if (!entries.length) return

  const specifier = ASYNCMQ_SPECIFIER
  const { registerCronJob, registerJob } = await import(specifier) as AsyncmqExports

  for (const [jobName, job] of entries) {
    const namespacedName = `${def.name}:${jobName}`
    namespacedJobOrigins.set(namespacedName, {
      appName: def.name,
      originalName: jobName,
    })

    const queueSelector = job.processingQueue !== undefined
      ? { processingQueue: job.processingQueue }
      : { customQueue: job.customQueue }

    if (job.schedule) {
      registerCronJob({
        name: namespacedName,
        schedule: job.schedule,
        isActive: job.isActive,
        handler: job.handler &&
          wrapWithLeaderElection(def.name, jobName, job.handler),
        ...queueSelector,
      } as never)
    } else {
      registerJob({
        name: namespacedName,
        handler: job.handler,
        ...queueSelector,
      } as never)
    }
  }
}

/** Resolves a namespaced job name (`${appName}:${jobName}`) back to the app/original name it
 * came from — `undefined` if `namespacedName` was never registered through
 * {@link registerNamespacedJobs} (e.g. a plain, non-namespaced job registered outside any app). */
export function getNamespacedJobOrigin(
  namespacedName: string,
): NamespacedJobOrigin | undefined {
  return namespacedJobOrigins.get(namespacedName)
}
