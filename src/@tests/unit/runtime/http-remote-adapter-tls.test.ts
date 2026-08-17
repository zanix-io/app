import { assertEquals } from '@std/assert'
import { HttpRemoteAdapter } from 'modules/runtime/http-remote-adapter.ts'
import type { ControlPlaneRegistry } from 'modules/runtime/control-plane/mod.ts'

// This suite tests ONLY this package's own responsibility — correctly forwarding `tls` options
// into `Deno.createHttpClient` and closing the result — by stubbing that Deno API directly.
// Whether presenting a client certificate this way is actually honored by a real TLS peer was
// independently verified (against a live, independent mTLS-enforcing server) during this
// feature's own design research; re-proving that here would just re-test the Deno runtime itself.

const FAKE_REGISTRY = {} as ControlPlaneRegistry

Deno.test('HttpRemoteAdapter: with no tls option, never calls Deno.createHttpClient', () => {
  const original = Deno.createHttpClient
  let calls = 0
  Deno.createHttpClient = ((options: unknown) => {
    calls++
    return original(options as never)
  }) as typeof Deno.createHttpClient

  try {
    new HttpRemoteAdapter(FAKE_REGISTRY)
    assertEquals(calls, 0)
  } finally {
    Deno.createHttpClient = original
  }
})

Deno.test(
  'HttpRemoteAdapter: with a tls option, calls Deno.createHttpClient with exactly those cert/key/caCerts',
  () => {
    const original = Deno.createHttpClient
    let captured: unknown
    const fakeClient = { close: () => {} } as Deno.HttpClient
    Deno.createHttpClient = ((options: unknown) => {
      captured = options
      return fakeClient
    }) as typeof Deno.createHttpClient

    try {
      const adapter = new HttpRemoteAdapter(FAKE_REGISTRY, {
        cert: 'CERT-PEM',
        key: 'KEY-PEM',
        caCerts: ['CA-PEM'],
      })
      assertEquals(captured, {
        cert: 'CERT-PEM',
        key: 'KEY-PEM',
        caCerts: ['CA-PEM'],
      })
      adapter.close()
    } finally {
      Deno.createHttpClient = original
    }
  },
)

Deno.test(
  "HttpRemoteAdapter.close(): calls the underlying HttpClient's own close() when tls was configured",
  () => {
    const original = Deno.createHttpClient
    let closeCalls = 0
    Deno.createHttpClient = (() => ({
      close: () => {
        closeCalls++
      },
    })) as unknown as typeof Deno.createHttpClient

    try {
      const adapter = new HttpRemoteAdapter(FAKE_REGISTRY, {
        cert: 'C',
        key: 'K',
      })
      adapter.close()
      assertEquals(closeCalls, 1)
    } finally {
      Deno.createHttpClient = original
    }
  },
)

Deno.test('HttpRemoteAdapter.close(): a no-op when tls was never configured', () => {
  const adapter = new HttpRemoteAdapter(FAKE_REGISTRY)
  adapter.close() // must not throw
})
