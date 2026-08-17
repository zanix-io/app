import { assert, assertEquals, assertThrows } from '@std/assert'
import { InternalError } from '@zanix/errors'
import { defineZanixApp, isZanixAppDefinition } from 'modules/manifest/mod.ts'

console.error = () => {}

Deno.test('defineZanixApp: minimal manifest (only `name`) is valid', () => {
  const app = defineZanixApp({ name: 'reviews' })

  assertEquals(app.definition.name, 'reviews')
  assertEquals(
    app.definition.routesPrefix,
    'reviews',
    'routes defaults to auto-prefix with name',
  )
  assertEquals(app.definition.dependencies, {})
  assertEquals(app.definition.rootDir, '.')
  assertEquals(
    app.definition.operations,
    {},
    'operations defaults to an empty map',
  )
  assertEquals(
    app.definition.runtime,
    { mode: 'embedded', replicas: null },
    'runtime defaults to embedded — the original, always-supported behavior',
  )
})

Deno.test('defineZanixApp: declared runtime.mode/replicas pass through, normalized', () => {
  const app = defineZanixApp({
    name: 'reviews',
    runtime: { mode: 'remote', replicas: 3 },
  })

  assertEquals(app.definition.runtime, { mode: 'remote', replicas: 3 })
})

Deno.test('defineZanixApp: runtime.replicas alone still defaults mode to embedded', () => {
  const app = defineZanixApp({ name: 'reviews', runtime: { replicas: 2 } })

  assertEquals(app.definition.runtime, { mode: 'embedded', replicas: 2 })
})

Deno.test(
  'defineZanixApp: a bare-function operation normalizes to {handler, allowedCallers: null} ' +
    '(public — no ACL declared)',
  () => {
    const createReview = (payload: unknown) => Promise.resolve(payload)
    const app = defineZanixApp({
      name: 'reviews',
      operations: { createReview },
    })

    assertEquals(app.definition.operations, {
      createReview: {
        handler: createReview,
        sandbox: null,
        allowedCallers: null,
        mcp: null,
      },
    })
  },
)

Deno.test(
  "defineZanixApp: the object form's allowedCallers passes through unchanged",
  () => {
    const createReview = (payload: unknown) => Promise.resolve(payload)
    const app = defineZanixApp({
      name: 'reviews',
      operations: {
        createReview: { handler: createReview, allowedCallers: ['billing'] },
      },
    })

    assertEquals(app.definition.operations, {
      createReview: {
        handler: createReview,
        sandbox: null,
        allowedCallers: ['billing'],
        mcp: null,
      },
    })
  },
)

Deno.test(
  'defineZanixApp: the object form with no allowedCallers normalizes to null (public), same as ' +
    'the bare-function shorthand',
  () => {
    const createReview = (payload: unknown) => Promise.resolve(payload)
    const app = defineZanixApp({
      name: 'reviews',
      operations: { createReview: { handler: createReview } },
    })

    assertEquals(app.definition.operations, {
      createReview: {
        handler: createReview,
        sandbox: null,
        allowedCallers: null,
        mcp: null,
      },
    })
  },
)

Deno.test(
  "defineZanixApp: the object form's mcp declaration passes through unchanged",
  () => {
    const createReview = (payload: unknown) => Promise.resolve(payload)
    const mcp = {
      description: 'Creates a review.',
      inputSchema: { type: 'object' },
    }
    const app = defineZanixApp({
      name: 'reviews',
      operations: { createReview: { handler: createReview, mcp } },
    })

    assertEquals(app.definition.operations, {
      createReview: {
        handler: createReview,
        sandbox: null,
        allowedCallers: null,
        mcp,
      },
    })
  },
)

