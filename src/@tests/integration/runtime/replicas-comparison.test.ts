import { assertEquals } from '@std/assert'
import { ZanixRedisConnector } from '@zanix/datamaster'
import { normalize } from 'modules/manifest/normalize.ts'
import { ControlPlaneRegistry } from 'modules/runtime/control-plane/registry.ts'
import { compareReplicas } from 'modules/runtime/replicas-comparison.ts'

console.info = () => {}
console.error = () => {}
console.warn = () => {}

// Real Redis connector — no mocking, same pattern as the rest of this suite's integration tests.
const connector = new ZanixRedisConnector()
const registry = new ControlPlaneRegistry(connector)

Deno.test(
  'compareReplicas: matches=true when the manifest never declared runtime.replicas, regardless of what is observed',
  async () => {
    const def = normalize({
      name: `replicas-test-undeclared-${crypto.randomUUID()}`,
    })

    const result = await compareReplicas(def, registry)

    assertEquals(result, { declared: null, observed: 0, matches: true })
  },
)

Deno.test(
  'compareReplicas: observed=0 and matches=false when nothing is registered but replicas was declared',
  async () => {
    const def = normalize({
      name: `replicas-test-none-registered-${crypto.randomUUID()}`,
      runtime: { replicas: 3 },
    })

    const result = await compareReplicas(def, registry)

    assertEquals(result, { declared: 3, observed: 0, matches: false })
  },
)

Deno.test(
  'compareReplicas: matches=true when the observed live instance count equals runtime.replicas',
  async () => {
    const appName = `replicas-test-matching-${crypto.randomUUID()}`
    const def = normalize({ name: appName, runtime: { replicas: 2 } })

    await registry.registerInstance(appName, 'instance-1', {
      prefix: appName,
      endpoint: 'http://localhost:9101',
    })
    await registry.registerInstance(appName, 'instance-2', {
      prefix: appName,
      endpoint: 'http://localhost:9102',
    })

    const result = await compareReplicas(def, registry)

    assertEquals(result, { declared: 2, observed: 2, matches: true })

    await registry.deregisterInstance(appName, 'instance-1')
    await registry.deregisterInstance(appName, 'instance-2')
  },
)

Deno.test(
  'compareReplicas: matches=false when fewer instances are observed than declared',
  async () => {
    const appName = `replicas-test-under-${crypto.randomUUID()}`
    const def = normalize({ name: appName, runtime: { replicas: 3 } })

    await registry.registerInstance(appName, 'instance-1', {
      prefix: appName,
      endpoint: 'http://localhost:9103',
    })

    const result = await compareReplicas(def, registry)

    assertEquals(result, { declared: 3, observed: 1, matches: false })

    await registry.deregisterInstance(appName, 'instance-1')
  },
)

// Keep this at the end to ensure the Redis connection (socket) closes properly.
Deno.test('close the shared Redis connection', () => {
  connector['close']()
})
