import { assert, assertEquals, assertRejects, assertStrictEquals } from '@std/assert'
import { getTemporaryFolder } from '@zanix/helpers'
import { ZanixRedisConnector } from '@zanix/datamaster'
import { normalize } from 'modules/manifest/normalize.ts'
import { ControlPlaneConfig } from 'modules/runtime/control-plane/config-plane.ts'
import { ControlPlaneRegistry } from 'modules/runtime/control-plane/registry.ts'
import { announceRemoteInstance } from 'modules/runtime/remote-lifecycle.ts'
import { getConfigOverride, hasConfigOverride } from 'modules/runtime/config-overrides.ts'
import { generateMtlsTestCertChain } from './mtls-test-certs.ts'

console.info = () => {}
console.error = () => {}
console.warn = () => {}

// Real Redis connector — no mocking, same pattern as the rest of this suite's integration tests.
const connector = new ZanixRedisConnector()
const registry = new ControlPlaneRegistry(connector)
const configPlane = new ControlPlaneConfig(connector)

const mtlsCertsDir = getTemporaryFolder(import.meta.url) +
  '/remote-lifecycle-mtls-certs'
const mtlsCerts = await generateMtlsTestCertChain(mtlsCertsDir)

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

Deno.test('announceRemoteInstance: registers immediately, target appears right away', async () => {
  const def = normalize({
    name: `remote-lifecycle-basic-${crypto.randomUUID()}`,
  })

  const announced = await announceRemoteInstance(
    def,
    { endpoint: 'http://localhost:9001' },
    registry,
  )

  assertEquals(await registry.getDeploymentTarget(def.name), {
    mode: 'remote',
    prefix: def.name, // `routesPrefix`'s own convention: the auto-prefix IS the bare name, no `/`
    endpoints: ['http://localhost:9001'],
  })

  await announced.stop()
})

Deno.test(
  'announceRemoteInstance: a def with routes: false (routesPrefix === null) falls back to the ' +
    "app's own bare name as the registered prefix, same as the auto-default convention",
  async () => {
    const def = normalize({
      name: `remote-lifecycle-no-routes-${crypto.randomUUID()}`,
      routes: false,
    })

    const announced = await announceRemoteInstance(
      def,
      { endpoint: 'http://localhost:9002' },
      registry,
    )

    assertEquals(await registry.getDeploymentTarget(def.name), {
      mode: 'remote',
      prefix: def.name,
      endpoints: ['http://localhost:9002'],
    })

    await announced.stop()
  },
)

Deno.test(
  'announceRemoteInstance: the heartbeat renews the lease past its original TTL',
  async () => {
    const def = normalize({
      name: `remote-lifecycle-heartbeat-${crypto.randomUUID()}`,
    })

    const announced = await announceRemoteInstance(
      def,
      {
        endpoint: 'http://localhost:9003',
        leaseTtlSeconds: 1,
        heartbeatIntervalMs: 300,
      },
      registry,
    )

    await wait(1300) // past the original 1s lease — only a real renewal keeps it alive

    assert(
      await registry.getDeploymentTarget(def.name),
      'the heartbeat must have renewed the lease past its original TTL',
    )

    await announced.stop()
  },
)

Deno.test(
  'announceRemoteInstance: stop() deregisters — the instance disappears immediately',
  async () => {
    const def = normalize({
      name: `remote-lifecycle-stop-${crypto.randomUUID()}`,
      runtime: { mode: 'remote' },
    })

    const announced = await announceRemoteInstance(
      def,
      {
        endpoint: 'http://localhost:9004',
        leaseTtlSeconds: 30,
        heartbeatIntervalMs: 10_000,
      },
      registry,
    )
    assert(await registry.getDeploymentTarget(def.name))

    await announced.stop()

    assertStrictEquals(await registry.getDeploymentTarget(def.name), undefined)
  },
)

Deno.test(
  'announceRemoteInstance: subscribes only to non-secret config keys, and a push updates the override',
  async () => {
    const appName = `remote-lifecycle-config-${crypto.randomUUID()}`
    const def = normalize({
      name: appName,
      config: {
        pageSize: { type: 'number', default: 10 },
        apiKey: { type: 'string', secret: true },
      },
    })

    const announced = await announceRemoteInstance(
      def,
      { endpoint: 'http://localhost:9005' },
      registry,
      configPlane,
    )

    try {
      await configPlane.setConfig(appName, 'pageSize', 42)
      await wait(300)
      assertEquals(getConfigOverride(appName, 'pageSize'), 42)

      // A secret key was never subscribed — a push to it must never create an override.
      await configPlane.setConfig(appName, 'apiKey', 'super-secret')
      await wait(300)
      assertStrictEquals(hasConfigOverride(appName, 'apiKey'), false)
    } finally {
      await announced.stop()
    }
  },
)

Deno.test(
  'announceRemoteInstance: an app with no non-secret config never subscribes (no configPlane call needed)',
  async () => {
    const def = normalize({
      name: `remote-lifecycle-no-config-${crypto.randomUUID()}`,
    })

    // Passing a real configPlane must not throw even though there's nothing to subscribe to.
    const announced = await announceRemoteInstance(
      def,
      { endpoint: 'http://localhost:9006' },
      registry,
      configPlane,
    )

    await announced.stop()
  },
)

Deno.test(
  'announceRemoteInstance: options.mtls starts a real mTLS listener; stop() closes it',
  async () => {
    const def = normalize({
      name: `remote-lifecycle-mtls-${crypto.randomUUID()}`,
    })
    const port = 8654

    const announced = await announceRemoteInstance(
      def,
      {
        endpoint: 'http://localhost:9007',
        mtls: {
          port,
          cert: mtlsCerts.serverCert,
          key: mtlsCerts.serverKey,
          ca: [mtlsCerts.ca],
        },
      },
      registry,
    )

    const client = Deno.createHttpClient({
      cert: mtlsCerts.clientCert,
      key: mtlsCerts.clientKey,
      caCerts: [mtlsCerts.ca],
    })

    try {
      // No bearer token — a 403 (rather than a connection failure) is proof the mTLS handshake
      // itself succeeded and a real HTTP request was actually handled.
      const response = await fetch(
        `https://localhost:${port}/__zanix-ops/${def.name}/echo`,
        {
          method: 'POST',
          client,
          body: '{}',
          headers: { 'content-type': 'application/json' },
        },
      )
      assertEquals(response.status, 403)
      await response.body?.cancel()

      await announced.stop()

      await assertRejects(() =>
        fetch(`https://localhost:${port}/__zanix-ops/${def.name}/echo`, {
          method: 'POST',
          client,
          body: '{}',
          headers: { 'content-type': 'application/json' },
        })
      )
    } finally {
      client.close()
    }
  },
)

// Keep this at the end to ensure the Redis connection (socket) closes properly.
Deno.test('close the shared Redis connection', () => {
  connector['close']()
})
