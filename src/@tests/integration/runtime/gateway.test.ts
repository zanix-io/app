import { assert, assertEquals, assertStrictEquals } from '@std/assert'
import { ZanixRedisConnector } from '@zanix/datamaster'
import { ControlPlaneRegistry } from 'modules/runtime/control-plane/mod.ts'
import { createGatewayPreHandler } from 'modules/runtime/gateway.ts'

console.info = () => {}
console.error = () => {}
console.warn = () => {}

// Real Redis connector — no mocking, same pattern as the rest of this suite's integration tests.
const connector = new ZanixRedisConnector()
const registry = new ControlPlaneRegistry(connector)

/**
 * Brings up a real, bare `Deno.serve()` target on `port` — deliberately NOT a full Zanix App:
 * what's under test here is the Gateway's OWN forwarding logic (path/method/headers/body,
 * resolution order, local-shadowing, the default-app fallback), not `@zanix/server`'s own
 * global-prefix composition (`resolveGlobalPrefix`'s own suite already covers that separately).
 * Echoes back method + path + body so a test can assert exactly what actually reached "the remote
 * instance", not just that SOMETHING did.
 */
async function withServedTarget(
  port: number,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = Deno.serve(
    { port, hostname: '127.0.0.1', onListen: () => {} },
    async (request) => {
      const url = new URL(request.url)
      const body = request.body ? await request.text() : null
      return Response.json({
        method: request.method,
        path: url.pathname,
        body,
      })
    },
  )

  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await server.shutdown()
  }
}

Deno.test(
  'createGatewayPreHandler: proxies a request whose first path segment matches a registered remote app',
  async () => {
    const appName = `gateway-target-${crypto.randomUUID()}`

    await withServedTarget(4740, async (baseUrl) => {
      await registry.registerInstance(appName, 'instance-1', {
        prefix: appName,
        endpoint: baseUrl,
      })

      try {
        const preHandler = createGatewayPreHandler(registry)
        const request = new Request(
          `http://gateway.internal/${appName}/some/page?x=1`,
        )
        const response = await preHandler(request, {} as never)

        assert(response instanceof Response)
        assertEquals(response.status, 200)
        assertEquals(await response.json(), {
          method: 'GET',
          path: `/${appName}/some/page`,
          body: null,
        })
      } finally {
        await registry.deregisterInstance(appName, 'instance-1')
      }
    })
  },
)

Deno.test(
  'createGatewayPreHandler: forwards method and body faithfully (a real reverse proxy, not a redirect)',
  async () => {
    const appName = `gateway-target-${crypto.randomUUID()}`

    await withServedTarget(4744, async (baseUrl) => {
      await registry.registerInstance(appName, 'instance-1', {
        prefix: appName,
        endpoint: baseUrl,
      })

      try {
        const preHandler = createGatewayPreHandler(registry)
        const request = new Request(
          `http://gateway.internal/${appName}/submit`,
          {
            method: 'POST',
            body: JSON.stringify({ hi: 1 }),
            headers: { 'content-type': 'application/json' },
          },
        )
        const response = await preHandler(request, {} as never)

        assert(response instanceof Response)
        assertEquals(await response.json(), {
          method: 'POST',
          path: `/${appName}/submit`,
          body: JSON.stringify({ hi: 1 }),
        })
      } finally {
        await registry.deregisterInstance(appName, 'instance-1')
      }
    })
  },
)

Deno.test(
  'createGatewayPreHandler: never proxies a name in localAppNames, even if registered remotely',
  async () => {
    const appName = `gateway-local-${crypto.randomUUID()}`

    // A decoy registration — if the Gateway ever consulted the Control Plane for this name, it
    // would find a (fake, unreachable) target. It must never even try.
    await registry.registerInstance(appName, 'instance-1', {
      prefix: appName,
      endpoint: 'http://localhost:1', // deliberately unreachable — must never be dialed
    })

    try {
      const preHandler = createGatewayPreHandler(registry, {
        localAppNames: [appName],
      })
      const request = new Request(
        `http://gateway.internal/${appName}/anything`,
      )
      const response = await preHandler(request, {} as never)

      assertStrictEquals(response, undefined)
    } finally {
      await registry.deregisterInstance(appName, 'instance-1')
    }
  },
)

