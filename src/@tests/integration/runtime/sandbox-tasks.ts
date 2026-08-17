// deno-coverage-ignore-file
// Real, on-disk, independently-importable task functions for `sandbox-operation.test.ts` — a
// sandboxed operation can never be an inline closure (it must survive its own `import(metaUrl)`
// inside a dedicated Worker), so these exist as actual named exports, not fixtures inlined in the
// test file itself.

export function echoTask(payload: unknown) {
  return payload
}

export function readSecretTask() {
  return Deno.env.get('SANDBOX_OPERATION_TEST_SECRET') ?? null
}

export function runawayTask() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
}
