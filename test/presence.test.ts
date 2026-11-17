import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createPresenceApi, createTeamsPresence } from '../plugin/presence.mjs';
import { HttpError } from '../src/http.ts';

const BOT = '8:live:.cid.synthetic';
const config = { channels: { 'teams-personal': { enabled: true } } };
const policy = { CHANNEL: 'teams-personal', BOT, validConfig: (a: any) => a.enabled === true };
const credential = (id = 'live:.cid.synthetic') => ({
  token: `test.${Buffer.from(JSON.stringify({ skypeid: id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.test`,
  expiresAt: Date.now() + 3600_000,
});
const defaults = () => ({ policy, currentConfig: () => config, getSkypeToken: async () => credential(),
  assertAuthority() {}, endpointId: '12345678-1234-1234-1234-123456789012' });

test('presence publishes/refreshes/removes only its own endpoint without forced status or messages', async () => {
  const calls: any[] = [];
  const api = createPresenceApi({ ...defaults(), fetcher: async (url: URL, init: any) => {
    calls.push({ url: url.href, method: init.method, body: init.body && JSON.parse(init.body) });
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers['X-Skypetoken'], credential().token);
    assert.equal(init.headers['x-ms-endpoint-id'], defaults().endpointId);
    return new Response(null, { status: 200 });
  } });
  const signal = new AbortController().signal;
  await api.publish(signal); await api.active(signal); await api.remove(signal);
  assert.deepEqual(calls, [
    { url: 'https://teams.live.com/ups/global/v1/me/endpoints/', method: 'PUT', body: {
      id: defaults().endpointId, availability: 'Available', activity: 'Available', deviceType: 'Web', activityReporting: 'Direct' } },
    { url: 'https://teams.live.com/ups/global/v1/me/reportmyactivity/', method: 'POST', body: { endpointId: defaults().endpointId, isActive: true } },
    { url: `https://teams.live.com/ups/global/v1/me/endpoints/${defaults().endpointId}`, method: 'DELETE', body: undefined },
  ]);
});

test('presence rechecks policy/identity after auth; disabled config permits only own cleanup', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return new Response(null, { status: 200 }); };
  let enabled = true;
  const api = createPresenceApi({ ...defaults(), fetcher,
    currentConfig: () => ({ channels: { 'teams-personal': { enabled } } }),
    getSkypeToken: async () => { enabled = false; return credential(); },
  });
  await assert.rejects(api.publish(new AbortController().signal), /no longer approved/);
  assert.equal(calls, 0);
  await api.remove(new AbortController().signal);
  assert.equal(calls, 1);
  const other = createPresenceApi({ ...defaults(), fetcher, getSkypeToken: async () => credential('live:other') });
  await assert.rejects(other.publish(new AbortController().signal), /does not match/);
  await assert.rejects(other.remove(new AbortController().signal), /does not match/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(other.publish(abort.signal), /abort/i);
  assert.equal(calls, 1);
});

test('presence follows connection, refreshes, cleans on disconnect/abort, and never resurrects', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls: string[] = [];
  const abort = new AbortController();
  const presence = createTeamsPresence({ signal: abort.signal, api: {
    publish: async () => { calls.push('publish'); }, active: async () => { calls.push('active'); },
    remove: async () => { calls.push('remove'); },
  } });
  t.after(() => presence.stop());
  await setImmediate(); assert.deepEqual(calls, []);
  presence.setConnected(true); presence.setConnected(true);
  await setImmediate(); assert.deepEqual(calls, ['publish']);
  t.mock.timers.tick(60_000); await setImmediate();
  assert.deepEqual(calls, ['publish', 'active']);
  presence.setConnected(false); await setImmediate();
  t.mock.timers.tick(120_000); await setImmediate();
  assert.deepEqual(calls, ['publish', 'active', 'remove']);
  presence.setConnected(true); await setImmediate();
  abort.abort(); await presence.stop();
  presence.setConnected(true); t.mock.timers.tick(120_000); await setImmediate();
  assert.deepEqual(calls, ['publish', 'active', 'remove', 'publish', 'remove']);
});

test('disconnect during a pending publish aborts it, reconciles unknown creation, then reconnects once', async () => {
  const abort = new AbortController();
  const calls: string[] = [];
  let first = true;
  const presence = createTeamsPresence({ signal: abort.signal, api: {
    publish: async (signal: AbortSignal) => {
      calls.push('publish');
      if (first) { first = false; await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }
    }, active: async () => { calls.push('active'); }, remove: async () => { calls.push('remove'); },
  } });
  presence.setConnected(true); await setImmediate();
  presence.setConnected(false); presence.setConnected(true); await setImmediate();
  assert.deepEqual(calls, ['publish', 'remove', 'publish']);
  await presence.stop();
  assert.deepEqual(calls, ['publish', 'remove', 'publish', 'remove']);
});

test('presence honors retry-after, recreates expired endpoints, and contains sanitized errors', async t => {
  const calls: string[] = [], warnings: string[] = [];
  const waits: { ms: number; resume: () => void }[] = [];
  let active = 0;
  const presence = createTeamsPresence({ signal: new AbortController().signal, log: { warn: (s: string) => warnings.push(s) },
    sleep: (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      waits.push({ ms, resume: () => { signal.removeEventListener('abort', onAbort); resolve(); } });
    }),
    api: { publish: async () => { calls.push('publish'); }, active: async () => {
      calls.push('active'); if (++active === 1) throw new HttpError(429, 180_000); throw new HttpError(404);
    }, remove: async () => { calls.push('remove'); } },
  });
  t.after(() => presence.stop());
  presence.setConnected(true); await setImmediate();
  assert.equal(waits[0].ms, 60_000); waits[0].resume(); await setImmediate();
  assert.equal(waits[1].ms, 180_000); waits[1].resume(); await setImmediate();
  assert.equal(waits[2].ms, 120_000); waits[2].resume(); await setImmediate();
  assert.deepEqual(calls, ['publish', 'active', 'active', 'publish']);
  await presence.stop();
  assert.deepEqual(warnings, ['Teams presence refresh failed (HTTP 429)', 'Teams presence refresh failed (HTTP 404)']);
});

test('fatal auth/cleanup failures do not spin, leak error text, or prevent shutdown', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const warnings: string[] = [];
  const presence = createTeamsPresence({ signal: new AbortController().signal, log: { warn: (s: string) => warnings.push(s) },
    api: { publish: async () => { calls++; throw new HttpError(403); }, active: async () => { calls++; },
      remove: async () => { throw new Error('secret-bearing remote error'); } },
  });
  presence.setConnected(true); await setImmediate();
  t.mock.timers.tick(600_000); await setImmediate();
  assert.equal(calls, 1);
  await presence.stop();
  assert.deepEqual(warnings, ['Teams presence refresh failed (HTTP 403)', 'Teams presence cleanup failed (Error)']);
});
