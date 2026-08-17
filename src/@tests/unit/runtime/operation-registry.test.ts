import { assert, assertEquals, assertStrictEquals } from '@std/assert'
import { normalize } from 'modules/manifest/normalize.ts'
import {
  getLocalOperation,
  isCallerAllowed,
  listMcpTools,
  registerOperations,
} from 'modules/runtime/operation-registry.ts'

Deno.test(
  'registerOperations: a registered operation resolves via getLocalOperation',
  async () => {
    const def = normalize({
      name: 'operation-registry-basic',
      operations: { echo: (payload) => Promise.resolve(payload) },
    })

    registerOperations(def, new Map())

    const found = getLocalOperation('operation-registry-basic', 'echo')
    assertEquals(await found?.handler('hello', found.ctx), 'hello')
  },
)

Deno.test('getLocalOperation: an app that never registered any operation returns undefined', () => {
  assertStrictEquals(
    getLocalOperation('operation-registry-never-registered', 'anything'),
    undefined,
  )
})

Deno.test(
  "getLocalOperation: a registered app's UNKNOWN operation name still returns undefined",
  () => {
    const def = normalize({
      name: 'operation-registry-unknown-op',
      operations: { known: () => Promise.resolve('ok') },
    })

    registerOperations(def, new Map())

    assertStrictEquals(
      getLocalOperation('operation-registry-unknown-op', 'unknown'),
      undefined,
    )
  },
)

Deno.test(
  "registerOperations: an operation's ctx.resource reflects THIS app's own resources",
  async () => {
    const def = normalize({
      name: 'operation-registry-ctx-resource',
      dependencies: { database: { type: 'fake' } },
      operations: {
        readDb: (_payload, ctx) => Promise.resolve(ctx.resource('database')),
      },
    })
    const resources = new Map([[
      'operation-registry-ctx-resource:database',
      'the-real-instance',
    ]])

    registerOperations(def, resources)

    const found = getLocalOperation(
      'operation-registry-ctx-resource',
      'readDb',
    )
    assertEquals(
      await found?.handler(undefined, found.ctx),
      'the-real-instance',
    )
  },
)

Deno.test('registerOperations: an app with no operations registers nothing', () => {
  const def = normalize({ name: 'operation-registry-empty' })

  registerOperations(def, new Map())

  assertStrictEquals(
    getLocalOperation('operation-registry-empty', 'anything'),
    undefined,
  )
})

Deno.test(
  'registerOperations: a bare-function operation registers with allowedCallers: null (public)',
  () => {
    const def = normalize({
      name: 'operation-registry-public',
      operations: { echo: (payload) => Promise.resolve(payload) },
    })

    registerOperations(def, new Map())

    assertEquals(
      getLocalOperation('operation-registry-public', 'echo')?.allowedCallers,
      null,
    )
  },
)

Deno.test(
  "registerOperations: the object form's allowedCallers is registered as declared",
  () => {
    const def = normalize({
      name: 'operation-registry-scoped',
      operations: {
        readSecret: {
          handler: () => Promise.resolve('secret'),
          allowedCallers: ['billing'],
        },
      },
    })

    registerOperations(def, new Map())

    assertEquals(
      getLocalOperation('operation-registry-scoped', 'readSecret')
        ?.allowedCallers,
      ['billing'],
    )
  },
)

// --- isCallerAllowed ---

Deno.test('isCallerAllowed: null (no ACL declared) allows any caller', () => {
  assert(isCallerAllowed(null, 'anyone'))
})

Deno.test('isCallerAllowed: an explicit "*" member allows any caller', () => {
  assert(isCallerAllowed(['*'], 'anyone'))
})

Deno.test('isCallerAllowed: a listed caller is allowed', () => {
  assert(isCallerAllowed(['billing', 'reviews'], 'billing'))
})

Deno.test('isCallerAllowed: an unlisted caller is denied', () => {
  assert(!isCallerAllowed(['billing'], 'inventory'))
})

// --- listMcpTools ---

Deno.test('listMcpTools: an operation with no mcp declared is never listed', () => {
  const def = normalize({
    name: 'mcp-tools-none',
    operations: { internalOnly: () => Promise.resolve('ok') },
  })
  registerOperations(def, new Map())

  const tool = listMcpTools().find((t) => t.appName === 'mcp-tools-none')
  assertStrictEquals(tool, undefined)
})

Deno.test(
  'listMcpTools: an operation with mcp declared is listed under "{appName}.{operationName}", ' +
    'with its description/inputSchema surfaced as-is',
  () => {
    const def = normalize({
      name: 'mcp-tools-basic',
      operations: {
        createReview: {
          handler: () => Promise.resolve('ok'),
          mcp: {
            description: 'Creates a review.',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
            },
          },
        },
      },
    })
    registerOperations(def, new Map())

    const tool = listMcpTools().find((t) => t.appName === 'mcp-tools-basic')
    assertEquals(tool, {
      appName: 'mcp-tools-basic',
      operationName: 'createReview',
      name: 'mcp-tools-basic.createReview',
      description: 'Creates a review.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    })
  },
)

Deno.test(
  'listMcpTools: mcp declared with no inputSchema defaults to an empty object schema',
  () => {
    const def = normalize({
      name: 'mcp-tools-no-schema',
      operations: {
        ping: {
          handler: () => Promise.resolve('pong'),
          mcp: { description: 'Pings.' },
        },
      },
    })
    registerOperations(def, new Map())

    const tool = listMcpTools().find((t) => t.appName === 'mcp-tools-no-schema')
    assertEquals(tool?.inputSchema, { type: 'object' })
  },
)
