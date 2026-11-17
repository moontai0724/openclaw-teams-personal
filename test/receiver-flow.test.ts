import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReceiver } from '../plugin/receiver.mjs';
import { eventFrame } from '../src/protocol.ts';
import { createScopedPolicy } from '../plugin/enrollment.mjs';

test('additional DM recovery preserves old fences, rejects pre-activation/spoofed traffic and isolates private quotes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teams-dm-receiver-'));
  const controller = new AbortController();
  const bot = '8:live:.cid.synthetic';
  const owner = '8:orgid:synthetic-owner';
  const member = '8:live:.cid.synthetic-member';
  const group = '19:synthetic-group@thread.v2';
  const primary = '19:uni01_owner@thread.v2';
  const dm = '19:uni01_member@thread.v2';
  const unknown = '19:uni01_unknown@thread.v2';
  const time = Date.now();
  const base = { CHANNEL: 'teams-personal', CHAT: primary, GROUP: group, GROUPS: [group], BOT: bot, SENDER: owner,
    validConfig: (a: any) => a?.enabled === true, normalizedTarget: (id: string) => id,
    admitted: (m: any) => m.conversationId === primary && m.fromId === owner,
    groupAdmitted: () => false,
  };
  const cfg: any = { channels: { 'teams-personal': { enabled: true,
    dms: { [dm]: { allowFrom: [member], activatedAt: time } } } } };
  const policy = createScopedPolicy(base, () => cfg);
  const raw = (chat: string, offset: number, from: string, content: string) => ({
    id: String(time + offset), version: String(time + offset), conversationid: chat, from,
    imdisplayname: 'Synthetic peer', originalarrivaltime: new Date(time + offset).toISOString(),
    content, messagetype: 'Text', properties: {},
  });
  const prior = { baseline: String(time - 1000), since: time - 2000, repairedThrough: time - 1000 };
  const initial = { version: 1, endpointId: '12345678-1234-1234-1234-123456789abc', bot,
    chats: { [primary]: { ...prior }, [group]: { ...prior } } };
  await writeFile(join(root, 'realtime-state.json'), JSON.stringify(initial));
  const admitted: any[] = [];
  const reads: string[] = [];
  const stages: unknown[] = [];
  let pushed = false;
  class Socket extends EventTarget {
    readyState = 1;
    send(_value: string) {}
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
    receive(value: string) { this.dispatchEvent(new MessageEvent('message', { data: value })); }
    deliver(resource: unknown) { this.receive(`3:::${JSON.stringify({ id: 1, url: '/v4/f/synthetic/messaging',
      body: JSON.stringify({ resourceType: 'NewMessage', resource }) })}`); }
  }
  const socket = new Socket();
  const token = `header.${Buffer.from(JSON.stringify({ skypeid: 'live:.cid.synthetic' })).toString('base64url')}.signature`;
  const timer = setTimeout(() => controller.abort(new Error('DM receiver test deadline')), 4000);
  try {
    await runReceiver({ stateDir: root, policy, signal: controller.signal,
      authProvider: async () => ({ token, expiresAt: Date.now() + 3600_000 }),
      assertAuthority() {}, status() {},
      makeSocket: () => { setImmediate(() => {
        socket.receive('1::');
        socket.receive(eventFrame('trouter.connected', [{ surl: 'https://trouter2-test.trouter.teams.microsoft.com/v4/f/synthetic/', ttl: 3600 }]));
      }); return socket; },
      fetcher: async (url: URL, init: any) => {
        if (init?.method === 'POST') return new Response(null, { status: 201 });
        const chat = decodeURIComponent(/conversations\/([^/]+)/.exec(url.pathname)![1]);
        reads.push(chat);
        return Response.json({ messages: chat === primary ? [raw(primary, -1500, owner, 'owner private history')]
          : chat === dm ? [raw(dm, -500, member, 'before approval')] : [] });
      },
      log: (name: string, data: unknown) => {
        stages.push([name, data]);
        if (name !== 'scoped_history_repaired' || pushed) return;
        pushed = true;
        socket.deliver(raw(unknown, 1, member, 'unapproved DM'));
        socket.deliver(raw(dm, 2, owner, 'wrong DM peer'));
        socket.deliver(raw(dm, -1, member, 'pre-activation push'));
        socket.deliver({ ...raw(dm, 3, member, 'approved DM request'), properties: { qtdMsgs: [{ messageId: String(time - 1500) }] } });
      },
      admit: async (message: any) => {
        admitted.push(message);
        cfg.channels['teams-personal'].dms[dm].enabled = false;
        socket.deliver(raw(dm, 4, member, 'revoked DM request'));
        setImmediate(() => controller.abort());
      },
    });
    assert.equal(admitted.length, 1, JSON.stringify(stages));
    assert.equal(admitted[0].conversationId, dm);
    assert.equal(admitted[0].fromId, member);
    assert.equal(admitted[0].text, 'approved DM request');
    assert.equal(admitted[0].history, undefined);
    assert.equal(admitted[0].quote.id, String(time - 1500));
    assert.equal(admitted[0].quote.body, '');
    assert.equal(JSON.stringify(admitted).includes('owner private history'), false);
    assert.equal(reads.includes(unknown), false);
    const state = JSON.parse(await readFile(join(root, 'realtime-state.json'), 'utf8'));
    assert.equal(state.endpointId, initial.endpointId);
    for (const chat of [primary, group]) {
      assert.equal(state.chats[chat].baseline, prior.baseline);
      assert.equal(state.chats[chat].since, prior.since);
    }
    assert.equal(state.chats[dm].baseline, String(time));
    assert.equal(state.chats[dm].since, time);
    await runReceiver({ stateDir: root, policy, signal: AbortSignal.abort(), assertAuthority() {}, status() {}, log() {},
      authProvider: async () => { throw new Error('Revoked restart must not need auth'); },
      fetcher: async () => { throw new Error('Revoked restart must not fetch history'); },
      makeSocket: () => { throw new Error('Aborted restart must not connect'); },
    });
    assert.deepEqual(JSON.parse(await readFile(join(root, 'realtime-state.json'), 'utf8')), state);
  } finally { clearTimeout(timer); controller.abort(); await rm(root, { recursive: true, force: true }); }
});

