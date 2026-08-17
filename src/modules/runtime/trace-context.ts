/**
 * W3C Trace Context (`traceparent` header) generation for an outgoing `ctx.remote().call()`,
 * for distributed debugging across process boundaries. Deno has no ambient,
 * already-open span to propagate here (a `ctx.remote()` call is not itself instrumented by
 * anything upstream), so each call starts its own root trace rather than reusing one — still
 * enough to correlate one request across process boundaries in logs/tracing backends that read
 * the standard header, which is the actual goal.
 *
 * @module
 */

const HEX = '0123456789abcdef'

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  let hex = ''
  for (const byte of bytes) hex += HEX[byte >> 4] + HEX[byte & 0x0f]
  return hex
}

/** Builds a fresh, valid `traceparent` value (`00-{32 hex trace-id}-{16 hex parent-id}-01`) — a
 * new root span, sampled, for one outgoing remote call. */
export function generateTraceparent(): string {
  return `00-${randomHex(16)}-${randomHex(8)}-01`
}
