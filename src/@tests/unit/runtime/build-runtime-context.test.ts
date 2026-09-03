// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals, assertStrictEquals } from '@std/assert'
import { buildRuntimeContext } from 'modules/runtime/build-runtime-context.ts'
import { registerConfigDefaults, setConfigOverride } from 'modules/runtime/config-overrides.ts'

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
    name: 'build-runtime-context-default-app',
    config: {
      port: {
        default: 8080,
      },
    },
  } as any

  // config.get delegates to resolveConfig(def.name, key), which reads the process-wide
  // `configDefaults` registry `registerConfigDefaults` populates at registerApp() time — same
  // requirement `ctx.behavior()`/`resolveBehavior` already has for `registerBehaviors`.
  registerConfigDefaults(def)

  const resources = new Map<string, unknown>()

  const ctx = buildRuntimeContext(def, resources)

  assertEquals(ctx.config.get('port'), 8080)
})

Deno.test({
  name:
    'buildRuntimeContext - config.get prefers a live Config Plane override over the manifest default',
  fn: () => {
    const def = {
      name: 'build-runtime-context-override-app',
      config: {
        port: {
          default: 8080,
        },
      },
    } as any

    setConfigOverride('build-runtime-context-override-app', 'port', 9090)

    const ctx = buildRuntimeContext(def, new Map())

    assertEquals(ctx.config.get('port'), 9090)
  },
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
