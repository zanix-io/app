import { assert, assertEquals, assertRejects } from '@std/assert'
import { ResourceRegistry } from 'modules/runtime/resource-registry.ts'

console.error = () => {}

Deno.test('resolve: different qualifiedKeys get independent instances', async () => {
  const registry = new ResourceRegistry()

  const a = await registry.resolve('a', () => Promise.resolve({ id: 'a' }))
  const b = await registry.resolve('b', () => Promise.resolve({ id: 'b' }))

  assertEquals(a, { id: 'a' })
  assertEquals(b, { id: 'b' })
})

Deno.test(
  'resolve: a second call for the SAME key returns the same instance without re-invoking ' +
    'factory',
  async () => {
    const registry = new ResourceRegistry()
    let calls = 0
    const factory = () => {
      calls++
      return Promise.resolve({ id: 'shared' })
    }

    const first = await registry.resolve('shared', factory)
    const second = await registry.resolve('shared', factory)

    assert(first === second, 'both callers must receive the exact same instance')
    assertEquals(calls, 1)
  },
)

Deno.test(
  'resolve: two callers racing for the SAME key concurrently (no await between them) invoke ' +
    'factory exactly once — memoized by the in-flight PROMISE, not by the resolved value',
  async () => {
    const registry = new ResourceRegistry()
    let calls = 0
    let releaseFactory: () => void = () => {}
    const gate = new Promise<void>((resolve) => (releaseFactory = resolve))

    const factory = async () => {
      calls++
      await gate // stay pending, so both callers are guaranteed to race while construction is
      // still in flight, not just call resolve() at literally the same tick
      return { id: 'raced' }
    }

    // Neither call is awaited yet — both fire while the other's promise is still pending.
    const firstCall = registry.resolve('raced', factory)
    const secondCall = registry.resolve('raced', factory)

    releaseFactory()
    const [first, second] = await Promise.all([firstCall, secondCall])

    assertEquals(calls, 1, 'factory must run exactly once, not once per concurrent caller')
    assert(first === second, 'both concurrent callers must receive the same resolved instance')
  },
)

Deno.test(
  'resolve: a rejecting factory propagates the SAME rejection to a second concurrent caller, ' +
    'without retrying',
  async () => {
    const registry = new ResourceRegistry()
    let calls = 0
    const failure = new Error('construction failed')
    const factory = () => {
      calls++
      return Promise.reject(failure)
    }

    const firstCall = registry.resolve('broken', factory)
    const secondCall = registry.resolve('broken', factory)

    const firstError = await assertRejects(() => firstCall)
    const secondError = await assertRejects(() => secondCall)

    assertEquals(calls, 1, 'a rejecting factory must never be retried for a second caller')
    assert(firstError === failure && secondError === failure, 'both callers see the same rejection')
  },
)

Deno.test(
  'close: Promise.allSettled semantics — one resource failing to close never stops the others, ' +
    'and the failure surfaces as an AggregateError instead of being swallowed',
  async () => {
    const registry = new ResourceRegistry()
    let goodClosed = false

    await registry.resolve(
      'good',
      () =>
        Promise.resolve({
          close: () => {
            goodClosed = true
          },
        }),
    )
    await registry.resolve(
      'bad',
      () =>
        Promise.resolve({
          close: () => {
            throw new Error('close failed')
          },
        }),
    )

    const error = await assertRejects(() => registry.close(), AggregateError)

    assert(goodClosed, "a sibling resource's close() must still run despite another's failure")
    assertEquals((error as AggregateError).errors.length, 1)
  },
)

Deno.test(
  "close: a key whose construction itself rejected is skipped — it's not reported as a close " +
    'failure (that would misattribute a construction failure as a close failure)',
  async () => {
    const registry = new ResourceRegistry()

    // Swallow the expected rejection at the call site — close() must still handle it gracefully
    // internally regardless of whether the original caller awaited/caught it.
    await registry
      .resolve('never-built', () => Promise.reject(new Error('construction failed')))
      .catch(() => {})

    await registry.close() // must NOT throw — nothing ever constructed, nothing to close
  },
)

Deno.test('close: a registry with nothing resolved is a no-op', async () => {
  const registry = new ResourceRegistry()
  await registry.close()
})
