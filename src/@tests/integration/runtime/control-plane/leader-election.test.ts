import { assert, assertEquals, assertNotEquals } from '@std/assert'
import { ZanixRedisConnector } from '@zanix/datamaster'
import { LeaderElection } from 'modules/runtime/control-plane/leader-election.ts'

console.info = () => {}
console.error = () => {}
console.warn = () => {}

// Real Redis connector — no mocking, same pattern as the rest of this suite's control-plane tests.
const connector = new ZanixRedisConnector()
const election = new LeaderElection(connector)

function uniqueJobName(label: string): string {
  return `leader-election-test-${label}-${crypto.randomUUID()}`
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const APP = 'leader-election-app'

Deno.test('LeaderElection: a fresh acquire succeeds and returns a fencing token', async () => {
  const job = uniqueJobName('fresh')

  const token = await election.tryAcquireOrRenew(APP, job, 'holder-a', 30)

  assert(typeof token === 'number')
  assertEquals(await election.getCurrentFencingToken(APP, job), token)
})

Deno.test(
  'LeaderElection: a DIFFERENT holder is refused while the lease is still live',
  async () => {
    const job = uniqueJobName('contended')

    const first = await election.tryAcquireOrRenew(APP, job, 'holder-a', 30)
    const second = await election.tryAcquireOrRenew(APP, job, 'holder-b', 30)

    assert(typeof first === 'number')
    assertEquals(second, null)
  },
)

Deno.test(
  'LeaderElection: the SAME holder renewing keeps the SAME fencing token',
  async () => {
    const job = uniqueJobName('renew')

    const first = await election.tryAcquireOrRenew(APP, job, 'holder-a', 30)
    const renewed = await election.tryAcquireOrRenew(APP, job, 'holder-a', 30)

    assertEquals(first, renewed)
  },
)

Deno.test(
  'LeaderElection: once the lease expires, a NEW holder acquires a HIGHER fencing token',
  async () => {
    const job = uniqueJobName('expiry')

    const first = await election.tryAcquireOrRenew(APP, job, 'holder-a', 1)
    await wait(1300) // past the 1s TTL — no renewal in between

    const second = await election.tryAcquireOrRenew(APP, job, 'holder-b', 30)

    assert(typeof first === 'number')
    assert(typeof second === 'number')
    assertNotEquals(first, second)
    assert(second > first)
  },
)

Deno.test(
  'LeaderElection: getCurrentFencingToken is null for a lease that was never acquired',
  async () => {
    const job = uniqueJobName('never-acquired')

    assertEquals(await election.getCurrentFencingToken(APP, job), null)
  },
)

Deno.test(
  'LeaderElection: release() by the current holder frees the lease immediately',
  async () => {
    const job = uniqueJobName('release')

    await election.tryAcquireOrRenew(APP, job, 'holder-a', 30)
    await election.release(APP, job, 'holder-a')

    const reacquired = await election.tryAcquireOrRenew(
      APP,
      job,
      'holder-b',
      30,
    )
    assert(typeof reacquired === 'number')
  },
)

Deno.test(
  "LeaderElection: release() by a NON-holder never touches someone else's live lease",
  async () => {
    const job = uniqueJobName('release-wrong-holder')

    await election.tryAcquireOrRenew(APP, job, 'holder-a', 30)
    await election.release(APP, job, 'holder-b')

    const stillContended = await election.tryAcquireOrRenew(
      APP,
      job,
      'holder-b',
      30,
    )
    assertEquals(stillContended, null)
  },
)

// Keep this at the end to ensure the Redis connection (socket) closes properly.
Deno.test('close the shared Redis connection', () => {
  connector['close']()
})