Deno.test(
  'createGatewayPreHandler: falls through (undefined) for a name never registered anywhere',
  async () => {
    const preHandler = createGatewayPreHandler(registry)
    const request = new Request(
      `http://gateway.internal/gateway-never-registered-${crypto.randomUUID()}/anything`,
    )
    const response = await preHandler(request, {} as never)

    assertStrictEquals(response, undefined)
  },
)

Deno.test(
  'createGatewayPreHandler: falls through (undefined) for the root path when there is no defaultRemoteApp',
  async () => {
    const preHandler = createGatewayPreHandler(registry)
    const response = await preHandler(
      new Request('http://gateway.internal/'),
      {} as never,
    )

    assertStrictEquals(response, undefined)
  },
)

Deno.test(
  'createGatewayPreHandler: responds 502 when a registered remote target is unreachable',
  async () => {
    const appName = `gateway-unreachable-${crypto.randomUUID()}`

    await registry.registerInstance(appName, 'instance-1', {
      prefix: appName,
      endpoint: 'http://localhost:1', // reserved/unroutable port — connection always fails
    })

    try {
      const preHandler = createGatewayPreHandler(registry)
      const request = new Request(
        `http://gateway.internal/${appName}/anything`,
      )
      const response = await preHandler(request, {} as never)

      assert(response instanceof Response)
      assertEquals(response.status, 502)
    } finally {
      await registry.deregisterInstance(appName, 'instance-1')
    }
  },
)

Deno.test(
  'createGatewayPreHandler: defaultRemoteApp catches a whole-domain path with no app-identifying segment',
  async () => {
    const appName = `gateway-default-${crypto.randomUUID()}`

    await withServedTarget(4745, async (baseUrl) => {
      await registry.registerInstance(appName, 'instance-1', {
        prefix: '',
        endpoint: baseUrl,
      })

      try {
        const preHandler = createGatewayPreHandler(registry, {
          defaultRemoteApp: appName,
        })
        const request = new Request('http://gateway.internal/products/1')
        const response = await preHandler(request, {} as never)

        assert(response instanceof Response)
        assertEquals(response.status, 200)
        assertEquals(await response.json(), {
          method: 'GET',
          path: '/products/1',
          body: null,
        })
      } finally {
        await registry.deregisterInstance(appName, 'instance-1')
      }
    })
  },
)

Deno.test(
  'createGatewayPreHandler: defaultRemoteApp is never consulted when it is also in localAppNames',
  async () => {
    const appName = `gateway-default-local-${crypto.randomUUID()}`

    // A decoy registration — if the Gateway ever proxied to the default app despite it being
    // local, it would find this (fake, unreachable) target.
    await registry.registerInstance(appName, 'instance-1', {
      prefix: '',
      endpoint: 'http://localhost:1',
    })

    try {
      const preHandler = createGatewayPreHandler(registry, {
        defaultRemoteApp: appName,
        localAppNames: [appName],
      })
      const response = await preHandler(
        new Request('http://gateway.internal/products/1'),
        {} as never,
      )

      assertStrictEquals(response, undefined)
    } finally {
      await registry.deregisterInstance(appName, 'instance-1')
    }
  },
)

Deno.test(
  'createGatewayPreHandler: a named match wins over defaultRemoteApp when both are configured',
  async () => {
    const namedApp = `gateway-named-${crypto.randomUUID()}`
    const defaultApp = `gateway-fallback-${crypto.randomUUID()}`

    await withServedTarget(4746, async (namedBaseUrl) => {
      await registry.registerInstance(namedApp, 'instance-1', {
        prefix: namedApp,
        endpoint: namedBaseUrl,
      })
      // The default app is registered too, but deliberately unreachable — it must never be tried
      // when the named app already resolved the request.
      await registry.registerInstance(defaultApp, 'instance-1', {
        prefix: '',
        endpoint: 'http://localhost:1',
      })

      try {
        const preHandler = createGatewayPreHandler(registry, {
          defaultRemoteApp: defaultApp,
        })
        const request = new Request(`http://gateway.internal/${namedApp}/page`)
        const response = await preHandler(request, {} as never)

        assert(response instanceof Response)
        assertEquals(response.status, 200)
      } finally {
        await registry.deregisterInstance(namedApp, 'instance-1')
        await registry.deregisterInstance(defaultApp, 'instance-1')
      }
    })
  },
)

// Keep this at the end to ensure the Redis connection (socket) closes properly.
Deno.test('close the shared Redis connection', () => {
  connector['close']()
})
