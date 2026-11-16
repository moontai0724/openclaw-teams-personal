import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/journal.ts';
import { repairHistory } from '../src/history.ts';
import { normalize } from '../src/messages.ts';

const scope = { chatId: '19:synthetic-group@thread.v2', expectedAccount: '8:live:.cid.synthetic' };
const start = Date.parse('2026-11-16T00:00:00Z');
const raw = (id: number) => ({ id: String(start + id), conversationid: scope.chatId, from: '8:orgid:synthetic-sender',
  messagetype: 'Text', content: `synthetic ${id}`, originalarrivaltime: new Date(start + id).toISOString(), properties: {} });
const auth = async () => ({ token: 'synthetic-not-a-real-token', expiresAt: Date.now() + 3600_000 });

test('journal serializes concurrent capture, survives reopening and refuses another scope', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teams-capture-test-'));
  const path = join(dir, 'capture.jsonl');
  const journal = await Journal.create(path, scope, start);
  const endpointId = journal.meta.endpointId;
  try {
    const message = normalize(raw(100), 'NewMessage', scope)!;
    assert.deepEqual(await Promise.all([journal.record(message, 'push'), journal.record(message, 'repair')]), [true, false]);
    await assert.rejects(Journal.create(path, scope), { code: 'EEXIST' });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await journal.close();
    const resumed = await Journal.create(path, scope);
    assert.equal(resumed.meta.endpointId, endpointId);
    assert.equal(await resumed.record(message, 'push'), false);
    await resumed.close();
    await assert.rejects(Journal.create(path, { ...scope, chatId: '19:other@thread.v2' }), /mismatch/);
    assert.equal((await readFile(path, 'utf8')).trim().split('\n').length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('incomplete journal tail is refused without silently replaying or deleting data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teams-tail-test-'));
  const path = join(dir, 'capture.jsonl');
  await writeFile(path, '{"partial":');
  try {
    await assert.rejects(Journal.create(path, scope), /incomplete tail/);
    assert.equal(await readFile(path, 'utf8'), '{"partial":');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('history overlap repairs a missing message without duplicating a push event', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teams-repair-test-'));
  const journal = await Journal.create(join(dir, 'capture.jsonl'), scope, start);
  try {
    await journal.record(normalize(raw(200), 'NewMessage', scope)!, 'push');
    let calls = 0;
    const fetcher = async (url: URL) => {
      calls++;
      assert.equal(decodeURIComponent(url.pathname.split('/conversations/')[1].split('/')[0]), scope.chatId);
      return Response.json({ messages: [raw(200), raw(100), { ...raw(150), conversationid: '19:unapproved@thread.v2' }, raw(-1)] });
    };
    assert.deepEqual(await repairHistory({ fetch: fetcher as typeof fetch, auth, journal }, new AbortController().signal, start + 1000), { pages: 1, recovered: 1 });
    assert.equal(calls, 1);
    assert.equal(journal.cursor, start + 1000);
    assert.equal(journal.keys.size, 2);
  } finally { await journal.close(); await rm(dir, { recursive: true, force: true }); }
});

test('pagination crossing another group is rejected before another authenticated request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teams-page-test-'));
  const journal = await Journal.create(join(dir, 'capture.jsonl'), scope, start);
  let calls = 0;
  try {
    const fetcher = async () => {
      calls++;
      return Response.json({ messages: [raw(200)], _metadata: { backwardLink: 'https://teams.live.com/api/chatsvc/consumer/v1/users/ME/conversations/19:other@thread.v2/messages' } });
    };
    await assert.rejects(repairHistory({ fetch: fetcher as typeof fetch, auth, journal }, new AbortController().signal, start + 1000), /boundary/);
    assert.equal(calls, 1);
    assert.equal(journal.cursor, start);
  } finally { await journal.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a five-page gap is explicit and never advances the repair checkpoint', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teams-gap-test-'));
  const journal = await Journal.create(join(dir, 'capture.jsonl'), scope, start);
  let calls = 0;
  try {
    const fetcher = async (url: URL) => {
      calls++;
      return Response.json({ messages: [raw(calls)], _metadata: { backwardLink: url.href } });
    };
    await assert.rejects(repairHistory({ fetch: fetcher as typeof fetch, auth, journal }, new AbortController().signal, start + 1000), /exceeds five pages/);
    assert.equal(calls, 5);
    assert.equal(journal.cursor, start);
  } finally { await journal.close(); await rm(dir, { recursive: true, force: true }); }
});
