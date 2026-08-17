import { assertEquals, assertThrows } from '@std/assert'
import { registerJob } from '@zanix/asyncmq'
import { getNamespacedJobOrigin, registerNamespacedJobs } from 'modules/runtime/register-jobs.ts'
import { normalize } from 'modules/manifest/normalize.ts'

console.error = () => {}

function appWithJob(appName: string, jobName: string) {
  return normalize({
    name: appName,
    jobs: { [jobName]: { processingQueue: 'soft', handler: () => {} } },
  })
}

Deno.test(
  'registerNamespacedJobs: two apps declaring a job of the SAME short name do not collide',
  () => {
    // Neither call throws — that IS the assertion (a same-name collision across apps would
    // throw, since @zanix/asyncmq's own registerJob rejects a duplicate name).
    registerNamespacedJobs(appWithJob('billing-jobs-test', 'syncProducts'))
    registerNamespacedJobs(appWithJob('inventory-jobs-test', 'syncProducts'))

    assertEquals(getNamespacedJobOrigin('billing-jobs-test:syncProducts'), {
      appName: 'billing-jobs-test',
      originalName: 'syncProducts',
    })
    assertEquals(getNamespacedJobOrigin('inventory-jobs-test:syncProducts'), {
      appName: 'inventory-jobs-test',
      originalName: 'syncProducts',
    })
  },
)

Deno.test(
  'registerNamespacedJobs: the SAME app registering the SAME job name twice still collides (namespacing does not suppress real duplicates)',
  () => {
    const def = appWithJob('reviews-duplicate-test', 'sendDigest')
    registerNamespacedJobs(def)

    assertThrows(() => registerNamespacedJobs(def))
  },
)

Deno.test(
  'registerNamespacedJobs: a scheduled job (has `schedule`) registers under its namespaced name too',
  () => {
    const def = normalize({
      name: 'scheduler-test-app',
      jobs: {
        nightlyReport: {
          schedule: '0 0 0 * * *',
          processingQueue: 'soft',
          handler: () => {},
        },
      },
    })

    registerNamespacedJobs(def) // must not throw

    assertEquals(getNamespacedJobOrigin('scheduler-test-app:nightlyReport'), {
      appName: 'scheduler-test-app',
      originalName: 'nightlyReport',
    })
  },
)

Deno.test(
  "registerNamespacedJobs: a job registered OUTSIDE it (a plain service's direct registerJob call) is never namespaced and never appears in the lateral map",
  () => {
    registerJob({
      name: 'plain-service-job-outside-app',
      processingQueue: 'soft',
      handler: () => {},
    })

    assertEquals(
      getNamespacedJobOrigin('plain-service-job-outside-app'),
      undefined,
    )
  },
)
