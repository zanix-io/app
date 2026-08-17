import { assert, assertEquals, assertRejects } from '@std/assert'
import { buildGraph, normalize } from 'modules/manifest/mod.ts'
import { runOnStart, runOnStop } from 'modules/runtime/lifecycle.ts'
import { resolveResources } from 'modules/runtime/resolve-resources.ts'
import { registerResourceType } from 'modules/runtime/resource-types.ts'
import { ResourceRegistry } from 'modules/runtime/resource-registry.ts'

console.error = () => {}

Deno.test(
  'runOnStart: runs sequentially, in declaration order — B never starts before A fully resolves',
  async () => {
    const order: string[] = []
    let releaseA: () => void = () => {}
    const gateA = new Promise<void>((resolve) => (releaseA = resolve))

    const appA = normalize({
      name: 'app-a-sequential',
      onStart: async () => {
        order.push('a-start')
        await gateA
        order.push('a-end')
      },
    })
    const appB = normalize({
      name: 'app-b-sequential',
      onStart: () => {
        order.push('b-start')
      },
    })

    const runPromise = runOnStart([appA, appB], new Map())

    // Let the event loop tick without resolving A's gate — if runOnStart were parallel, B would
    // already have run by now (its onStart has no await at all). Sequential means B must still
    // be untouched.
    await new Promise((resolve) => setTimeout(resolve, 0))
    assertEquals(
      order,
      ['a-start'],
      "B must not run until A's onStart fully resolves",
    )

    releaseA()
    await runPromise

    assertEquals(order, ['a-start', 'a-end', 'b-start'])
  },
)

Deno.test('runOnStart: an app with no onStart is simply skipped', async () => {
  const appWithout = normalize({ name: 'app-no-onstart' })
  await runOnStart([appWithout], new Map()) // must not throw
})

Deno.test(
  "runOnStop: runs in PARALLEL — one app's onStop throwing never blocks another's from running",
  async () => {
    let bRan = false
    const appA = normalize({
      name: 'app-a-stop-fails',
      onStop: () => {
        throw new Error('boom')
      },
    })
    const appB = normalize({
      name: 'app-b-stop-ok',
      onStop: () => {
        bRan = true
      },
    })

    const error = await assertRejects(
      () => runOnStop([appA, appB], new Map()),
      AggregateError,
    )

    assert(bRan, "B's onStop must still run despite A's failure")
    assertEquals((error as AggregateError).errors.length, 1)
  },
)

Deno.test('runOnStop: an app with no onStop is simply skipped, no error', async () => {
  const appWithout = normalize({ name: 'app-no-onstop' })
  await runOnStop([appWithout], new Map()) // must not throw
})

Deno.test(
  'lifecycle ordering: resources stay open for the whole runOnStop call, closed only after it resolves',
  async () => {
    let closed = false
    registerResourceType('lifecycle-order-fake', () => ({
      close: () => {
        closed = true
      },
    }))

    const registry = new ResourceRegistry()
    let sawResourceDuringOnStop: unknown

    const def = normalize({
      name: 'app-lifecycle-order',
      dependencies: { database: { type: 'lifecycle-order-fake' } },
      onStop: (ctx) => {
        sawResourceDuringOnStop = ctx.resource('database')
      },
    })
    const graph = buildGraph(
      [def],
      { db: { type: 'lifecycle-order-fake', options: {} } },
      [{
        appName: 'app-lifecycle-order',
        slot: 'database',
        resourceName: 'db',
      }],
    )
    const resources = await resolveResources(graph, registry)

    await runOnStop([def], resources)

    assert(
      sawResourceDuringOnStop,
      'onStop must see a real, resolved resource, not undefined',
    )
    assert(
      !closed,
      "must NOT be closed yet — runOnStop resolved, but registry.close() wasn't called",
    )

    await registry.close()

    assert(
      closed,
      'must be closed now, strictly AFTER runOnStop already resolved',
    )
  },
)