for (const migration of ['legacy', 'existing']) test(`adding a group preserves old cursors, fences old requests and isolates context (${migration} state)`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'teams-receiver-flow-'));
  const controller = new AbortController();
  const bot = '8:live:.cid.synthetic';
  const user = '8:orgid:synthetic-user';
  const group = '19:synthetic-group@thread.v2';
  const newGroup = '19:synthetic-new@thread.v2';
  const dm = '19:uni01_synthetic@thread.v2';
  const base = Date.now();
  const make = (offset: number, content: string, mention = false) => ({ id: String(base + offset), version: String(base + offset),
    conversationid: group, from: user, imdisplayname: 'Synthetic user', messagetype: 'Text', content,
    originalarrivaltime: new Date(base + offset).toISOString(), properties: { mentions: mention ? [{ mri: bot }] : [] } });
  const old = make(0, 'already processed');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'watermark.json'), JSON.stringify({ since: base - 1000, lastId: String(base), group: { since: base - 1000, lastId: String(base) } }));
  const initial = { version: 1, endpointId: '12345678-1234-1234-1234-123456789abc', bot,
    chats: { [dm]: { baseline: String(base), since: base - 1000, repairedThrough: base - 500 },
      [group]: { baseline: String(base), since: base - 1000, repairedThrough: base - 500 } } };
  if (migration === 'existing') await writeFile(join(root, 'realtime-state.json'), JSON.stringify(initial));
  const newGroupOldRequest = { ...make(-500, 'old new-group request', true), conversationid: newGroup };
  const token = `header.${Buffer.from(JSON.stringify({ skypeid: 'live:.cid.synthetic' })).toString('base64url')}.signature`;
  const admitted: any[] = [];
  class Socket extends EventTarget {
    readyState = 1;
    sent: string[] = [];
    send(value: string) { this.sent.push(value); }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
    receive(value: string) { this.dispatchEvent(new MessageEvent('message', { data: value })); }
    deliver(resource: unknown, resourceType = 'NewMessage') {
      this.receive(`3:::${JSON.stringify({ id: this.sent.length, url: '/v4/f/synthetic/messaging', body: JSON.stringify({ resourceType, resource }) })}`);
    }
  }
  const socket = new Socket();
  let sentEvents = false;
  const run = runReceiver({ stateDir: root, signal: controller.signal,
    authProvider: async () => ({ token, expiresAt: Date.now() + 3600_000 }),
    assertAuthority() {}, status() {},
    policy: { CHAT: dm, GROUP: group, GROUPS: [group, newGroup], BOT: bot, SENDER: user,
      admitted: (message: any) => message.conversationId === dm && message.fromId === user,
      groupAdmitted: (message: any) => [group, newGroup].includes(message.conversationId) && message.mentions.some((item: any) => item.mri === bot),
    },
    makeSocket: () => { setImmediate(() => { socket.receive('1::'); socket.receive(eventFrame('trouter.connected', [{ surl: 'https://trouter2-test.trouter.teams.microsoft.com/v4/f/synthetic/', ttl: 3600 }])); }); return socket; },
    fetcher: async (url: URL, init: any) => init?.method === 'POST'
      ? new Response(null, { status: 201 })
      : Response.json({ messages: decodeURIComponent(url.pathname).includes(group) ? [old] : decodeURIComponent(url.pathname).includes(newGroup) ? [newGroupOldRequest] : [] }),
    log: (name: string) => {
      if (name !== 'scoped_history_repaired' || sentEvents) return;
      sentEvents = true;
      socket.deliver(make(1, 'ordinary context'));
      socket.deliver(make(2, 'first request', true));
      socket.deliver({ ...make(1, 'edited context'), version: String(base + 10) }, 'MessageUpdate');
      socket.deliver(make(3, 'second request', true));
      socket.deliver({ ...make(10000, 'unapproved context', true), conversationid: '19:unapproved@thread.v2' });
      socket.deliver({ ...make(10001, 'new-group context'), conversationid: newGroup });
      socket.deliver({ ...make(10002, 'new-group request', true), conversationid: newGroup });
    },
    admit: async (message: unknown) => { admitted.push(message); if (admitted.length === 3) setImmediate(() => controller.abort()); },
  });
  try {
    await run;
    assert.equal(admitted.length, 3);
    assert.equal(admitted[0].history.some((item: any) => item.body === 'ordinary context'), true);
    assert.equal(admitted[1].history.some((item: any) => item.body === 'edited context'), true);
    assert.equal(admitted[1].history.some((item: any) => item.body === 'ordinary context'), false);
    assert.equal(admitted[2].conversationId, newGroup);
    assert.deepEqual(admitted[2].history.map((item: any) => item.body), ['old new-group request', 'new-group context']);
    assert.equal(admitted.slice(0, 2).every(message => message.conversationId === group), true);
    const state = JSON.parse(await readFile(join(root, 'realtime-state.json'), 'utf8'));
    if (migration === 'existing') assert.equal(state.endpointId, initial.endpointId);
    assert.deepEqual(Object.keys(state.chats).sort(), [dm, group, newGroup].sort());
    for (const chat of [dm, group]) {
      assert.equal(state.chats[chat].baseline, initial.chats[chat].baseline);
      assert.equal(state.chats[chat].since, initial.chats[chat].since);
    }
    assert.ok(state.chats[newGroup].since >= base);
    assert.equal(state.chats[newGroup].baseline, String(state.chats[newGroup].since));
  } finally { controller.abort(); await rm(root, { recursive: true, force: true }); }
});

