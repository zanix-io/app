// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals, assertStrictEquals } from '@std/assert'
import { buildRuntimeContext } from 'modules/runtime/build-runtime-context.ts'

Deno.test('buildRuntimeContext - resource', () => {
  const def = {
    name: 'my-app',
    config: {},
  } as any

  const resources = new Map<string, unknown>([
    ['my-app:db', { connected: true }],
  ])

  const ctx = buildRuntimeContext(def, resources)

  assertStrictEquals(ctx.resource('db'), resources.get('my-app:db'))
  assertStrictEquals(ctx.resource('missing'), undefined)
})

Deno.test('buildRuntimeContext - config.get returns default', () => {
  const def = {
    name: 'my-app',
    config: {
      port: {
        default: 8080,
      },
    },
  } as any

  const resources = new Map<string, unknown>()

  const ctx = buildRuntimeContext(def, resources)

  assertEquals(ctx.config.get('port'), 8080)
})

Deno.test('buildRuntimeContext - config.get returns undefined for missing config', () => {
  const def = {
    name: 'my-app',
    config: {},
  } as any

  const resources = new Map<string, unknown>()

  const ctx = buildRuntimeContext(def, resources)

  assertStrictEquals(ctx.config.get('missing'), undefined)
})

Deno.test('buildRuntimeContext - config.has', () => {
  const def = {
    name: 'my-app',
    config: {
      port: {
        default: 8080,
      },
    },
  } as any

  const resources = new Map<string, unknown>()

  const ctx = buildRuntimeContext(def, resources)

  assert(ctx.config.has('port'))
  assert(!ctx.config.has('missing'))
})
