import { assertEquals } from '@std/assert'
import type { ResourceFactory } from 'modules/runtime/resource-types.ts'
import type { ZanixConnector } from '@zanix/server'

/**
 * Type-only regression guard: this line alone is what matters — it fails `deno check` (TS2322)
 * if `ResourceFactory`'s return union ever narrows back to `CloseableResource` alone. Every
 * `ZanixConnector` subclass (`RestClient`/`OAuth2Connector`/`GoogleOAuth2Connector` included)
 * declares `close()` as `protected`, which can never satisfy `CloseableResource`'s public
 * `close()` structurally — only assignability to `ZanixConnector` itself (ordinary inheritance,
 * where `protected` members are no obstacle) admits it. `connector` is only ever typed, never
 * constructed — a real connector's constructor runs framework auto-initialization this test must
 * never trigger.
 */
function asResourceFactory(connector: ZanixConnector): ResourceFactory {
  return () => connector
}

Deno.test(
  'ResourceFactory: accepts a ZanixConnector instance directly, not just a plain CloseableResource',
  () => {
    assertEquals(typeof asResourceFactory, 'function')
  },
)
