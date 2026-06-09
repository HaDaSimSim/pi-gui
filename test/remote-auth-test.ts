// Remote-control auth verification (token store + Host-gated middleware).
// No server boot, no network — uses a temp config file and Hono's app.request().

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { _resetRateLimit, remoteAuthMiddleware } from '../server/remote-auth.ts';
import { RemoteStore } from '../server/remote-config.ts';

const dir = mkdtempSync(join(tmpdir(), 'pi-remote-test-'));
const cfg = join(dir, 'remote.json');
let pass = 0,
  fail = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${msg}`);
  } else {
    fail++;
    console.log(`  ❌ ${msg}`);
  }
};

const TAILNET = 'mac.tailnet.ts.net';

// Build a fresh store + a Hono app guarded by the middleware. The guarded route
// just echoes 200 so we can assert on the status code.
function makeApp(store: RemoteStore) {
  const app = new Hono();
  app.use(
    '*',
    remoteAuthMiddleware(store, {
      exemptPaths: (p) => p === '/api/remote/pair/confirm',
    }),
  );
  app.all('*', (c) => c.json({ ok: true }));
  return app;
}

function req(app: Hono, path: string, host: string, auth?: string) {
  const headers: Record<string, string> = { host };
  if (auth) headers.authorization = `Bearer ${auth}`;
  return app.request(path, { headers });
}

async function main() {
  console.log('1) store: pairing state machine (pending → active)');
  let store = new RemoteStore(cfg);
  store.setEnabled(true);
  store.setTailnetHost(TAILNET);
  ok(!store.isRemoteActive(), 'enabled but no device → remote NOT active');
  const { id, token } = store.pairInit('iPhone');
  ok(
    store.listDevices().some((d) => d.id === id && d.status === 'pending'),
    'device is pending',
  );
  ok(!store.isRemoteActive(), 'pending device alone → still NOT active');
  ok(store.verifyToken(token) === null, 'pending token is NOT a valid active token');

  console.log('2) store: confirm flips pending → active');
  ok(store.confirmPairing(token) === id, 'confirmPairing returns the device id');
  ok(store.isRemoteActive(), 'after confirm → remote IS active');
  ok(store.verifyToken(token) === id, 'token now verifies as active');
  ok(store.confirmPairing(token) === null, 'cannot re-confirm an already-active token');

  console.log('3) store: token never stored in plaintext');
  const raw = readFileSync(cfg, 'utf8');
  ok(!raw.includes(token), 'plaintext token absent from config file (hash only)');

  console.log('4) middleware: localhost is exempt (no token needed)');
  _resetRateLimit();
  let app = makeApp(store);
  ok((await req(app, '/api/sessions', 'localhost:4317')).status === 200, 'localhost → 200');
  ok((await req(app, '/api/sessions', '127.0.0.1:4317')).status === 200, '127.0.0.1 → 200');

  console.log('5) middleware: tailnet Host requires a valid bearer');
  ok((await req(app, '/api/sessions', TAILNET)).status === 401, 'tailnet, no token → 401');
  ok(
    (await req(app, '/api/sessions', TAILNET, 'wrong-token')).status === 401,
    'tailnet, bad token → 401',
  );
  ok(
    (await req(app, '/api/sessions', TAILNET, token)).status === 200,
    'tailnet, valid token → 200',
  );

  console.log('6) middleware: unknown Host is forbidden (rebinding defense)');
  ok(
    (await req(app, '/api/sessions', 'evil.example.com', token)).status === 403,
    'unknown Host → 403 even with a valid token',
  );

  console.log('7) middleware: pairing-confirm path is exempt from active-token check');
  // A pending token would 401 on a normal path, but pass the middleware on the
  // confirm path (the route itself verifies the pending token).
  store.setEnabled(true);
  const pending = store.pairInit('iPad');
  app = makeApp(store);
  ok(
    (await req(app, '/api/sessions', TAILNET, pending.token)).status === 401,
    'pending token on a normal path → 401',
  );
  ok(
    (await req(app, '/api/remote/pair/confirm', TAILNET, pending.token)).status === 200,
    'pending token on confirm path → passes middleware (200)',
  );

  console.log('8) store: revoke closes remote');
  store = new RemoteStore(cfg); // reload from disk
  const active = store.listDevices().filter((d) => d.status === 'active');
  for (const d of active) store.revokeDevice(d.id);
  ok(
    store.listDevices().filter((d) => d.status === 'active').length === 0,
    'all active devices revoked',
  );
  ok(!store.isRemoteActive(), 'no active devices → remote NOT active (port stays closed)');

  console.log('9) middleware: rate-limit locks out after repeated bad tokens');
  _resetRateLimit();
  store.setEnabled(true);
  const fresh = store.pairInit('test');
  store.confirmPairing(fresh.token);
  app = makeApp(store);
  let sawLock = false;
  for (let i = 0; i < 12; i++) {
    const r = await req(app, '/api/sessions', TAILNET, 'bad');
    if (r.status === 429) sawLock = true;
  }
  ok(sawLock, 'repeated bad tokens eventually → 429 lockout');

  console.log(`\n결과: ${pass} passed, ${fail} failed`);
  rmSync(dir, { recursive: true, force: true });
  if (fail > 0) process.exit(1);
}

void main();
