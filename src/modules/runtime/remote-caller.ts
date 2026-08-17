import type { RemoteAppHandle, RemoteCallOptions } from 'typings/remote.ts'
import { InternalError } from '@zanix/errors'
import { getLocalOperation, isCallerAllowed } from './operation-registry.ts'

/** Bound to one calling app (`callerAppName`) — `ctx.remote(targetAppName)` partially applies
 * this with the CALLING app's own identity, needed for the outgoing service-auth token once a
 * call actually crosses a process boundary. */
export type RemoteCallerFactory = (
  callerAppName: string,
  targetAppName: string,
) => RemoteAppHandle

/** Dispatches ONE call that already failed the in-process lookup (`getLocalOperation` found
 * nothing) to whatever transport reaches a real remote process — `HttpRemoteAdapter` in v1.
 * A pluggable boundary, not a hardcoded `fetch()` call inline in
 * {@link createRemoteCaller}, so a future transport (gRPC, an event-based adapter) is a second
 * implementation of this same contract, never a rewrite of the local-first resolution logic. */
export interface HttpRemoteDispatcher {
  /**
   * Dispatches one call to `targetAppName`, running in a different process than `callerAppName`.
   * @param callerAppName The identity to authenticate the outgoing call as.
   * @param targetAppName The app to reach.
   * @param operationName Which of `targetAppName`'s declared `operations` to invoke.
   * @param payload JSON-serializable data to send.
   * @param options See {@linkcode RemoteCallOptions}.
   */
  dispatch(
    callerAppName: string,
    targetAppName: string,
    operationName: string,
    payload: unknown,
    options: RemoteCallOptions,
  ): Promise<unknown>
}

/**
 * Builds the `remote` factory `buildRuntimeContext` exposes as `ctx.remote` — local-first,
 * falling back to `dispatcher` only when `targetAppName` isn't running in this same process.
 * Every call uses `ctx.remote(name).call(...)` from day one, regardless of where the target
 * app actually runs — this factory is what resolves internally whether the target's
 * `DeploymentTarget` is local or remote, so the caller never has to know or branch on it.
 *
 * @param dispatcher Handles calls that fall through the local registry — omit entirely for a
 * process that never needs to reach a genuinely remote app (e.g. a single-process dev setup, or
 * every app it composes stays `embedded`); calls to a LOCAL app still work with no dispatcher at
 * all, at zero cost (no Control Plane/Redis touched). A call to an app that isn't local AND no
 * dispatcher was given throws a clear configuration error, never a silent no-op.
 * @throws {InternalError} `OPERATION_ACCESS_DENIED` for a LOCAL call whose target operation
 * declared `allowedCallers` and `callerAppName` isn't in it (see
 * `operation-registry.ts`'s {@link isCallerAllowed}) — checked here, in-process, deliberately: the
 * same ACL applies whether the caller happens to be co-located or genuinely remote, so two
 * mutually-untrusted apps sharing a process can't bypass it just by being embedded together. A
 * REMOTE call's own equivalent check happens on the target's side, in
 * `remote-dispatch-route.ts`'s `dispatch()`.
 */
export function createRemoteCaller(
  dispatcher?: HttpRemoteDispatcher,
): RemoteCallerFactory {
  return (callerAppName: string, targetAppName: string): RemoteAppHandle => ({
    call: async <T>(
      operationName: string,
      payload: unknown,
      options: RemoteCallOptions,
    ): Promise<T> => {
      const local = getLocalOperation(targetAppName, operationName)
      if (local) {
        if (!isCallerAllowed(local.allowedCallers, callerAppName)) {
          throw new InternalError(
            `Zanix App "${callerAppName}" is not allowed to invoke "${targetAppName}"'s ` +
              `operation "${operationName}" — its manifest scopes "allowedCallers" and ` +
              `"${callerAppName}" isn't listed.`,
            {
              code: 'OPERATION_ACCESS_DENIED',
              meta: {
                source: 'zanix',
                callerAppName,
                targetAppName,
                operationName,
              },
            },
          )
        }
        return await local.handler(payload, local.ctx) as T
      }

      if (!dispatcher) {
        throw new InternalError(
          `Zanix App "${targetAppName}" is not running in this process, and no remote dispatcher ` +
            `was configured for cross-process calls — pass one to activateApps() to enable ` +
            `ctx.remote() across processes.`,
          {
            code: 'REMOTE_APP_NOT_CONFIGURED',
            meta: {
              source: 'zanix',
              callerAppName,
              targetAppName,
              operationName,
            },
          },
        )
      }

      return await dispatcher.dispatch(
        callerAppName,
        targetAppName,
        operationName,
        payload,
        options,
      ) as T
    },
  })
}
