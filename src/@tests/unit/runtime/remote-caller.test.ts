import { assertEquals, assertRejects } from '@std/assert'
import { assertSpyCalls, spy } from '@std/testing/mock'
import { InternalError } from '@zanix/errors'
import { normalize } from 'modules/manifest/normalize.ts'
import { registerOperations } from 'modules/runtime/operation-registry.ts'
import { createRemoteCaller } from 'modules/runtime/remote-caller.ts'
import type { HttpRemoteDispatcher } from 'modules/runtime/remote-caller.ts'

console.error = () => {}

Deno.test(
  'createRemoteCaller: a target registered locally is called directly — the dispatcher is never touched',
  async () => {
    const def = normalize({
      name: 'remote-caller-local-target',
      operations: { echo: (payload: unknown) => Promise.resolve(payload) },
    })
    registerOperations(def, new Map())

    const dispatch = spy((..._args: unknown[]) => Promise.resolve('should never be returned'))
    const dispatcher: HttpRemoteDispatcher = { dispatch: dispatch as never }

    const remote = createRemoteCaller(dispatcher)
    const result = await remote(
      'remote-caller-caller',
      'remote-caller-local-target',
    ).call(
      'echo',
      'hello',
      { timeoutMs: 1000 },
    )

    assertEquals(result, 'hello')
    assertSpyCalls(dispatch, 0)
  },
)

Deno.test(
  'createRemoteCaller: a target NOT registered locally falls through to the dispatcher, with the right args',
  async () => {
    const dispatch = spy((..._args: unknown[]) => Promise.resolve({ ok: true }))
    const dispatcher: HttpRemoteDispatcher = { dispatch: dispatch as never }

    const remote = createRemoteCaller(dispatcher)
    const result = await remote(
      'remote-caller-caller-2',
      'remote-caller-never-local',
    ).call(
      'createReview',
      { text: 'great' },
      { timeoutMs: 2000 },
    )

    assertEquals(result, { ok: true })
    assertSpyCalls(dispatch, 1)
    assertEquals(dispatch.calls[0].args, [
      'remote-caller-caller-2',
      'remote-caller-never-local',
      'createReview',
      { text: 'great' },
      { timeoutMs: 2000 },
    ])
  },
)

Deno.test(
  'createRemoteCaller: a target NOT registered locally, with NO dispatcher configured, throws a clear config error',
  async () => {
    const remote = createRemoteCaller()

    await assertRejects(
      () =>
        remote('remote-caller-caller-3', 'remote-caller-unconfigured').call(
          'anything',
          null,
          { timeoutMs: 1000 },
        ),
      InternalError,
    )
  },
)

// --- allowedCallers enforcement (local-first dispatch) ---

Deno.test(
  'createRemoteCaller: a LOCAL call from a caller NOT in allowedCallers is denied — the ' +
    'handler never runs',
  async () => {
    let handlerCalls = 0
    const def = normalize({
      name: 'remote-caller-scoped-target',
      operations: {
        readSecret: {
          handler: () => {
            handlerCalls++
            return Promise.resolve('secret')
          },
          allowedCallers: ['billing'],
        },
      },
    })
    registerOperations(def, new Map())

    const remote = createRemoteCaller()
    const error = await assertRejects(
      () =>
        remote('inventory', 'remote-caller-scoped-target').call(
          'readSecret',
          null,
          {
            timeoutMs: 1000,
          },
        ),
      InternalError,
    )

    assertEquals((error as InternalError).code, 'OPERATION_ACCESS_DENIED')
    assertEquals(handlerCalls, 0)
    // Caller-expected control-flow (same ACL check as the HttpError/protocol-error equivalents in
    // remote-dispatch-route.ts/mcp-server.ts/mtls-dispatch-server.ts, none of which auto-log) —
    // must NOT auto-log.
    assertEquals((error as unknown as { _logged: boolean })._logged, false)
  },
)

Deno.test(
  'createRemoteCaller: a LOCAL call from a caller listed in allowedCallers is allowed',
  async () => {
    const def = normalize({
      name: 'remote-caller-scoped-target-2',
      operations: {
        readSecret: {
          handler: () => Promise.resolve('secret'),
          allowedCallers: ['billing'],
        },
      },
    })
    registerOperations(def, new Map())

    const remote = createRemoteCaller()
    const result = await remote('billing', 'remote-caller-scoped-target-2')
      .call(
        'readSecret',
        null,
        { timeoutMs: 1000 },
      )

    assertEquals(result, 'secret')
  },
)

Deno.test(
  'createRemoteCaller: a LOCAL call to an operation with no allowedCallers declared (public) ' +
    'is allowed from any caller',
  async () => {
    const def = normalize({
      name: 'remote-caller-public-target',
      operations: { echo: (payload: unknown) => Promise.resolve(payload) },
    })
    registerOperations(def, new Map())

    const remote = createRemoteCaller()
    const result = await remote(
      'literally-anyone',
      'remote-caller-public-target',
    ).call(
      'echo',
      'hi',
      { timeoutMs: 1000 },
    )

    assertEquals(result, 'hi')
  },
)
