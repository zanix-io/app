import { buildGraph } from 'modules/manifest/mod.ts'
import { InternalError } from '@zanix/errors'
import { ProgramModule } from '@zanix/server'
import type { ActivatedApps } from './activate-apps.ts'
import { runOnStop } from './lifecycle.ts'
import type { AnnouncedRemoteInstance } from './remote-lifecycle.ts'
import { closeSandboxedWorkers } from './sandbox-operation.ts'

/**
 * Hot-uninstalls ONE app from an already-activated, already-running batch — the reverse of
 * {@link installApp}, same v1 scope (routes + resources + operations; see that function's own
 * doc for why jobs/events are untouched here).
 *
 * Order, mirroring `deactivateApps`' own "stop being reachable before cleaning up" reasoning:
 * 1. **Block fail-fast** if another still-active app has a REQUIRED `mode: 'remote'` dependency
 *    resolving to `appName` (declared in ITS OWN `dependencies`/`uses`, checked via the same
 *    graph `validate()` itself reads). This is the one reverse-dependency check that's actually
 *    possible statically — an ad-hoc `ctx.remote(appName)` call buried in some OTHER app's
 *    `operations`/route handler carries no manifest declaration at all, so it can't be checked
 *    here; uninstalling `appName` while such a call site exists elsewhere will simply make that
 *    call fail at its next invocation, same as calling `ctx.remote()` for any app that was never
 *    running. Documented boundary, not a hidden gap.
 * 2. Deregister `appName`'s own Control Plane announcement (if any) and remove its route metadata
 *    — both are "stop being reachable" — BEFORE `onStop` runs.
 * 3. Run `onStop(ctx)` for `appName` alone (resources are still open at this point).
 * 4. Release `appName`'s own reference to every resource it resolved — a resource ONLY it used
 *    closes now; one still shared with another active app stays open (see
 *    `ResourceRegistry.release`). Also terminates any worker `appName`'s own `sandbox`-declared
 *    operations created (see `closeSandboxedWorkers`) — never shared with another app, so always
 *    safe to close outright, no reference counting needed there.
 *
 * Still the CALLER's own job, exactly as serving `appName` was `installApp`'s caller's job: this
 * function only removes ROUTE METADATA (`ProgramModule.unregisterApplicationRoutes`) — an
 * already-bound `Deno.serve()` listener keeps dispatching `appName`'s own routes until the caller
 * also calls `webServerManager.unmount(id)` for every `ServerID` `bootstrapAppServer` returned
 * when `appName` was installed (this function has no way to know those ids — `activateApps`/
 * `installApp` never store them either, the same existing division of responsibility).
 *
 * @param activated Whatever `activateApps`/`installApp` returned for the batch `appName` belongs
 * to.
 * @param appName The app to remove.
 * @throws {InternalError} `APP_NOT_INSTALLED` if `appName` isn't in `activated.apps` —
 * caller-expected control-flow, `shouldLog: false` (not auto-logged).
 * @throws {InternalError} `APP_STILL_REQUIRED` if another active app has a required `mode: 'remote'`
 * dependency pointing at `appName` — nothing is torn down in this case. Caller-expected
 * control-flow, `shouldLog: false` (not auto-logged).
 * @throws {AggregateError} (from `runOnStop`) if `appName`'s own `onStop` failed — resources are
 * still released regardless (`finally`), same ordering guarantee `deactivateApps` gives at the
 * whole-batch level, but this function still throws afterward rather than returning: the caller
 * gets no updated `ActivatedApps` back in this case, and should treat `appName` as left in an
 * unknown state (its routes/announcement are already gone, its resources already released, but
 * its `onStop` may have only partially run) — same as `deactivateApps` itself never resolves
 * normally when `runOnStop` fails.
 * @returns A new `ActivatedApps`, with `appName` removed — the input `activated` is never mutated
 * in place.
 */
export async function uninstallApp(
  activated: ActivatedApps,
  appName: string,
): Promise<ActivatedApps> {
  const def = activated.apps.find((app) => app.name === appName)
  if (!def) {
    throw new InternalError(
      `Zanix App "${appName}" is not active in this process — nothing to uninstall.`,
      {
        code: 'APP_NOT_INSTALLED',
        // Caller-triggered, catchable-by-design: the caller asked to uninstall a name that isn't
        // active (typo, race, already-removed) — the mirror of `installApp`'s `APP_ALREADY_INSTALLED`
        // — the caller decides what to do with it. Not an internal fault.
        shouldLog: false,
        meta: { source: 'zanix', appName },
      },
    )
  }

  const graph = buildGraph(
    activated.apps,
    activated.rootResources,
    activated.bindings,
  )

  for (const [otherName, otherApp] of graph.apps) {
    if (otherName === appName) continue
    for (const [slot, dep] of Object.entries(otherApp.dependencies)) {
      const resolved = graph.resolvedKeys.get(`${otherName}:${slot}`)
      if (
        resolved?.mode === 'remote' && resolved.endpoint === appName &&
        dep.required
      ) {
        throw new InternalError(
          `Cannot uninstall "${appName}" — app "${otherName}" still has a required dependency ` +
            `("dependencies.${slot}") resolving to it.`,
          {
            code: 'APP_STILL_REQUIRED',
            // Caller-triggered, catchable-by-design: a conflict guard on the caller's own requested
            // action ("nothing is torn down in this case" — see this function's own doc) — the
            // caller decides whether to uninstall the dependent app first or abort. Not an internal
            // fault.
            shouldLog: false,
            meta: { source: 'zanix', appName, dependentApp: otherName, slot },
          },
        )
      }
    }
  }

  const announced: AnnouncedRemoteInstance[] = []
  for (const instance of activated.announced) {
    // deno-lint-ignore no-await-in-loop -- at most one entry ever matches `appName`
    if (instance.appName === appName) await instance.stop()
    else announced.push(instance)
  }

  ProgramModule.unregisterApplicationRoutes(appName)

  try {
    await runOnStop([def], activated.resources, activated.remoteCaller)
  } finally {
    for (const [appSlotKey, resolvedKey] of graph.resolvedKeys) {
      if (!appSlotKey.startsWith(`${appName}:`)) continue
      if (resolvedKey.mode === 'remote') continue
      // deno-lint-ignore no-await-in-loop
      await activated.registry.release(resolvedKey.qualifiedKey, appName)
    }
    // A later install reusing this exact app name (e.g. a new tenant onboarded under a name a
    // departed one used) must never inherit a stale quota from THIS install (see
    // `ResourceRegistry.setQuota`'s own doc) — a no-op if `appName` never had one set.
    activated.registry.clearQuota(appName)
    // Same reasoning for any sandboxed operation's own dedicated worker(s) — a no-op if `appName`
    // never declared any `sandbox` operations.
    closeSandboxedWorkers(appName)
  }

  const resources = new Map(activated.resources)
  for (const key of resources.keys()) {
    if (key.startsWith(`${appName}:`)) resources.delete(key)
  }

  return {
    apps: activated.apps.filter((app) => app.name !== appName),
    resources,
    registry: activated.registry,
    remoteCaller: activated.remoteCaller,
    announced,
    rootResources: activated.rootResources,
    bindings: activated.bindings.filter((binding) => binding.appName !== appName),
    dispatcher: activated.dispatcher,
  }
}
