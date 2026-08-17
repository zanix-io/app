import { assertEquals, assertStrictEquals } from '@std/assert'
import {
  getConfigOverride,
  hasConfigOverride,
  setConfigOverride,
} from 'modules/runtime/config-overrides.ts'

Deno.test('config-overrides: a never-overridden key reports hasConfigOverride false', () => {
  assertStrictEquals(
    hasConfigOverride('config-overrides-never-set', 'anything'),
    false,
  )
  assertStrictEquals(
    getConfigOverride('config-overrides-never-set', 'anything'),
    undefined,
  )
})

Deno.test('config-overrides: setConfigOverride is visible via get/hasConfigOverride', () => {
  setConfigOverride('config-overrides-basic', 'pageSize', 25)

  assertStrictEquals(
    hasConfigOverride('config-overrides-basic', 'pageSize'),
    true,
  )
  assertEquals(getConfigOverride('config-overrides-basic', 'pageSize'), 25)
})

Deno.test('config-overrides: overriding again replaces the previous value', () => {
  setConfigOverride('config-overrides-replace', 'pageSize', 10)
  setConfigOverride('config-overrides-replace', 'pageSize', 20)

  assertEquals(getConfigOverride('config-overrides-replace', 'pageSize'), 20)
})

Deno.test('config-overrides: different apps never share an override for the same key', () => {
  setConfigOverride('config-overrides-app-a', 'shared', 'a-value')
  setConfigOverride('config-overrides-app-b', 'shared', 'b-value')

  assertEquals(
    getConfigOverride('config-overrides-app-a', 'shared'),
    'a-value',
  )
  assertEquals(
    getConfigOverride('config-overrides-app-b', 'shared'),
    'b-value',
  )
})
