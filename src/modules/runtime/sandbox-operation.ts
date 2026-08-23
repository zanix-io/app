import type { OperationHandler, SandboxDeclaration } from 'typings/manifest.ts'
import { InternalError } from '@zanix/errors'
import { WorkerManager } from '@zanix/workers'
// Side-effect only: `@zanix/workers`'s own `WorkerManager` unconditionally calls the GLOBAL
// `Znx.logger` (never imports a logger module itself) whenever a task errors, times out, or the
// worker itself errors — it assumes some other part of the process already installed that global
// by importing `@zanix/logger` first. Nothing else a `sandbox`-only app necessarily imports does
// that (this module's own `@zanix/errors` import doesn't — see that package's own `main.ts` doc on
// why it deliberately avoids it, to dodge an import cycle). Without this, `Znx` is `undefined`, so
// `WorkerManager`'s error/timeout paths throw a `ReferenceError` INSIDE its own `worker.onmessage`/
// `worker.onerror` handlers, before ever reaching `onFinish` — silently swallowed by the Worker
// error-event dispatch itself (an exception thrown while handling an already-`error` event is
// never re-reported, to avoid infinite recursion), so `onFinish` is never called and the
// `Promise` `buildSandboxedHandler` returns hangs forever instead of ever rejecting
// `SANDBOX_TASK_FAILED`. Importing this here — once, at module load, regardless of whether this
// app declares any `sandbox` operations at all — guarantees the global exists before any
// `WorkerManager` this module creates can ever report a failure.
import '@zanix/logger'

/**
 * `appName -> every WorkerManager this app's own sandboxed operations created` — the only
 * bookkeeping needed so `closeSandboxedWorkers` can actually terminate them on hot-uninstall
 * (`uninstallApp`'s own doc) instead of leaking real OS threads forever. Never touched for an app
 * with no `sandbox`-declared operations.
 */
const sandboxWorkersByApp = new Map<string, WorkerManager[]>()

/**
 * Gives a plain function a specific `.name` — `WorkerManager.task()` only ever READS `task.name`
 * to build the `taskName` it ships to the worker (see `manager.ts`'s own `task()`); it never calls
 * `task` itself on the host side, since the REAL invocation happens inside the worker via
 * `module[taskName](...)` (`processor.ts`). A sandboxed operation's actual function lives ONLY in
 * its own module, never imported into this process, so there is no real function reference to
 * hand `task()` here — a same-named stub satisfies the exact same contract at zero cost.
 */
function createNamedStub(name: string): (...args: unknown[]) => unknown {
  const stub = (..._args: unknown[]): unknown => undefined
  Object.defineProperty(stub, 'name', { value: name })
  return stub
}

/**
 * Builds an {@link OperationHandler} for a `sandbox`-declared operation — real sandboxing, scoped
 * to `operations` only (see `SandboxDeclaration`'s
 * own doc for the full reasoning and honest limitations).
 *
 * Creates ONE dedicated `WorkerManager` for THIS operation, reused across every future call to it
 * (never a fresh worker per call) — its `permissions` are fixed for the pool's entire lifetime
 * (see `WorkerManager`'s own doc on why a shared pool can't mix permission profiles).
 *
 * The returned handler ignores whatever `ctx` it's called with — a sandboxed operation can NEVER
 * receive one (see `SandboxDeclaration`'s own doc on why: a live `RuntimeContext` cannot cross a
 * `postMessage` boundary) — it only ever forwards `payload`.
 *
 * @param appName The owning app — used only to group this operation's own worker(s) for
 * {@link closeSandboxedWorkers}, never sent to the worker itself.
 * @param operationName This operation's own manifest name — the `sandbox.taskName` default when
 * that field is omitted.
 * @param sandbox See {@link SandboxDeclaration}.
 * @returns A handler whose rejection wraps the worker-reported failure in an
 * {@link InternalError} `SANDBOX_TASK_FAILED` (task threw, rejected, or the worker itself errored/
 * timed out — `WorkerManager`'s own `onFinish` contract doesn't distinguish these, so neither does
 * this).
 */
export function buildSandboxedHandler(
  appName: string,
  operationName: string,
  sandbox: SandboxDeclaration,
): OperationHandler {
  const taskName = sandbox.taskName ?? operationName
  const workerManager = new WorkerManager({
    pool: 1,
    permissions: sandbox.permissions,
  })
  const stub = createNamedStub(taskName)

  const workers = sandboxWorkersByApp.get(appName) ?? []
  workers.push(workerManager)
  sandboxWorkersByApp.set(appName, workers)

  return (payload: unknown) =>
    new Promise((resolve, reject) => {
      workerManager.task(stub, {
        metaUrl: sandbox.metaUrl,
        timeout: sandbox.timeout,
        autoClose: false,
        onFinish: ({ error, response }) => {
          if (error) {
            reject(
              new InternalError(
                `Sandboxed operation "${appName}:${operationName}" (task "${taskName}") failed.`,
                {
                  code: 'SANDBOX_TASK_FAILED',
                  cause: error,
                  meta: { source: 'zanix', appName, operationName, taskName },
                },
              ),
            )
            return
          }
          resolve(response)
        },
      }).invoke(payload)
    })
}

/**
 * Terminates every worker `appName`'s own sandboxed operations created (see
 * {@linkcode buildSandboxedHandler}) — called by `uninstallApp` alongside its existing resource
 * release, so hot-uninstalling an app with sandboxed operations doesn't leak real OS threads. A
 * no-op if `appName` never had any (the common case).
 */
export function closeSandboxedWorkers(appName: string): void {
  const workers = sandboxWorkersByApp.get(appName)
  if (!workers) return

  for (const worker of workers) worker.close()
  sandboxWorkersByApp.delete(appName)
}
