import { assert, assertEquals } from '@std/assert'
import { defineZanixApp } from 'modules/manifest/mod.ts'
import {
  OPERATIONS_PATH_SEGMENT,
  SERVICE_TOKEN_PATH_SEGMENT,
} from 'modules/runtime/http-remote-adapter.ts'

console.info = () => {}
console.error = () => {}
console.warn = () => {}

/**
 * Regression for `remote-dispatch-route.ts`'s `exchange` handler: it used to read
 * `ctx.payload.body.assertion` completely unvalidated, so a missing/malformed request body (no
 * `Content-Type`, empty body, invalid JSON, or valid JSON missing `assertion`) surfaced as an
 * unhandled `TypeError` (reading `.assertion` off `undefined`) instead of a clean HTTP error —
 * fixed by declaring `ServiceTokenExchangeRTO` as the route's `Body` RTO (see that file's own
 * `@Post(SERVICE_TOKEN_PATH_SEGMENT, { Body: ServiceTokenExchangeRTO })`). Exercised here over
 * real HTTP (not just `ServiceTokenExchangeRTO`'s own isolated `classValidation` unit tests in
 * `unit/runtime/service-token.rto.test.ts`) specifically to prove the RTO is actually wired into
 * the real route — a test using only `classValidation` directly would keep passing even if the
 * `Body:` option were accidentally removed from the decorator.
 *
 * No `JWK_*`/Redis setup needed: validation happens BEFORE `exchangeServiceCredential` ever runs,
 * so these requests never reach real credential-exchange logic at all.
 */
Deno.test(
  'POST .../service-token: a missing/malformed body fails with a clean 400 (RTO validation), ' +
    'never an unhandled 500 — real HTTP',
  async () => {
    const PORT = 4650
    const appName = 'service-token-validation-target'

    const target = defineZanixApp({
      name: appName,
      routes: false,
      operations: {
        echo: (payload: unknown) => Promise.resolve({ echoed: payload }),
      },
    })

    const handle = await target.serve({ server: { rest: { port: PORT } } })
    await new Promise((resolve) => setTimeout(resolve, 300))

    const exchangeUrl =
      `http://localhost:${PORT}/api/${OPERATIONS_PATH_SEGMENT}/${appName}/${SERVICE_TOKEN_PATH_SEGMENT}`

    try {
      // Well-formed JSON, but missing the required `assertion` field entirely.
      const missingAssertion = await fetch(exchangeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      assertEquals(missingAssertion.status, 400)
      await missingAssertion.body?.cancel()

      // No body at all — the exact shape that used to throw an unhandled TypeError reading
      // `ctx.payload.body.assertion` off `undefined`.
      const noBody = await fetch(exchangeUrl, { method: 'POST' })
      assert(
        noBody.status !== 500,
        'a missing body must never surface as an unhandled 500',
      )
      assertEquals(noBody.status, 400)
      await noBody.body?.cancel()
    } finally {
      await handle.stop()
    }
  },
)