const corePath = process.env.TEAMS_ENROLLMENT_CORE;
test('owner push enrolls before rejection, admits the first tag, excludes old turns after restart and honors room revocation', { skip: !corePath }, async () => {
  const { createScopedPolicy, createOwnerEnrollment } = await import('../plugin/enrollment.mjs');
  const { enrollOwnerGroup } = await import(corePath!);
  const root = await mkdtemp(join(tmpdir(), 'teams-owner-enrollment-'));
  const bot = '8:live:.cid.synthetic';
  const owner = '8:orgid:synthetic-owner';
  const group = '19:synthetic-group@thread.v2';
  const fresh = '19:synthetic-fresh@thread.v2';
  const dm = '19:uni01_synthetic@thread.v2';
  const time = Date.now() + 1000;
  const raw = (offset: number, from = owner, mentions = true) => ({ id: String(time + offset),
    conversationid: fresh, from, content: 'synthetic', messagetype: 'RichText/Html',
    originalarrivaltime: new Date(time + offset).toISOString(), properties: { mentions: mentions ? [{ mri: bot }] : [] } });
  const base = { CHANNEL: 'teams-personal', CHAT: dm, GROUP: group, GROUPS: [group], BOT: bot, SENDER: owner,
    validConfig: (a: any) => a?.enabled === true, normalizedTarget: (s: string) => s,
    admitted: (m: any) => m.conversationId === dm && m.fromId === owner,
    groupAdmitted: (m: any) => m.conversationId === group && m.fromId !== bot && m.mentions.some((x: any) => x.mri === bot),
  };
  const cfg: any = { channels: { 'teams-personal': { enabled: true, enrollmentOwnerId: owner,
    groups: { [group]: { requireMention: true, allowFrom: ['*'] } } } } };
  const policy = createScopedPolicy(base, () => cfg);
  const token = `header.${Buffer.from(JSON.stringify({ skypeid: 'live:.cid.synthetic' })).toString('base64url')}.signature`;
  const admitted: any[] = [];
  let writes = 0;
  const enrollment = createOwnerEnrollment({ policy: base, current: () => cfg, sharedEnroll: enrollOwnerGroup,
    assertAuthority() {}, mutate: async (options: any) => { options.writeOptions.assertCurrent(); const result = options.mutate(cfg); writes++; return { result }; },
  });
  await writeFile(join(root, 'watermark.json'), JSON.stringify({ since: time - 5000, lastId: String(time - 5000),
    group: { since: time - 5000, lastId: String(time - 5000) } }));
  const run = async (phase: number) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    let emitted = false;
    class Socket extends EventTarget {
      readyState = 1;
      send() {}
      close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
      receive(data: string) { this.dispatchEvent(new MessageEvent('message', { data })); }
      deliver(resource: any, resourceType = 'NewMessage') { this.receive(`3:::${JSON.stringify({ id: Number(resource.id), url: '/v4/f/synthetic/messaging', body: JSON.stringify({ resourceType, resource }) })}`); }
    }
    const socket = new Socket();
    try {
      await runReceiver({ policy, enroll: enrollment, stateDir: root, signal: controller.signal,
        authProvider: async () => ({ token, expiresAt: Date.now() + 3600_000 }), assertAuthority() {}, status() {},
        fetcher: async (url: URL, init: any) => init?.method === 'POST' ? new Response(null, { status: 201 }) :
          Response.json({ messages: phase === 2 && decodeURIComponent(url.pathname).includes(fresh) ? [raw(-100), raw(3)] : [] }),
        makeSocket: () => { setImmediate(() => { socket.receive('1::'); socket.receive(eventFrame('trouter.connected', [{ surl: 'https://trouter2-test.trouter.teams.microsoft.com/v4/f/synthetic/', ttl: 3600 }])); }); return socket; },
        log: (event: string) => {
          if (event !== 'scoped_history_repaired' || emitted) return;
          emitted = true;
          if (phase === 2) { controller.abort(); return; }
          socket.deliver(raw(0, '8:orgid:other')); // Someone else's tag cannot enroll.
          socket.deliver(raw(1, owner, false)); // Owner speech alone cannot enroll.
          socket.deliver(raw(2), 'MessageUpdate'); // Edits cannot enroll.
          socket.deliver(raw(3));
          socket.deliver(raw(4, '8:orgid:member'));
        },
        admit: async (message: any) => {
          admitted.push(message);
          if (phase === 1 && admitted.length === 2) setImmediate(() => controller.abort());
        },
      });
    } finally { clearTimeout(timeout); controller.abort(); }
  };
  try {
    await run(1);
    assert.equal(writes, 1);
    assert.deepEqual(admitted.map(m => m.id), [String(time + 3), String(time + 4)]);
    assert.equal(admitted[0].history.length, 0); // Rejected pre-enrollment content was not cached.
    const firstState = JSON.parse(await readFile(join(root, 'realtime-state.json'), 'utf8'));
    assert.equal(firstState.chats[fresh].baseline, String(time + 2));
    await run(2);
    assert.equal(admitted.at(-1).id, String(time + 3)); // Queue, not transport, owns durable dedup.
    assert.equal(admitted.some(m => m.id === String(time - 100)), false);
    const secondState = JSON.parse(await readFile(join(root, 'realtime-state.json'), 'utf8'));
    assert.equal(secondState.endpointId, firstState.endpointId);
    assert.equal(secondState.chats[group].baseline, firstState.chats[group].baseline);
    cfg.channels['teams-personal'].groups[fresh].enabled = false;
    await run(2); // A revoked room's checkpoint is retained without history fetch/dispatch.
    assert.equal(admitted.length, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});
