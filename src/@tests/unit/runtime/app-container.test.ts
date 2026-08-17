import { assert, assertEquals, assertRejects } from '@std/assert'
import { InternalError } from '@zanix/errors'
import { Interactor, Provider, ZanixInteractor, ZanixProvider } from '@zanix/server'
import { normalize } from 'modules/manifest/normalize.ts'
import { registerApp } from 'modules/runtime/app-container.ts'
import { getNamespacedJobOrigin } from 'modules/runtime/register-jobs.ts'

console.error = () => {}

Deno.test('registerApp: an app with no setup is simply skipped, no error', async () => {
  const def = normalize({ name: 'app-no-setup-test' })
  await registerApp(def, new Map()) // must not throw
})

Deno.test(
  "registerApp: setup(ctx) receives THIS app's own resolved resources via ctx.resource(slot)",
  async () => {
    let sawResource: unknown
    const def = normalize({
      name: 'app-setup-resource-test',
      dependencies: { database: { type: 'fake' } },
      setup: (ctx) => {
        sawResource = ctx.resource('database')
      },
    })
    const resources = new Map([[
      'app-setup-resource-test:database',
      'the-real-instance',
    ]])

    await registerApp(def, resources)

    assertEquals(sawResource, 'the-real-instance')
  },
)

Deno.test(
  'registerApp: setup(ctx) receives ctx.config reflecting the manifest default',
  async () => {
    let sawApiKey: unknown
    let hasApiKey: unknown
    const def = normalize({
      name: 'app-setup-config-test',
      config: { apiKey: { type: 'string', default: 'abc123' } },
      setup: (ctx) => {
        sawApiKey = ctx.config.get('apiKey')
        hasApiKey = ctx.config.has('apiKey')
      },
    })

    await registerApp(def, new Map())

    assertEquals(sawApiKey, 'abc123')
    assertEquals(hasApiKey, true)
  },
)

Deno.test(
  'registerApp: ctx.routes(register) runs `register` synchronously, exactly once, before ' +
    'registerApp resolves',
  async () => {
    let registerCalls = 0
    const def = normalize({
      name: 'app-setup-routes-test',
      setup: (ctx) => {
        ctx.routes(() => {
          registerCalls++
        })
      },
    })

    await registerApp(def, new Map())

    assertEquals(registerCalls, 1)
  },
)

Deno.test('registerApp: ctx.resolve() resolves a real @Interactor-decorated class', async () => {
  @Interactor()
  class AppContainerTestInteractor extends ZanixInteractor {}

  let resolved: unknown
  const def = normalize({
    name: 'app-setup-resolve-interactor-test',
    setup: (ctx) => {
      resolved = ctx.resolve(AppContainerTestInteractor)
    },
  })

  await registerApp(def, new Map())

  assert(resolved instanceof AppContainerTestInteractor)
})

Deno.test('registerApp: ctx.resolve() resolves a real @Provider-decorated class', async () => {
  @Provider()
  class AppContainerTestProvider extends ZanixProvider {}

  let resolved: unknown
  const def = normalize({
    name: 'app-setup-resolve-provider-test',
    setup: (ctx) => {
      resolved = ctx.resolve(AppContainerTestProvider)
    },
  })

  await registerApp(def, new Map())

  assert(resolved instanceof AppContainerTestProvider)
})

Deno.test(
  'registerApp: ctx.resolve() throws for a class decorated with none of @Interactor/@Provider/@Connector',
  async () => {
    class PlainUndecoratedClass {}

    const def = normalize({
      name: 'app-setup-resolve-unresolvable-test',
      setup: (ctx) => {
        ctx.resolve(PlainUndecoratedClass)
      },
    })

    await assertRejects(() => registerApp(def, new Map()), InternalError)
  },
)

Deno.test(
  "registerApp: still namespaces this app's jobs (regression — setup(ctx) wiring must not break it)",
  async () => {
    const def = normalize({
      name: 'app-container-jobs-regression-test',
      jobs: { syncProducts: { processingQueue: 'soft', handler: () => {} } },
    })

    await registerApp(def, new Map())

    assertEquals(
      getNamespacedJobOrigin('app-container-jobs-regression-test:syncProducts'),
      {
        appName: 'app-container-jobs-regression-test',
        originalName: 'syncProducts',
      },
    )
  },
)

Deno.test(
  'registerApp: still registers a mount prefix without throwing (regression — setup(ctx) wiring must not break it)',
  async () => {
    const def = normalize({
      name: 'app-container-mount-regression-test',
      routes: true,
    })

    await registerApp(def, new Map()) // must not throw
  },
)

Deno.test(
  'registerApp: a setup(ctx) that throws propagates the error, never silently swallowed',
  async () => {
    const def = normalize({
      name: 'app-setup-throws-test',
      setup: () => {
        throw new Error('boom')
      },
    })

    await assertRejects(() => registerApp(def, new Map()), Error, 'boom')
  },
)
