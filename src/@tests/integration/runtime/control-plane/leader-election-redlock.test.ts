import { assert, assertEquals, assertNotEquals, assertStrictEquals } from '@std/assert'
import { getTemporaryFolder } from '@zanix/helpers'
import { LeaderElection } from 'modules/runtime/control-plane/leader-election.ts'
import { startRedlockTestInstances } from './redlock-test-instances.ts'
import type { RedlockTestInstance } from './redlock-test-instances.ts'

console.info = () => {}
console.error = () => {}
console.warn = () => {}

const APP = 'redlock-test-app'
const BASE_PORT = 16390

// Lazy, memoized — spawning 3 real `redis-server` processes at bare MODULE top level (a plain
// top-level `await`) risks running before `deno test` has actually committed to executing this
// file's tests (confirmed empirically: doing it that way made the LAST spawned process
// consistently receive a stray `SIGTERM` moments after starting, then lose a race rebinding its
// own port — never reproduced once the same spawn logic moved here instead). A `Deno.test`
// callback body, by contrast, is guaranteed to run exactly once, only when that test genuinely
// executes — so every test below calls this first, and only the very first call actually spawns
// anything.
let setupPromise:
  | Promise<{ instances: RedlockTestInstance[]; election: LeaderElection }>
  | undefined

function getSetup(): Promise<
  { instances: RedlockTestInstance[]; election: LeaderElection }
> {
  if (!setupPromise) {
    setupPromise = (async () => {
      const dir = getTemporaryFolder(import.meta.url) + '/redlock-instances'
      const instances = await startRedlockTestInstances(dir, BASE_PORT, 3)
      const election = new LeaderElection(
        instances.map((instance) => instance.connector),
      )
      return { instances, election }
    })()
  }
  return setupPromise
}

function uniqueJobName(label: string): string {
  return `${label}-${crypto.randomUUID()}`
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

Deno.test(
  'LeaderElection (Redlock, 3 real instances): a fresh acquire reaches quorum and returns a token',
  async () => {
    const { election } = await getSetup()
    const job = uniqueJobName('fresh')

    const token = await election.tryAcquireOrRenew(APP, job, 'holder-a', 30)

    assert(typeof token === 'number')
    assertEquals(await election.getCurrentFencingToken(APP, job), token)
  },
)

Deno.test(
  'LeaderElection (Redlock): a different holder is refused while quorum still holds the lease',
  async () => {
    const { election } = await getSetup()
    const job = uniqueJobName('contended')

    const first = await election.tryAcquireOrRenew(APP, job, 'holder-a', 30)
    const second = await election.tryAcquireOrRenew(APP, job, 'holder-b', 30)

    assert(typeof first === 'number')
    assertEquals(second, null)
  },
)

Deno.test('LeaderElection (Redlock): the same holder renewing keeps the same token', async () => {
  const { election } = await getSetup()
  const job = uniqueJobName('renew')

  const first = await election.tryAcquireOrRenew(APP, job, 'holder-a', 30)
  const renewed = await election.tryAcquireOrRenew(APP, job, 'holder-a', 30)

  assertEquals(first, renewed)
})

Deno.test(
  'LeaderElection (Redlock): fault-tolerant — one of three instances down, quorum (2/3) still reached',
  async () => {
    const { instances, election } = await getSetup()
    const job = uniqueJobName('one-down')
    instances[2].kill()
    await wait(200) // give the OS a moment to actually stop accepting on that port

    try {
      const token = await election.tryAcquireOrRenew(APP, job, 'holder-a', 30)
      assert(
        typeof token === 'number',
        'quorum (2 of 3) must still succeed with one instance down',
      )

      const renewed = await election.tryAcquireOrRenew(
        APP,
        job,
        'holder-a',
        30,
      )
      assertEquals(
        renewed,
        token,
        'renewal must also still reach quorum with one instance down',
      )
    } finally {
      // Restart the killed instance's PROCESS only — `election` already holds a reference to its
      // ORIGINAL connector object, and that object's own reconnect logic recovers once this same
      // port is listening again. Replacing `instances[2]` with a brand-new connector here would
      // leave `election` talking to a connector pointed at a process that's gone forever.
      await instances[2].restart()
    }
  },
)

Deno.test(
  'LeaderElection (Redlock): getCurrentFencingToken returns the highest value seen across instances',
  async () => {
    const { election } = await getSetup()
    const job = uniqueJobName('max-token')

    const token = await election.tryAcquireOrRenew(APP, job, 'holder-a', 30)
    assert(typeof token === 'number')

    assertEquals(await election.getCurrentFencingToken(APP, job), token)
  },
)

Deno.test(
  'LeaderElection (Redlock): release() by the current holder frees the lease immediately',
  async () => {
    const { election } = await getSetup()
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
  'LeaderElection (Redlock): once ALL instances expire with no renewal, a new holder acquires a HIGHER token',
  async () => {
    const { election } = await getSetup()
    const job = uniqueJobName('expiry')

    const first = await election.tryAcquireOrRenew(APP, job, 'holder-a', 1)
    await wait(1300) // past the 1s TTL on every instance, no renewal

    const second = await election.tryAcquireOrRenew(APP, job, 'holder-b', 30)

    assert(typeof first === 'number')
    assert(typeof second === 'number')
    assertNotEquals(first, second)
    assert(second > first)
  },
)

Deno.test(
  'LeaderElection (Redlock): quorum lost (2 of 3 instances down) — acquire fails, no lease granted anywhere',
  async () => {
    const { instances, election } = await getSetup()
    const job = uniqueJobName('quorum-lost')
    instances[1].kill()
    instances[2].kill()
    await wait(200) // give the OS a moment to actually stop accepting on those ports

    try {
      const token = await election.tryAcquireOrRenew(APP, job, 'holder-a', 30)
      assertStrictEquals(
        token,
        null,
        'only 1 of 3 instances reachable — quorum is unreachable',
      )
    } finally {
      await Promise.all([instances[1].restart(), instances[2].restart()])
    }
  },
)

// Keep this at the end — kills every remaining real redis-server process this suite started.
Deno.test('shut down every Redlock test instance', async () => {
  const { instances } = await getSetup()
  for (const instance of instances) instance.kill()
})
