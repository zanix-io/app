import { assertEquals, assertStrictEquals } from '@std/assert'
import { getJobFencingToken, wrapWithLeaderElection } from 'modules/runtime/job-leader-election.ts'

// Deliberately never imports `@zanix/app/core` — this file's own process/worker never registers
// the `'controlPlane'` core-provider slot, so `resolveControlPlaneProvider()` stays `undefined`
// throughout, exercising the single-process passthrough these two functions fall back to
// when no Control Plane is configured at all. `job-leader-election.test.ts` in
// `@tests/integration` covers the real, `'controlPlane'`-registered behavior instead — per-file
// isolation (a fresh Deno worker per test file) keeps the two from interfering with each other.

function fakeThis(): { context: { id: string } } {
  return { context: { id: crypto.randomUUID() } }
}

Deno.test(
  'wrapWithLeaderElection: with no controlPlane provider registered, it is a pure passthrough — the real handler always runs, no fencing token is ever stashed',
  async () => {
    let calls = 0
    let observedTokenDuringCall: number | undefined

    const wrapped = wrapWithLeaderElection(
      'job-leader-passthrough-app',
      'nightly',
      function (this: unknown) {
        calls++
        observedTokenDuringCall = getJobFencingToken(
          (this as { context: { id: string } }).context,
        )
        return 'handled'
      },
    )

    const result = await wrapped.call(fakeThis() as never, {})

    assertEquals(calls, 1)
    assertEquals(result, 'handled')
    assertStrictEquals(observedTokenDuringCall, undefined)
  },
)
