// deno-coverage-ignore-file

import { ZanixRedisConnector } from '@zanix/datamaster'

/** A real, standalone `redis-server` subprocess bound to its own port — genuinely independent
 * from any other instance (its own process, own in-memory dataset), the only way to test Redlock
 * quorum behavior for real rather than simulating it against a single shared Redis.
 *
 * `connector` is built ONCE and stays the SAME object for this instance's entire lifetime, even
 * across `kill()`/`restart()` — `LeaderElection` is constructed from these connectors once, up
 * front; replacing an instance's connector object later would leave `LeaderElection` holding a
 * reference to whichever object existed at construction time, never the new one (plain array
 * copy, no live binding) — so a "restart" MUST reuse the original connector and simply let its own
 * reconnect logic recover once the process is listening on the same port again. */
export interface RedlockTestInstance {
  port: number
  connector: ZanixRedisConnector
  /** Kills the underlying `redis-server` process — simulates that instance going down entirely
   * (unreachable), not a graceful shutdown a client would recover from. */
  kill(): void
  /** Starts a FRESH `redis-server` process on this SAME port (a clean dataset — this is meant to
   * simulate a genuinely new instance coming up, not a data-preserving restart) — `connector`
   * itself is untouched, so `LeaderElection` (already built with a reference to it) transparently
   * starts reaching a live server again once the underlying client reconnects. */
  restart(): Promise<void>
}

// Checked via a bare `redis-cli ping`, deliberately NOT `ZanixRedisConnector` — that client's own
// reconnect/retry behavior is tuned for a long-lived application connection, not a fast, tightly
// time-bounded "has the port started accepting connections yet" probe, and a single stuck attempt
// there could hang well past this function's own deadline. `redis-cli` exits immediately either
// way, so `AbortSignal.timeout` on the SUBPROCESS itself bounds each attempt exactly.
async function waitUntilReady(port: number): Promise<void> {
  const deadline = Date.now() + 5000
  // A genuine poll-until-ready loop — each attempt depends on the previous one's outcome (whether
  // the port answered yet), so there's no batch of independent promises to collect and
  // `Promise.all` instead.
  for (;;) {
    try {
      const command = new Deno.Command('redis-cli', {
        args: ['-p', String(port), 'ping'],
        stdin: 'null',
        stdout: 'piped',
        stderr: 'null',
        signal: AbortSignal.timeout(1000),
      })
      // deno-lint-ignore no-await-in-loop
      const { success, stdout } = await command.output()
      if (success && new TextDecoder().decode(stdout).trim() === 'PONG') return
    } catch {
      // subprocess itself failed to run (aborted by the timeout signal, etc.) — treated the same
      // as "not ready yet", retried below until the overall deadline.
    }
    if (Date.now() > deadline) {
      throw new Error(
        `redis-server on port ${port} never answered PING within 5s`,
      )
    }
    // deno-lint-ignore no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

function spawnRedisServer(dir: string, port: number): Deno.ChildProcess {
  const command = new Deno.Command('redis-server', {
    args: [
      '--port',
      String(port),
      '--daemonize',
      'no',
      '--save',
      '',
      '--appendonly',
      'no',
      '--dir',
      dir,
      '--dbfilename',
      `dump-${port}.rdb`,
      '--logfile',
      `${dir}/${port}.log`,
    ],
    stdin: 'null',
    stdout: 'null',
    stderr: 'null',
  })
  return command.spawn()
}

/** Spins up `count` real, independent `redis-server` processes on consecutive ports starting at
 * `basePort`, each with its own throwaway data dir under `dir` — no persistence, no AOF, nothing
 * that outlives the test. Resolves once every instance actually answers a real command, not just
 * once the process has started (a fresh `redis-server` needs a moment to bind its port). */
export async function startRedlockTestInstances(
  dir: string,
  basePort: number,
  count: number,
): Promise<RedlockTestInstance[]> {
  await Deno.mkdir(dir, { recursive: true })

  const instances = Array.from({ length: count }, (_, i) => {
    const port = basePort + i
    let process = spawnRedisServer(dir, port)

    return {
      port,
      connector: new ZanixRedisConnector({
        redisUrl: `redis://127.0.0.1:${port}`,
      }),
      kill: () => {
        try {
          process.kill()
        } catch {
          // already dead — a test that killed it itself calling this again is a no-op, not an error
        }
      },
      restart: async () => {
        process = spawnRedisServer(dir, port)
        await waitUntilReady(port)
      },
    }
  })

  await Promise.all(instances.map((instance) => waitUntilReady(instance.port)))

  return instances
}
