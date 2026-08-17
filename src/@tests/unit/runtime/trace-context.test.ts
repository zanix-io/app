import { assertMatch, assertNotEquals } from '@std/assert'
import { generateTraceparent } from 'modules/runtime/trace-context.ts'

Deno.test('generateTraceparent: matches the W3C traceparent format', () => {
  assertMatch(generateTraceparent(), /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
})

Deno.test('generateTraceparent: two calls never produce the same trace-id', () => {
  assertNotEquals(generateTraceparent(), generateTraceparent())
})
