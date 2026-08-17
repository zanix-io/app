import { assert, assertEquals } from '@std/assert'
import { generateRSAKeys } from '@zanix/helpers'
import { ProgramModule } from '@zanix/server'
import { defineZanixApp } from 'modules/manifest/mod.ts'
import { activateApps, deactivateApps } from 'modules/runtime/activate-apps.ts'
import { resolveDefaultDispatcher } from 'modules/runtime/http-remote-adapter.ts'
import type { ZanixControlPlaneProvider } from 'modules/runtime/control-plane/mod.ts'

console.info = () => {}
console.error = () => {}
console.warn = () => {}

// Same real-infra bootstrapping `http-remote-adapter.test.ts` already establishes: `REDIS_URI`
// must be set BEFORE `@zanix/datamaster/core` evaluates (gates whether `cache:redis` actually
// registers), so a dynamic import is used, deliberately sequenced after the env var. Importing
// `@zanix/app/core` is the actual thing under test here — it's what registers `'controlPlane'`.
Deno.env.set('REDIS_URI', 'redis://localhost:6379')
await import('@zanix/datamaster/core')
await import('@zanix/app/core')

Deno.test(
  "ZanixControlPlaneProvider: resolves via DI once '@zanix/app/core' is imported, and its " +
    'controlPlaneRegistry/controlPlaneConfig work against real Redis',
  async () => {
    const provider = ProgramModule.getProviders().get<
      ZanixControlPlaneProvider
    >('controlPlane')
    assert(
      provider,
      'the controlPlane provider slot must resolve once @zanix/app/core is imported',
    )

    const appName = `provider-test-${crypto.randomUUID()}`

    await provider.controlPlaneRegistry.registerInstance(
      appName,
      'instance-1',
      {
        prefix: `/${appName}`,
        endpoint: 'http://localhost:9999',
      },
    )
    assertEquals(
      await provider.controlPlaneRegistry.getDeploymentTarget(appName),
      {
        mode: 'remote',
        prefix: `/${appName}`,
        endpoints: ['http://localhost:9999'],
      },
    )
    await provider.controlPlaneRegistry.deregisterInstance(
      appName,
      'instance-1',
    )

    await provider.controlPlaneConfig.setConfig(
      appName,
      'someKey',
      'someValue',
    )
    assertEquals(
      await provider.controlPlaneConfig.getConfig(appName, 'someKey'),
      'someValue',
    )
  },
)

Deno.test(
  'resolveDefaultDispatcher: returns a real HttpRemoteAdapter once the controlPlane slot is registered',
  () => {
    const dispatcher = resolveDefaultDispatcher()
    assert(
      dispatcher,
      'must resolve a dispatcher — @zanix/app/core was imported above',
    )
  },
)

Deno.test(
  'activateApps: with no explicit dispatcher, a genuinely remote app is still reachable via ' +
    'ctx.remote() — the controlPlane provider is auto-detected',
  async () => {
    const PORT = 4730
    const targetApp = `provider-e2e-target-${crypto.randomUUID()}`
    const callerApp = `provider-e2e-caller-${crypto.randomUUID()}`

    const serviceKeys = await generateRSAKeys()
    const appKeys = await generateRSAKeys()
    Deno.env.set(`JWK_PRI_${callerApp}`, btoa(serviceKeys.privateKey))
    Deno.env.set(`JWK_PUB_${callerApp}`, btoa(serviceKeys.publicKey))
    Deno.env.set('JWK_PRI', btoa(appKeys.privateKey))
    Deno.env.set('JWK_PUB', btoa(appKeys.publicKey))

    const target = defineZanixApp({
      name: targetApp,
      routes: false,
      operations: {
        echo: (payload: unknown) => Promise.resolve({ echoed: payload }),
      },
    })
    const targetHandle = await target.serve({
      server: { rest: { port: PORT } },
    })
    await new Promise((resolve) => setTimeout(resolve, 300))

    const provider = ProgramModule.getProviders().get<
      ZanixControlPlaneProvider
    >('controlPlane')
    await provider.controlPlaneRegistry.registerInstance(
      targetApp,
      'instance-1',
      {
        prefix: `/${targetApp}`,
        endpoint: `http://localhost:${PORT}/api`,
      },
    )

    let sawResult: unknown
    const caller = defineZanixApp({
      name: callerApp,
      routes: false,
      onStart: async (ctx) => {
        sawResult = await ctx.remote(targetApp).call('echo', { text: 'hi' }, {
          timeoutMs: 3000,
        })
      },
    })

    try {
      // No 4th argument — must auto-detect the controlPlane provider registered above.
      const activated = await activateApps([caller])
      assertEquals(sawResult, { echoed: { text: 'hi' } })
      await deactivateApps(activated)
    } finally {
      await provider.controlPlaneRegistry.deregisterInstance(
        targetApp,
        'instance-1',
      )
      await targetHandle.stop()
      Deno.env.delete(`JWK_PRI_${callerApp}`)
      Deno.env.delete(`JWK_PUB_${callerApp}`)
      Deno.env.delete('JWK_PRI')
      Deno.env.delete('JWK_PUB')
    }
  },
)
