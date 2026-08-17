import { assert, assertEquals, assertRejects } from '@std/assert'
import { InternalError } from '@zanix/errors'
import { normalize } from 'modules/manifest/normalize.ts'
import { getLocalOperation, registerOperations } from 'modules/runtime/operation-registry.ts'
import { closeSandboxedWorkers } from 'modules/runtime/sandbox-operation.ts'

const TASKS_URL = new URL('./sandbox-tasks.ts', import.meta.url).href

console.error = () => {}

Deno.test(
  'sandbox operation: dispatches end-to-end through a real Worker and returns its result',
  async () => {
    const appName = `sandbox-echo-${crypto.randomUUID()}`
    const def = normalize({
      name: appName,
      operations: {
        echo: { sandbox: { metaUrl: TASKS_URL, taskName: 'echoTask' } },
      },
    })
    registerOperations(def, new Map())

    try {
      const found = getLocalOperation(appName, 'echo')
      const result = await found?.handler({ hello: 'world' }, found.ctx)
      assertEquals(result, { hello: 'world' })
    } finally {
      closeSandboxedWorkers(appName)
    }
  },
)

Deno.test(
  'sandbox operation: a denied permission surfaces as SANDBOX_TASK_FAILED, not a silent success',
  async () => {
    const appName = `sandbox-permission-denied-${crypto.randomUUID()}`
    Deno.env.set('SANDBOX_OPERATION_TEST_SECRET', 'visible-to-the-host-only')

    const def = normalize({
      name: appName,
      operations: {
        readSecret: {
          sandbox: {
            metaUrl: TASKS_URL,
            taskName: 'readSecretTask',
            // `read` stays open so the worker can still import its own task module — only `env`
            // is denied, isolating the permission actually under test (see workers.md's own
            // caveat: an object `permissions` value replaces the whole set, not just what's
            // listed).
            permissions: { env: false, read: true },
          },
        },
      },
    })
    registerOperations(def, new Map())

    try {
      const found = getLocalOperation(appName, 'readSecret')
      assert(found)
      const error = await assertRejects(
        () => found.handler(undefined, found.ctx),
        InternalError,
      )
      assertEquals((error as InternalError).code, 'SANDBOX_TASK_FAILED')
    } finally {
      closeSandboxedWorkers(appName)
      Deno.env.delete('SANDBOX_OPERATION_TEST_SECRET')
    }
  },
)

Deno.test(
  'sandbox operation: a runaway task times out as SANDBOX_TASK_FAILED instead of hanging',
  async () => {
    const appName = `sandbox-timeout-${crypto.randomUUID()}`
    const def = normalize({
      name: appName,
      operations: {
        runaway: {
          sandbox: {
            metaUrl: TASKS_URL,
            taskName: 'runawayTask',
            timeout: 300,
          },
        },
      },
    })
    registerOperations(def, new Map())

    try {
      const found = getLocalOperation(appName, 'runaway')
      assert(found)
      const error = await assertRejects(
        () => found.handler(undefined, found.ctx),
        InternalError,
      )
      assertEquals((error as InternalError).code, 'SANDBOX_TASK_FAILED')
    } finally {
      closeSandboxedWorkers(appName)
    }
  },
)