Deno.test(
  'defineZanixApp: the sandbox declaration form normalizes with handler: null, sandbox passed ' +
    'through unchanged',
  () => {
    const sandbox = {
      metaUrl: 'file:///tasks.ts',
      taskName: 'processReview',
      timeout: 5000,
    }
    const app = defineZanixApp({
      name: 'reviews',
      operations: { createReview: { sandbox, allowedCallers: ['billing'] } },
    })

    assertEquals(app.definition.operations, {
      createReview: {
        handler: null,
        sandbox,
        allowedCallers: ['billing'],
        mcp: null,
      },
    })
  },
)

Deno.test(
  'isZanixAppDefinition: true for defineZanixApp() output, false for a plain object',
  () => {
    const app = defineZanixApp({ name: 'reviews' })

    assert(isZanixAppDefinition(app))
    assert(
      !isZanixAppDefinition({ rootDir: '.', server: {} }),
      'a legacy AppBootstrapOptions-shaped object must never be misclassified',
    )
    assert(!isZanixAppDefinition(null))
    assert(!isZanixAppDefinition('reviews'))
  },
)

for (const validName of ['reviews', 'billing-v2', 'inventory']) {
  Deno.test(`defineZanixApp: accepts a valid name "${validName}"`, () => {
    const app = defineZanixApp({ name: validName })
    assertEquals(app.definition.name, validName)
  })
}

for (const invalidName of ['reviews/api', '../admin', 'Reviews']) {
  Deno.test(`defineZanixApp: rejects an invalid name "${invalidName}"`, () => {
    assertThrows(() => defineZanixApp({ name: invalidName }), InternalError)
  })
}

Deno.test(
  'defineZanixApp: routes: false means no route namespace at all (routesPrefix is null)',
  () => {
    const app = defineZanixApp({ name: 'reviews', routes: false })
    assertEquals(app.definition.routesPrefix, null)
  },
)

Deno.test(
  'defineZanixApp: routes: { prefix: "" } is an explicit opt-out, distinct from routes: false',
  () => {
    const app = defineZanixApp({ name: 'reviews', routes: { prefix: '' } })
    assertEquals(app.definition.routesPrefix, '')
  },
)

Deno.test(
  'defineZanixApp: a "secret: true" config entry with a literal "default" is rejected — secrets ' +
    'must come from a host override or env var, never hardcoded',
  () => {
    assertThrows(
      () =>
        defineZanixApp({
          name: 'reviews',
          config: {
            apiKey: { type: 'string', secret: true, default: 'hardcoded' },
          },
        }),
      InternalError,
    )
  },
)

Deno.test('defineZanixApp: a "secret: true" config entry WITHOUT a default is valid', () => {
  const app = defineZanixApp({
    name: 'reviews',
    config: { apiKey: { type: 'string', secret: true, required: true } },
  })
  assertEquals(app.definition.config.apiKey.secret, true)
  assertEquals(app.definition.config.apiKey.default, null)
})

Deno.test('defineZanixApp: behaviors defaults to an empty map when never declared', () => {
  const app = defineZanixApp({ name: 'reviews' })
  assertEquals(app.definition.behaviors, {})
})

Deno.test(
  'defineZanixApp: a declared behavior passes through unchanged, no normalization work',
  () => {
    const calculateDiscount = (order: { total: number }) => order.total * 0
    const app = defineZanixApp({
      name: 'billing',
      behaviors: {
        calculateDiscount: {
          default: calculateDiscount,
          description: 'No discount by default.',
        },
      },
    })

    assertEquals(app.definition.behaviors, {
      calculateDiscount: {
        default: calculateDiscount,
        description: 'No discount by default.',
      },
    })
  },
)

Deno.test(
  'defineZanixApp: a behavior with no description is valid — description stays undefined',
  () => {
    const formatInvoiceNumber = (id: number) => `INV-${id}`
    const app = defineZanixApp({
      name: 'billing',
      behaviors: { formatInvoiceNumber: { default: formatInvoiceNumber } },
    })

    assertEquals(
      app.definition.behaviors.formatInvoiceNumber.default,
      formatInvoiceNumber,
    )
    assertEquals(
      app.definition.behaviors.formatInvoiceNumber.description,
      undefined,
    )
  },
)
