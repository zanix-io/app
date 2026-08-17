import type { NormalizedAppDefinition } from 'typings/manifest.ts'
import { registerCronJob, registerJob } from '@zanix/asyncmq'
import { wrapWithLeaderElection } from './job-leader-election.ts'

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
 * @param def The app whose jobs are being registered — expected to already be inside the
 * `ProgramModule.defineApplication(def.name, ...)` scope that owns this app's composition.
 */
export function registerNamespacedJobs(def: NormalizedAppDefinition): void {
  for (const [jobName, job] of Object.entries(def.jobs)) {
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
