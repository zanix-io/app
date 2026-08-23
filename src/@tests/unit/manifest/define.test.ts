import { assert } from '@std/assert'
import { defineZanixApp } from 'modules/manifest/mod.ts'
import { registerResourceType } from 'modules/runtime/resource-types.ts'

Deno.test(
  'ZanixAppDefinition.serve(): with no server, registers (onStart runs) but never listens on ' +
    'any port — stop() still runs onStop and closes resources',
  async () => {
    let onStartRan = false
    let onStopRan = false
    let closed = false

    registerResourceType('serve-jobs-only-fake', () => ({
      close: () => {
        closed = true
      },
    }))

    const jobsOnly = defineZanixApp({
      name: 'serve-jobs-only',
      dependencies: { store: { type: 'serve-jobs-only-fake' } },
      onStart: () => {
        onStartRan = true
      },
      onStop: () => {
        onStopRan = true
      },
    })

    const handle = await jobsOnly.serve({
      resources: { store: { type: 'serve-jobs-only-fake', options: {} } },
      uses: [{ slot: 'store', resourceName: 'store' }],
    })

    assert(onStartRan, 'onStart must run as part of serve()')
    assert(!closed, 'must not be closed yet — serve() only starts things')

    await handle.stop()

    assert(onStopRan, 'onStop must run as part of stop()')
    assert(closed, 'resources must be closed after stop()')
  },
)
