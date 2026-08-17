import { assertEquals } from '@std/assert'
import { ZanixRedisConnector } from '@zanix/datamaster'
import { ControlPlaneConfig } from 'modules/runtime/control-plane/config-plane.ts'

console.info = () => {}
console.error = () => {}
console.warn = () => {}

// Real Redis connector — no mocking. A distinct key/channel space per test (random appName) keeps
// tests independent of each other and of whatever else might be running against the same Redis.
const connector = new ZanixRedisConnector()
const configPlane = new ControlPlaneConfig(connector)

function uniqueAppName(label: string): string {
  return `control-plane-test-config-${label}-${crypto.randomUUID()}`
}

function pendingUpdate(): {
  promise: Promise<{ configKey: string; value: unknown }>
  resolve: (update: { configKey: string; value: unknown }) => void
} {
  let resolve!: (update: { configKey: string; value: unknown }) => void
  const promise = new Promise<{ configKey: string; value: unknown }>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

Deno.test('ControlPlaneConfig: setConfig then getConfig reads the same value back', async () => {
  const appName = uniqueAppName('roundtrip')

  await configPlane.setConfig(appName, 'maxItems', 42)

  assertEquals(await configPlane.getConfig<number>(appName, 'maxItems'), 42)
})

Deno.test('ControlPlaneConfig: getConfig for a never-set key returns undefined', async () => {
  const appName = uniqueAppName('missing')

  assertEquals(await configPlane.getConfig(appName, 'neverSet'), undefined)
})

Deno.test(
  'ControlPlaneConfig: subscribeConfig receives a hot update published after subscribing',
  async () => {
    const appName = uniqueAppName('hot-refresh')
    const update = pendingUpdate()

    const subscription = await configPlane.subscribeConfig(
      appName,
      ['maxItems'],
      (configKey, value) => update.resolve({ configKey, value }),
    )

    await configPlane.setConfig(appName, 'maxItems', 7)

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('timed out waiting for a Pub/Sub update')),
        3000,
      )
    )
    const received = await Promise.race([update.promise, timeout])

    assertEquals(received, { configKey: 'maxItems', value: 7 })

    await subscription.close()
  },
)

Deno.test(
  'ControlPlaneConfig: subscribeConfig never fires for a config key it never subscribed to',
  async () => {
    const appName = uniqueAppName('scoped')
    let calls = 0

    const subscription = await configPlane.subscribeConfig(
      appName,
      ['watched'],
      () => {
        calls++
      },
    )

    await configPlane.setConfig(appName, 'unwatched', 'value')
    // Gives Pub/Sub a moment to deliver, in case it incorrectly would.
    await wait(300)

    assertEquals(calls, 0)

    await subscription.close()
  },
)

// Keep this at the end to ensure the Redis connection (socket) closes properly.
Deno.test('close the shared Redis connection', () => {
  connector['close']()
})
