import { assert, assertEquals } from '@std/assert'
import { activateApps } from 'modules/runtime/activate-apps.ts'
import { installApp } from 'modules/runtime/install-app.ts'
import { resolveConfig, setConfigOverride } from 'modules/runtime/config-overrides.ts'

console.error = () => {}

Deno.test(
  "resolveConfig(appName, key): finds the app's own declared default, standalone (no ctx)",
  async () => {
    await activateApps([{
      name: 'resolve-config-default',
      config: { port: { type: 'number', default: 8080 } },
    }])

    assertEquals(resolveConfig('resolve-config-default', 'port'), 8080)
  },
)

Deno.test(
  'resolveConfig(appName, key): a host override replaces the declared default, standalone (no ctx)',
  async () => {
    await activateApps([{
      name: 'resolve-config-override',
      config: { port: { type: 'number', default: 8080 } },
    }])

    setConfigOverride('resolve-config-override', 'port', 9090)

    assertEquals(resolveConfig('resolve-config-override', 'port'), 9090)
  },
)

Deno.test(
  'resolveConfig() and ctx.config.get() resolve the exact same value — same registry, two entry points',
  async () => {
    let seenViaCtx: unknown
    await activateApps([{
      name: 'resolve-config-same-as-ctx',
      config: { pageSize: { type: 'number', default: 25 } },
      onStart: (ctx: { config: { get(key: string): unknown } }) => {
        seenViaCtx = ctx.config.get('pageSize')
      },
    }])

    const seenViaResolve = resolveConfig('resolve-config-same-as-ctx', 'pageSize')
    assertEquals(seenViaCtx, 25)
    assertEquals(seenViaResolve, 25)
    assertEquals(seenViaCtx, seenViaResolve)
  },
)

Deno.test(
  'resolveConfig(appName, key): undefined when neither an override nor a default was ever registered',
  () => {
    assertEquals(
      resolveConfig('resolve-config-never-activated', 'anything'),
      undefined,
    )
  },
)

Deno.test(
  'resolveConfig(appName, key): undefined for a key declared with no default, same as one never declared at all',
  async () => {
    await activateApps([{
      name: 'resolve-config-no-default',
      config: { apiKey: { type: 'string', secret: true, required: true } },
    }])

    assertEquals(resolveConfig('resolve-config-no-default', 'apiKey'), undefined)
    assertEquals(resolveConfig('resolve-config-no-default', 'neverDeclared'), undefined)
  },
)

Deno.test(
  'resolveConfig<T>/ctx.config.get: the generic types the resolved value without an external cast',
  async () => {
    await activateApps([{
      name: 'resolve-config-generic',
      config: { retries: { type: 'number', default: 3 } },
    }])

    const resolved = resolveConfig<number>('resolve-config-generic', 'retries')
    // No `as`/cast anywhere above — the generic alone types `resolved` as `number | undefined`.
    assertEquals(resolved, 3)
  },
)

Deno.test(
  'resolveConfig(appName, key): resolves an installApp()-time config default, standalone',
  async () => {
    const activated = await activateApps([{ name: 'resolve-config-install-base' }])

    await installApp(activated, {
      name: 'resolve-config-install-new',
      config: { timeoutMs: { type: 'number', default: 5000 } },
    })

    assertEquals(resolveConfig('resolve-config-install-new', 'timeoutMs'), 5000)
  },
)

Deno.test(
  "resolveConfig(appName, key): a different app's own config default never leaks across apps",
  async () => {
    await activateApps([
      { name: 'resolve-config-sibling-a', config: { limit: { type: 'number', default: 10 } } },
      { name: 'resolve-config-sibling-b', config: { limit: { type: 'number', default: 20 } } },
    ])

    assertEquals(resolveConfig('resolve-config-sibling-a', 'limit'), 10)
    assertEquals(resolveConfig('resolve-config-sibling-b', 'limit'), 20)
    assert(
      resolveConfig('resolve-config-sibling-a', 'limit') !==
        resolveConfig('resolve-config-sibling-b', 'limit'),
    )
  },
)
