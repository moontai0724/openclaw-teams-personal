import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createTypingSender, createTeamsTyping } from '../plugin/typing.mjs';

const CHAT = '19:synthetic@thread.v2';
const BOT = '8:live:.cid.synthetic';
const config = { channels: { 'teams-personal': { enabled: true } } };
const policy = { CHANNEL: 'teams-personal', BOT,
  normalizedTarget: (id: string) => id.replace(/^teams-personal:/, ''),
  targetAllowed: (id: string) => id === CHAT,
  validConfig: (account: any) => account?.enabled === true,
};
const credential = (id = 'live:.cid.synthetic') => ({
  token: `test.${Buffer.from(JSON.stringify({ skypeid: id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.test`,
  expiresAt: Date.now() + 3600_000,
});
const defaults = () => ({ policy, currentConfig: () => config, getSkypeToken: async () => credential(),
  to: `teams-personal:${CHAT}`, assertAuthority() {}, signal: new AbortController().signal });

test('posts only the native ephemeral typing control to the exact approved chat', async () => {
  let calls = 0;
  await createTypingSender({ ...defaults(), fetcher: async (url: URL, init: RequestInit) => {
    calls++;
    assert.equal(url.href, `https://teams.live.com/api/chatsvc/consumer/v1/users/ME/conversations/${encodeURIComponent(CHAT)}/messages`);
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal((init.headers as any).Authentication, `skypetoken=${credential().token}`);
    assert.deepEqual(JSON.parse(init.body as string), { content: '', contenttype: 'Application/Message', messagetype: 'Control/Typing' });
    return new Response(null, { status: 201 });
  } })();
  assert.equal(calls, 1);
});

test('typing rechecks live policy after async authentication and rejects changed identity/aborts', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return new Response(null, { status: 201 }); };
  await assert.rejects(createTypingSender({ ...defaults(), to: '19:other@thread.v2', fetcher })(), /no longer approved/);
  let enabled = true;
  await assert.rejects(createTypingSender({ ...defaults(), fetcher,
    currentConfig: () => ({ channels: { 'teams-personal': { enabled } } }),
    getSkypeToken: async () => { enabled = false; return credential(); },
  })(), /no longer approved/);
  await assert.rejects(createTypingSender({ ...defaults(), fetcher, getSkypeToken: async () => credential('live:other') })(), /does not match/);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(createTypingSender({ ...defaults(), fetcher, signal: abort.signal })(), /abort/i);
  assert.equal(calls, 0);
});

test('typing has no immediate mutation retry on a rejected response', async () => {
  let calls = 0;
  await assert.rejects(createTypingSender({ ...defaults(), fetcher: async () => {
    calls++; return new Response(null, { status: 429 });
  } })(), /HTTP status 429/);
  assert.equal(calls, 1);
});

test('cleanup cancels in-flight typing and does not expose a credential-bearing error', async () => {
  const abort = new AbortController();
  let options: any;
  let cleanupCount = 0;
  const warnings: string[] = [];
  let activeSignal: AbortSignal | undefined;
  const typing = createTeamsTyping({ ...defaults(), signal: abort.signal,
    createTypingCallbacks: (params: any) => {
      options = params;
      return { onReplyStart() {}, onIdle() {}, onCleanup() { cleanupCount++; } };
    },
    log: { warn: (text: string) => warnings.push(text) },
    fetcher: async (_url: URL, init: RequestInit) => {
      activeSignal = init.signal!;
      return new Promise((_resolve, reject) => activeSignal!.addEventListener('abort', () => reject(activeSignal!.reason), { once: true }));
    },
  });
  options.onStartError(new Error(`secret:${credential().token}`));
  assert.deepEqual(warnings, ['Teams typing failed (Error)']);
  const pending = options.start();
  await setImmediate();
  abort.abort();
  await assert.rejects(pending, /abort/i);
  assert.equal(activeSignal?.aborted, true);
  assert.equal(cleanupCount, 1);
  await assert.rejects(options.start(), /abort/i);
  typing.cleanup();
});

// Exercise the actual host keepalive rather than copying its timer implementation.
test('host typing keeps refreshing, stops on idle/abort, and contains API failures', {
  skip: !process.env.TEAMS_TYPING_SDK,
}, async t => {
  const { createTypingCallbacks } = await import(pathToFileURL(process.env.TEAMS_TYPING_SDK!).href);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let calls = 0;
  const abort = new AbortController();
  const typing = createTeamsTyping({ ...defaults(), signal: abort.signal, createTypingCallbacks,
    fetcher: async () => { calls++; return new Response(null, { status: 201 }); },
  });
  await typing.callbacks.onReplyStart();
  await setImmediate();
  assert.equal(calls, 1);
  t.mock.timers.tick(4000);
  await setImmediate();
  assert.equal(calls, 2);
  typing.callbacks.onIdle();
  t.mock.timers.tick(12_000);
  await setImmediate();
  assert.equal(calls, 2);
  await typing.callbacks.onReplyStart();
  assert.equal(calls, 2);

  const failed = createTeamsTyping({ ...defaults(), signal: abort.signal, createTypingCallbacks,
    fetcher: async () => { calls++; return new Response(null, { status: 503 }); },
  });
  await failed.callbacks.onReplyStart();
  await setImmediate();
  t.mock.timers.tick(4000);
  await setImmediate();
  assert.equal(calls, 4);
  t.mock.timers.tick(20_000);
  await setImmediate();
  assert.equal(calls, 4); // Host circuit breaker after two failures.
  abort.abort();
  failed.cleanup();
});
