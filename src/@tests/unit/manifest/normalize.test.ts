import { assert, assertEquals, assertThrows } from '@std/assert'
import { InternalError } from '@zanix/errors'
import { defineZanixApp, isZanixAppDefinition } from 'modules/manifest/mod.ts'

console.error = () => {}

Deno.test('defineZanixApp: minimal manifest (only `name`) is valid', () => {
  const app = defineZanixApp({ name: 'reviews' })

  assertEquals(app.definition.name, 'reviews')
  assertEquals(app.definition.routesPrefix, 'reviews', 'routes defaults to auto-prefix with name')
  assertEquals(app.definition.dependencies, {})
  assertEquals(app.definition.rootDir, '.')
})

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
          config: { apiKey: { type: 'string', secret: true, default: 'hardcoded' } },
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
