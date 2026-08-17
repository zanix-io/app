import { assert, assertEquals, assertStrictEquals } from '@std/assert'
import { ProgramModule } from '@zanix/server'
import type { ZanixControlPlaneProvider } from 'modules/runtime/control-plane/mod.ts'
import {
  getJobFencingToken,
  isJobFencingTokenCurrent,
  wrapWithLeaderElection,
} from 'modules/runtime/job-leader-election.ts'

console.info = () => {}
console.error = () => {}
console.warn = () => {}

// Same real-infra bootstrapping `control-plane/provider.test.ts` already establishes: `REDIS_URI`
// must be set BEFORE `@zanix/datamaster/core` evaluates, and `@zanix/app/core` is what actually
// registers the `'controlPlane'` slot `wrapWithLeaderElection`/`resolveControlPlaneProvider`
// auto-detect. No manual Redis connection to close afterward — the connector lives on the shared
// DI-resolved provider, same as `control-plane/provider.test.ts`.
Deno.env.set('REDIS_URI', 'redis://localhost:6379')
await import('@zanix/datamaster/core')
await import('@zanix/app/core')

/** A minimal stand-in for the `this` a `Job` handler is actually invoked with — only `context.id`
 * matters to `wrapWithLeaderElection`/`getJobFencingToken`, so `providers`/`interactors`/
 * `connectors` are never touched by anything under test here. */
function fakeThis(): { context: { id: string } } {
  return { context: { id: crypto.randomUUID() } }
}

function getProvider(): ZanixControlPlaneProvider {
  const provider = ProgramModule.getProviders().get<ZanixControlPlaneProvider>(
    'controlPlane',
  )
  assert(
    provider,
    'the controlPlane provider slot must resolve once @zanix/app/core is imported',
  )
  return provider
}

Deno.test(
  'wrapWithLeaderElection: this replica (the only one contending) runs the real handler',
  async () => {
    const appName = `job-leader-test-${crypto.randomUUID()}`
    let calls = 0

    const wrapped = wrapWithLeaderElection(appName, 'nightly', (args) => {
      calls++
      return args
    })

    const result = await wrapped.call(fakeThis() as never, { hi: 1 })

    assertEquals(calls, 1)
    assertEquals(result, { hi: 1 })
  },
)

Deno.test(
  'wrapWithLeaderElection: a DIFFERENT replica already holding the lease is skipped — no call to the real handler',
  async () => {
    const appName = `job-leader-test-${crypto.randomUUID()}`
    const jobName = 'nightly'

    // Simulates another, already-running replica holding this job's lease — same shared Redis
    // state `wrapWithLeaderElection` itself reads through the SAME `provider.leaderElection`.
    const otherReplicaToken = await getProvider().leaderElection
      .tryAcquireOrRenew(
        appName,
        jobName,
        'other-replica',
        30,
      )
    assert(typeof otherReplicaToken === 'number')

    let calls = 0
    const wrapped = wrapWithLeaderElection(appName, jobName, () => {
      calls++
    })

    const result = await wrapped.call(fakeThis() as never, {})

    assertEquals(calls, 0)
    assertStrictEquals(result, undefined)
  },
)

Deno.test(
  'wrapWithLeaderElection: exposes a fencing token during the call, matching the current Redis value',
  async () => {
    const appName = `job-leader-test-${crypto.randomUUID()}`
    const jobName = 'nightly'
    let observedTokenDuringCall: number | undefined

    const wrapped = wrapWithLeaderElection(
      appName,
      jobName,
      function (this: unknown) {
        const context = (this as { context: { id: string } }).context
        observedTokenDuringCall = getJobFencingToken(context)
      },
    )

    const invocationThis = fakeThis()
    await wrapped.call(invocationThis as never, {})

    assert(typeof observedTokenDuringCall === 'number')
    assertEquals(
      await getProvider().leaderElection.getCurrentFencingToken(
        appName,
        jobName,
      ),
      observedTokenDuringCall,
    )

    // Cleared once the call has returned — not visible for a context id from a finished call.
    assertStrictEquals(getJobFencingToken(invocationThis.context), undefined)
  },
)

Deno.test(
  'isJobFencingTokenCurrent: true with no token stashed for this context (nothing to invalidate)',
  async () => {
    const appName = `job-leader-test-${crypto.randomUUID()}`
    const stillCurrent = await isJobFencingTokenCurrent(
      appName,
      'nightly',
      fakeThis().context,
    )
    assertStrictEquals(stillCurrent, true)
  },
)

Deno.test(
  'isJobFencingTokenCurrent: false once a newer term starts WHILE this handler is still running',
  async () => {
    const appName = `job-leader-test-${crypto.randomUUID()}`
    const jobName = 'nightly'
    let stillCurrentBeforeTakeover: boolean | undefined
    let stillCurrentAfterTakeover: boolean | undefined

    // 1s TTL (this test's own override) — long enough for the handler to observe "still current"
    // right away, short enough to have already lapsed by the time it checks again.
    const wrapped = wrapWithLeaderElection(
      appName,
      jobName,
      async function (this: unknown) {
        const context = (this as { context: { id: string } }).context
        stillCurrentBeforeTakeover = await isJobFencingTokenCurrent(
          appName,
          jobName,
          context,
        )

        await new Promise((resolve) => setTimeout(resolve, 1300)) // past the 1s TTL, no renewal
        await getProvider().leaderElection.tryAcquireOrRenew(
          appName,
          jobName,
          'a-different-replica',
          30,
        )

        // Same execution, same stashed token — but Redis has since moved on to a newer term.
        stillCurrentAfterTakeover = await isJobFencingTokenCurrent(
          appName,
          jobName,
          context,
        )
      },
      1,
    )
    await wrapped.call(fakeThis() as never, {})

    assertStrictEquals(stillCurrentBeforeTakeover, true)
    assertStrictEquals(stillCurrentAfterTakeover, false)
  },
)
