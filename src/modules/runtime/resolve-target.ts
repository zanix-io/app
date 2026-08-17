import { InternalError } from '@zanix/errors'
import { ProgramModule, ZanixConnector, ZanixInteractor, ZanixProvider } from '@zanix/server'

/**
 * Backs `AppSetupContext.resolve()` — sugar over the same global DI the rest of the framework
 * already uses (`ProgramModule.getInteractors`/`getProviders`/`getConnectors`), dispatched by
 * checking `Target.prototype instanceof` the three public base classes (`ZanixInteractor`/
 * `ZanixProvider`/`ZanixConnector`) rather than any private target metadata. Scoped to `appName`
 * as the DI context id, so a `SCOPED`-lifetime target resolved from inside one app's `setup(ctx)`
 * never leaks into another app's scope; ignored for `SINGLETON`-lifetime targets (the default),
 * same as any other `ctxId` passed to those getters.
 *
 * @param appName The app whose `setup(ctx)` is calling `ctx.resolve()` — used as the DI `ctxId`.
 * @param Target A class decorated with `@Interactor`/`@Provider`/`@Connector`.
 * @throws {InternalError} if `Target` extends none of the three decoratable base classes.
 */
export function resolveTarget<T>(
  appName: string,
  Target: new (...args: never[]) => T,
): T {
  if (Target.prototype instanceof ZanixInteractor) {
    return ProgramModule.getInteractors(appName).get(Target as never) as T
  }
  if (Target.prototype instanceof ZanixProvider) {
    return ProgramModule.getProviders(appName).get(Target as never) as T
  }
  if (Target.prototype instanceof ZanixConnector) {
    return ProgramModule.getConnectors(appName).get(Target as never) as T
  }

  throw new InternalError(
    `ctx.resolve() only resolves classes decorated with @Interactor/@Provider/@Connector — ` +
      `"${Target.name}" extends none of them.`,
    {
      code: 'UNRESOLVABLE_TARGET',
      meta: { source: 'zanix', target: Target.name },
    },
  )
}
