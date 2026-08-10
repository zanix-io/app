import { assert } from '@std/assert'
import { Interactor, ProgramModule, ZanixInteractor } from '@zanix/server'

/**
 * Confirmatory test (not exercising any of THIS package's own code) for a guarantee
 * `ctx.resolve<T>()` will depend on once built: `@zanix/server`'s own DI resolves by CLASS
 * IDENTITY, never by a class's `.name` string — two apps each authoring their own service under
 * the same conceptual name must still get independent instances/state. Already guaranteed by
 * `@zanix/server`'s `getTargetKey` (a `WeakMap` keyed by the class object itself); this test
 * records that guarantee against the real, public `ProgramModule.getInteractors(...).get(...)`
 * surface, not as something that could plausibly fail.
 */
Deno.test(
  "two classes named the same conceptual thing ('UserService') resolve to independent instances",
  () => {
    @Interactor()
    class BillingUserService extends ZanixInteractor {}

    @Interactor()
    class InventoryUserService extends ZanixInteractor {}

    const interactors = ProgramModule.getInteractors('target-identity-test')

    const billingInstance = interactors.get(BillingUserService)
    const inventoryInstance = interactors.get(InventoryUserService)

    assert(
      billingInstance !== inventoryInstance,
      'two distinct classes must never resolve to the same instance',
    )
    assert(
      interactors.get(BillingUserService) === billingInstance,
      'the SAME class must always resolve back to the SAME (singleton) instance',
    )
  },
)
