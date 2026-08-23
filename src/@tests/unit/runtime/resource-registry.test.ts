import { assert, assertEquals, assertRejects } from '@std/assert'
import { InternalError } from '@zanix/errors'
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

    assert(
      first === second,
      'both callers must receive the exact same instance',
    )
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

    assertEquals(
      calls,
      1,
      'factory must run exactly once, not once per concurrent caller',
    )
    assert(
      first === second,
      'both concurrent callers must receive the same resolved instance',
    )
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

    assertEquals(
      calls,
      1,
      'a rejecting factory must never be retried for a second caller',
    )
    assert(
      firstError === failure && secondError === failure,
      'both callers see the same rejection',
    )
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

    assert(
      goodClosed,
      "a sibling resource's close() must still run despite another's failure",
    )
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
      .resolve(
        'never-built',
        () => Promise.reject(new Error('construction failed')),
      )
      .catch(() => {})

    await registry.close() // must NOT throw — nothing ever constructed, nothing to close
  },
)

Deno.test('close: a registry with nothing resolved is a no-op', async () => {
  const registry = new ResourceRegistry()
  await registry.close()
})

// --- release() / reference counting (hot install/uninstall) ---

Deno.test(
  'release: a resource shared by TWO apps stays open when only ONE releases it',
  async () => {
    const registry = new ResourceRegistry()
    let closed = false
    const factory = () =>
      Promise.resolve({
        close: () => {
          closed = true
        },
      })

    await registry.resolve('shared', factory, 'app-a')
    await registry.resolve('shared', factory, 'app-b')

    await registry.release('shared', 'app-a')
    assert(
      !closed,
      'the resource must stay open while app-b still references it',
    )

    await registry.release('shared', 'app-b')
    assert(
      closed,
      'the resource must close once its LAST referencing app releases it',
    )
  },
)

Deno.test(
  'release: releasing the same app twice is a no-op the second time (already removed from the set)',
  async () => {
    const registry = new ResourceRegistry()
    let closeCalls = 0
    await registry.resolve(
      'solo',
      () => Promise.resolve({ close: () => closeCalls++ }),
      'app-a',
    )

    await registry.release('solo', 'app-a')
    await registry.release('solo', 'app-a') // must not throw, must not double-close

    assertEquals(closeCalls, 1)
  },
)

Deno.test(
  'release: a qualifiedKey never resolved with an ownerApp has nothing to release — no-op',
  async () => {
    const registry = new ResourceRegistry()
    let closed = false
    await registry.resolve('no-owner', () =>
      Promise.resolve({
        close: () => {
          closed = true
        },
      }))

    await registry.release('no-owner', 'some-app')

    assert(
      !closed,
      'a resource resolved without ownerApp tracking is never touched by release()',
    )
  },
)

Deno.test(
  'release: a qualifiedKey whose original resolve() rejected (construction failed) is released ' +
    'cleanly — no AggregateError, nothing to close (the promise itself never resolved to an ' +
    'instance)',
  async () => {
    const registry = new ResourceRegistry()
    const failure = new Error('construction failed')

    // Swallow the expected rejection at the call site — same as `close()`'s own equivalent test
    // ("a key whose construction itself rejected is skipped") — `release()` must still handle it
    // gracefully internally regardless of whether the original caller awaited/caught it.
    await registry
      .resolve('never-built-then-released', () => Promise.reject(failure), 'app-a')
      .catch(() => {})

    // Must NOT throw — the rejected promise means there was never a real instance to close.
    await registry.release('never-built-then-released', 'app-a')
  },
)

Deno.test(
  "release: a resource's own close() failure surfaces as an AggregateError",
  async () => {
    const registry = new ResourceRegistry()
    await registry.resolve(
      'broken-close',
      () =>
        Promise.resolve({
          close: () => {
            throw new Error('close failed')
          },
        }),
      'app-a',
    )

    const error = await assertRejects(
      () => registry.release('broken-close', 'app-a'),
      AggregateError,
    )
    assertEquals((error as AggregateError).errors.length, 1)
  },
)

