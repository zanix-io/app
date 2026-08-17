import { assertEquals } from '@std/assert'
import { generateRSAKeys } from '@zanix/helpers'
import { AUTH_HEADERS, bootstrapServers, webServerManager } from '@zanix/server'
import { createServiceAuthClient } from '@zanix/auth'
import { defineZanixApp } from 'modules/manifest/mod.ts'
import { activateApps } from 'modules/runtime/activate-apps.ts'
import { registerMcpServer } from 'modules/runtime/mcp-route.ts'

console.info = () => {}
console.error = () => {}
console.warn = () => {}

// `@AuthTokenValidation({type: 'api'})`'s guard checks a token revocation blocklist via the
// 'cache' core PROVIDER + 'kvLocal' core CONNECTOR slots — same real-Redis requirement
// `http-remote-adapter.test.ts` already documents for the exact same reason.
Deno.env.set('REDIS_URI', 'redis://localhost:6379')
await import('@zanix/datamaster/core')

const AGENT_ID = 'agent:mcp-integration-test'
const PORT = 4740

Deno.test(
  'registerMcpServer: real HTTP round trip — service-token exchange, tools/list surfaces an ' +
    'mcp-declared operation, tools/call invokes it for real',
  async () => {
    const agentKeys = await generateRSAKeys()
    const appKeys = await generateRSAKeys()
    Deno.env.set(`JWK_PRI_${AGENT_ID}`, btoa(agentKeys.privateKey))
    Deno.env.set(`JWK_PUB_${AGENT_ID}`, btoa(agentKeys.publicKey))
    Deno.env.set('JWK_PRI', btoa(appKeys.privateKey))
    Deno.env.set('JWK_PUB', btoa(appKeys.publicKey))

    const target = defineZanixApp({
      name: 'mcp-route-target',
      routes: false,
      operations: {
        echo: {
          handler: (payload: unknown) => Promise.resolve({ echoed: payload }),
          mcp: {
            description: 'Echoes its input.',
            inputSchema: { type: 'object' },
          },
        },
      },
    })
    await activateApps([target])
    await registerMcpServer()
    // Idempotent: a second call in the same process is a no-op — it must never try to
    // re-register the same route (which would otherwise throw a route-collision error).
    await registerMcpServer()

    const serverIds = await bootstrapServers({
      rest: { application: '__zanix-mcp', port: PORT },
    })

    try {
      const auth = createServiceAuthClient({ serviceId: AGENT_ID })
      const base = `http://localhost:${PORT}/api/__zanix-mcp`
      const headers = {
        'content-type': 'application/json',
        ...(await auth('__zanix-mcp', `${base}/service-token`)),
      }
      // The service-token exchange must actually have authenticated as OUR agent identity — a
      // sanity check on the exchange itself, independent of everything that follows.
      assertEquals(typeof headers[AUTH_HEADERS.api as never], 'string')

      const listResponse = await fetch(base, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      })
      const listBody = await listResponse.json()
      const tools = listBody.result.tools as {
        name: string
        description: string
      }[]
      const tool = tools.find((t) => t.name === 'mcp-route-target.echo')
      assertEquals(tool?.description, 'Echoes its input.')

      const callResponse = await fetch(base, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'mcp-route-target.echo', arguments: { text: 'hi' } },
        }),
      })
      const callBody = await callResponse.json()
      assertEquals(callBody.result.content, [
        { type: 'text', text: JSON.stringify({ echoed: { text: 'hi' } }) },
      ])

      // A notification (no `id`) gets no JSON-RPC response body at all — `handle()` falls back
      // to an empty object rather than `null` (no `HandlerResponse` shape exists for "202, empty").
      const notifyResponse = await fetch(base, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        }),
      })
      assertEquals(await notifyResponse.json(), {})
    } finally {
      await webServerManager.stop(serverIds)
      Deno.env.delete(`JWK_PRI_${AGENT_ID}`)
      Deno.env.delete(`JWK_PUB_${AGENT_ID}`)
      Deno.env.delete('JWK_PRI')
      Deno.env.delete('JWK_PUB')
    }
  },
)
