// deno-coverage-ignore-file

/**
 * Generates a real, throwaway CA + server + client X.509 chain for mTLS integration tests — the
 * only way to genuinely exercise `node:https`'s `requestCert`/`rejectUnauthorized` (a self-signed,
 * unverified cert wouldn't reach the same code paths a real deployment does). Shells out to the
 * system `openssl` binary; there is no in-repo cert-generation helper to reuse (confirmed — the
 * one other TLS test in this monorepo, `@zanix/server`'s "should start https", hardcodes a static,
 * long-expired one-way server cert and never performs a real client handshake against it).
 *
 * @module
 */

async function run(cmd: string[], cwd: string): Promise<void> {
  const command = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd,
    stdout: 'null',
    stderr: 'null',
  })
  const { success } = await command.output()
  if (!success) throw new Error(`Command failed: ${cmd.join(' ')}`)
}

/** PEM material for one generated chain — a fresh CA, a `CN=localhost` server cert/key signed by
 * it, and a `CN=test-client` client cert/key also signed by it. */
export interface MtlsTestCertChain {
  ca: string
  serverCert: string
  serverKey: string
  clientCert: string
  clientKey: string
}

/**
 * Generates the chain into `dir` (created if missing) via a sequence of `openssl` subprocess
 * calls, then reads the resulting PEM files back. `days 825`/`3650` are arbitrary but generous —
 * only real enough to outlive a single test run, never meant to be reused across runs.
 */
export async function generateMtlsTestCertChain(
  dir: string,
): Promise<MtlsTestCertChain> {
  await Deno.mkdir(dir, { recursive: true })

  await run(['openssl', 'genrsa', '-out', 'ca.key', '2048'], dir)
  await run(
    [
      'openssl',
      'req',
      '-x509',
      '-new',
      '-nodes',
      '-key',
      'ca.key',
      '-sha256',
      '-days',
      '3650',
      '-out',
      'ca.pem',
      '-subj',
      '/CN=ZanixTestCA',
    ],
    dir,
  )

  await run(['openssl', 'genrsa', '-out', 'server.key', '2048'], dir)
  await run(
    [
      'openssl',
      'req',
      '-new',
      '-key',
      'server.key',
      '-out',
      'server.csr',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
    ],
    dir,
  )
  await run(
    [
      'openssl',
      'x509',
      '-req',
      '-in',
      'server.csr',
      '-CA',
      'ca.pem',
      '-CAkey',
      'ca.key',
      '-CAcreateserial',
      '-out',
      'server.pem',
      '-days',
      '825',
      '-sha256',
      '-copy_extensions',
      'copyall',
    ],
    dir,
  )

  await run(['openssl', 'genrsa', '-out', 'client.key', '2048'], dir)
  await run(
    [
      'openssl',
      'req',
      '-new',
      '-key',
      'client.key',
      '-out',
      'client.csr',
      '-subj',
      '/CN=test-client',
    ],
    dir,
  )
  await run(
    [
      'openssl',
      'x509',
      '-req',
      '-in',
      'client.csr',
      '-CA',
      'ca.pem',
      '-CAkey',
      'ca.key',
      '-CAcreateserial',
      '-out',
      'client.pem',
      '-days',
      '825',
      '-sha256',
      '-copy_extensions',
      'copyall',
    ],
    dir,
  )

  const read = (name: string) => Deno.readTextFile(`${dir}/${name}`)
  return {
    ca: await read('ca.pem'),
    serverCert: await read('server.pem'),
    serverKey: await read('server.key'),
    clientCert: await read('client.pem'),
    clientKey: await read('client.key'),
  }
}
