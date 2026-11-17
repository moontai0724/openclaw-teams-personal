import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAccount, createCredentialStore, createMicrosoftAuth } from '../src/account.mjs';

test('encrypted store round-trips privately, atomically replaces and reports corrupt data without contents', t => {
  const directory = mkdtempSync(join(tmpdir(), 'teams-auth-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = createCredentialStore({ directory, seed: 'synthetic-seed' });
  assert.deepEqual(store.read(), {});
  store.write({ refreshToken: 'synthetic-refresh' });
  assert.equal(statSync(join(directory, 'tokens.enc')).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(directory, 'tokens.enc')).includes(Buffer.from('synthetic-refresh')), false);
  assert.equal(store.read().refreshToken, 'synthetic-refresh');
  store.write({ refreshToken: 'synthetic-rotation' });
  assert.equal(store.read().refreshToken, 'synthetic-rotation');
  writeFileSync(join(directory, 'tokens.enc'), 'corrupt-secret');
  assert.throws(() => store.read(), error => /cannot be decrypted/.test(error.message) && !error.message.includes('secret'));
});

test('account serializes refresh rotation across chat/Graph and caches concurrent requests', async () => {
  let state = { refreshToken: 'r0' };
  const rotations: unknown[] = [];
  const provider = createAccount({ store: { read: () => state, write: (next: any) => { state = next; } }, microsoft: {
    refresh: async (previous: string, graph: boolean) => {
      rotations.push([previous, graph]);
      await new Promise(resolve => setImmediate(resolve));
      return { token: graph ? 'graph' : 'chat', expiresAt: Date.now() + 3600_000, refreshToken: graph ? 'r2' : 'r1' };
    },
  } });
  const results = await Promise.all([provider.getSkypeToken(), provider.getSkypeToken(), provider.getGraphToken()]);
  assert.equal(results[0].token, 'chat'); assert.equal(results[2], 'graph');
  assert.deepEqual(rotations, [['r0', false], ['r1', true]]);
  assert.equal(state.refreshToken, 'r2');
});

test('changed account identity cannot rotate the stored credential', async () => {
  let writes = 0;
  const provider = createAccount({ expectedAccount: '8:live:approved', store: {
    read: () => ({ refreshToken: 'synthetic' }), write: () => { writes++; },
  }, microsoft: { refresh: async () => ({ token: `x.${Buffer.from(JSON.stringify({ skypeid: 'live:wrong' })).toString('base64url')}.x`,
    expiresAt: Date.now() + 3600_000, refreshToken: 'must-not-store' }) } });
  await assert.rejects(provider.getSkypeToken(), /does not match/);
  assert.equal(writes, 0);
});

test('Microsoft auth uses bounded no-redirect requests and sanitized errors', async () => {
  let step = 0;
  const api = createMicrosoftAuth({ fetcher: async (url: string, options: any) => {
    assert.equal(options.redirect, 'error'); assert.ok(options.signal);
    if (++step === 1) { assert.match(options.body, /grant_type=refresh_token/); return Response.json({ access_token: 'synthetic-access', refresh_token: 'rotated' }); }
    assert.equal(options.headers.Authorization, 'Bearer synthetic-access');
    return Response.json({ tokens: { skypeToken: 'synthetic-chat', expiresIn: 3600 } });
  } });
  assert.equal((await api.refresh('synthetic-refresh', false)).refreshToken, 'rotated');
  const refused = createMicrosoftAuth({ fetcher: async () => Response.json({ error_description: 'secret-bearing-error' }, { status: 403 }) });
  await assert.rejects(refused.refresh('synthetic', false), error => error.message.includes('403') && !error.message.includes('secret'));
});
