/**
 * Cross-app calling contract — `ctx.remote(name)`'s return value.
 * Pure data/shape, no I/O: the real implementation (in-process dispatch, or HTTP + traceparent +
 * service auth token) lives in `@zanix/app/runtime`, never here.
 *
 * @module
 */

/** Options a `ctx.remote(name).call(...)` invocation must supply. */
export interface RemoteCallOptions {
  /** Milliseconds before the call is aborted — mandatory, never a silent default, so a caller
   * always states the latency budget it's willing to accept for a real network round trip. */
  timeoutMs: number
}

/** What `ctx.remote(name)` resolves to — one target app, ready to receive named operation calls. */
export interface RemoteAppHandle {
  /**
   * Invokes `operationName` on the target app declared via `ctx.remote(name)`, whether that app
   * is running in this same process (invoked directly, no network, no serialization) or a
   * different one (invoked over HTTP) — the caller never writes two versions.
   *
   * @param operationName Must match a key in the target app's own `operations` (see
   * `OperationHandler`) — never a `routes` path.
   * @param payload JSON-serializable if the target turns out to be remote; passed through as-is
   * if local.
   * @param options See {@link RemoteCallOptions}.
   * @throws if the target app is not currently discoverable, or the call doesn't complete within
   * `timeoutMs`.
   */
  call<T = unknown>(
    operationName: string,
    payload: unknown,
    options: RemoteCallOptions,
  ): Promise<T>
}
