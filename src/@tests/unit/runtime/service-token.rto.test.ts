import { assert, assertEquals } from '@std/assert'
import { classValidation } from '@zanix/validator'
import { ServiceTokenExchangeRTO } from 'modules/runtime/rtos/service-token.rto.ts'

Deno.test('ServiceTokenExchangeRTO validates a plain "assertion" string', async () => {
  const rto = await classValidation(ServiceTokenExchangeRTO, { assertion: 'signed-jwt' })
  assertEquals(rto.assertion, 'signed-jwt')
})

Deno.test('ServiceTokenExchangeRTO rejects a missing assertion', async () => {
  let threw = false
  try {
    await classValidation(ServiceTokenExchangeRTO, {})
  } catch {
    threw = true
  }
  assert(threw)
})

Deno.test('ServiceTokenExchangeRTO rejects an undefined body (unparseable request)', async () => {
  let threw = false
  try {
    await classValidation(ServiceTokenExchangeRTO, undefined)
  } catch {
    threw = true
  }
  assert(threw)
})