// --- setQuota / clearQuota (resource-instance quota) ---

Deno.test(
  'setQuota: a 5th distinct resource for an app already holding 4 (quota 4) rejects with ' +
    'RESOURCE_QUOTA_EXCEEDED — the factory never runs',
  async () => {
    const registry = new ResourceRegistry()
    registry.setQuota('tenant-app', 4)
    let factoryCalls = 0
    const factory = () => {
      factoryCalls++
      return Promise.resolve({ close: () => {} })
    }

    await registry.resolve('res-1', factory, 'tenant-app')
    await registry.resolve('res-2', factory, 'tenant-app')
    await registry.resolve('res-3', factory, 'tenant-app')
    await registry.resolve('res-4', factory, 'tenant-app')

    const error = await assertRejects(
      () => registry.resolve('res-5', factory, 'tenant-app'),
      InternalError,
    )
    assertEquals((error as InternalError).code, 'RESOURCE_QUOTA_EXCEEDED')
    assertEquals(
      factoryCalls,
      4,
      'the 5th factory must never run once the quota is hit',
    )
    // Caller-expected control-flow (a host rejecting an over-quota tenant) — must NOT auto-log.
    assertEquals((error as unknown as { _logged: boolean })._logged, false)
  },
)

Deno.test(
  're-resolving a key an app ALREADY owns never counts against its own quota again',
  async () => {
    const registry = new ResourceRegistry()
    registry.setQuota('tenant-app', 1)
    const factory = () => Promise.resolve({ close: () => {} })

    await registry.resolve('res-1', factory, 'tenant-app')
    // Same key, same owner, again — must NOT throw (still just 1 distinct key owned).
    await registry.resolve('res-1', factory, 'tenant-app')
  },
)

Deno.test(
  'setQuota: referencing an already-shared root resource still counts as ONE unit against the ' +
    "new owner's own quota",
  async () => {
    const registry = new ResourceRegistry()
    registry.setQuota('tenant-b', 0)
    const factory = () => Promise.resolve({ close: () => {} })

    await registry.resolve('shared-root', factory, 'tenant-a') // tenant-a has no quota — unlimited
    const error = await assertRejects(
      () => registry.resolve('shared-root', factory, 'tenant-b'),
      InternalError,
    )
    assertEquals((error as InternalError).code, 'RESOURCE_QUOTA_EXCEEDED')
  },
)

Deno.test(
  'release: freeing a resource makes room under the quota for a different one',
  async () => {
    const registry = new ResourceRegistry()
    registry.setQuota('tenant-app', 1)
    const factory = () => Promise.resolve({ close: () => {} })

    await registry.resolve('res-1', factory, 'tenant-app')
    await registry.release('res-1', 'tenant-app')

    // Must NOT throw — releasing res-1 freed up the one slot the quota allows.
    await registry.resolve('res-2', factory, 'tenant-app')
  },
)

Deno.test(
  'clearQuota: removes a previously-set quota — the app becomes unlimited again',
  async () => {
    const registry = new ResourceRegistry()
    registry.setQuota('tenant-app', 1)
    const factory = () => Promise.resolve({ close: () => {} })
    await registry.resolve('res-1', factory, 'tenant-app')

    registry.clearQuota('tenant-app')

    // Must NOT throw — the quota no longer applies.
    await registry.resolve('res-2', factory, 'tenant-app')
  },
)

Deno.test(
  'setQuota: an app with no quota set is unlimited (default, unchanged behavior)',
  async () => {
    const registry = new ResourceRegistry()
    const factory = () => Promise.resolve({ close: () => {} })

    for (let i = 0; i < 20; i++) {
      // deno-lint-ignore no-await-in-loop -- each key is independent; sequential is just simplest
      await registry.resolve(`res-${i}`, factory, 'unbounded-app')
    }
  },
)
