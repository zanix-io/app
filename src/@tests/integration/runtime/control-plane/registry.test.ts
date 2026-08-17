import { assert, assertEquals } from '@std/assert'
import { ZanixRedisConnector } from '@zanix/datamaster'
import { ControlPlaneRegistry } from 'modules/runtime/control-plane/registry.ts'

console.info = () => {}
console.error = () => {}
console.warn = () => {}

// Real Redis connector — no mocking. A distinct key space per test (random appName) keeps tests
// independent of each other and of whatever else might be running against the same Redis.
const connector = new ZanixRedisConnector()
const registry = new ControlPlaneRegistry(connector)

function uniqueAppName(label: string): string {
  return `control-plane-test-registry-${label}-${crypto.randomUUID()}`
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

Deno.test('ControlPlaneRegistry: registers one instance and discovers it', async () => {
  const appName = uniqueAppName('single')

  await registry.registerInstance(appName, 'instance-a', {
    prefix: '/reviews',
    endpoint: 'http://reviews-a:8080',
  })

  assertEquals(await registry.getDeploymentTarget(appName), {
    mode: 'remote',
    prefix: '/reviews',
    endpoints: ['http://reviews-a:8080'],
  })

  await registry.deregisterInstance(appName, 'instance-a')
})

Deno.test('ControlPlaneRegistry: multiple replicas aggregate into one target', async () => {
  const appName = uniqueAppName('multi')

  await registry.registerInstance(appName, 'instance-a', {
    prefix: '/billing',
    endpoint: 'http://billing-a:8080',
  })
  await registry.registerInstance(appName, 'instance-b', {
    prefix: '/billing',
    endpoint: 'http://billing-b:8080',
  })

  const target = await registry.getDeploymentTarget(appName)
  assert(target?.mode === 'remote')
  assertEquals(target.prefix, '/billing')
  assertEquals(
    new Set(target.endpoints),
    new Set(['http://billing-a:8080', 'http://billing-b:8080']),
  )

  await registry.deregisterInstance(appName, 'instance-a')
  const afterOneLeaves = await registry.getDeploymentTarget(appName)
  assertEquals(afterOneLeaves?.endpoints, ['http://billing-b:8080'])

  await registry.deregisterInstance(appName, 'instance-b')
  assertEquals(await registry.getDeploymentTarget(appName), undefined)
})

Deno.test(
  'ControlPlaneRegistry: an instance that never renews falls out once its lease expires',
  async () => {
    const appName = uniqueAppName('ttl')

    await registry.registerInstance(
      appName,
      'instance-a',
      { prefix: '/x', endpoint: 'http://x-a' },
      { leaseTtlSeconds: 1 },
    )
    assert(await registry.getDeploymentTarget(appName))

    await wait(1300)

    assertEquals(await registry.getDeploymentTarget(appName), undefined)
  },
)

Deno.test('ControlPlaneRegistry: calling registerInstance again renews the lease', async () => {
  const appName = uniqueAppName('renew')

  await registry.registerInstance(
    appName,
    'instance-a',
    { prefix: '/x', endpoint: 'http://x-a' },
    { leaseTtlSeconds: 1 },
  )
  await wait(700)
  await registry.registerInstance(
    appName,
    'instance-a',
    { prefix: '/x', endpoint: 'http://x-a' },
    { leaseTtlSeconds: 1 },
  )
  await wait(700)

  assert(
    await registry.getDeploymentTarget(appName),
    'renewed instance should still be discoverable past the original lease window',
  )

  await registry.deregisterInstance(appName, 'instance-a')
})

Deno.test('ControlPlaneRegistry: an app that never registered returns undefined', async () => {
  assertEquals(
    await registry.getDeploymentTarget(uniqueAppName('never-registered')),
    undefined,
  )
})

// Keep this at the end to ensure the Redis connection (socket) closes properly.
Deno.test('close the shared Redis connection', () => {
  connector['close']()
})
