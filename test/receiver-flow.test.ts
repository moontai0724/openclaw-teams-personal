import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReceiver } from '../plugin/receiver.mjs';
import { eventFrame } from '../src/protocol.ts';

test('receiver migration, ordinary context, edit refresh and mention dispatch run through one wire flow', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teams-receiver-flow-'));
  const controller = new AbortController();
  const bot = '8:live:.cid.synthetic';
  const user = '8:orgid:synthetic-user';
  const group = '19:synthetic-group@thread.v2';
  const dm = '19:uni01_synthetic@thread.v2';
  const base = Date.now();
  const make = (offset: number, content: string, mention = false) => ({ id: String(base + offset), version: String(base + offset),
    conversationid: group, from: user, imdisplayname: 'Synthetic user', messagetype: 'Text', content,
    originalarrivaltime: new Date(base + offset).toISOString(), properties: { mentions: mention ? [{ mri: bot }] : [] } });
  const old = make(0, 'already processed');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'watermark.json'), JSON.stringify({ since: base - 1000, lastId: String(base), group: { since: base - 1000, lastId: String(base) } }));
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
    policy: { CHAT: dm, GROUP: group, BOT: bot, SENDER: user,
      admitted: (message: any) => message.conversationId === dm && message.fromId === user,
      groupAdmitted: (message: any) => message.conversationId === group && message.mentions.some((item: any) => item.mri === bot),
    },
    makeSocket: () => { setImmediate(() => { socket.receive('1::'); socket.receive(eventFrame('trouter.connected', [{ surl: 'https://trouter2-test.trouter.teams.microsoft.com/v4/f/synthetic/', ttl: 3600 }])); }); return socket; },
    fetcher: async (url: URL, init: any) => init?.method === 'POST'
      ? new Response(null, { status: 201 })
      : Response.json({ messages: decodeURIComponent(url.pathname).includes(group) ? [old] : [] }),
    log: (name: string) => {
      if (name !== 'scoped_history_repaired' || sentEvents) return;
      sentEvents = true;
      socket.deliver(make(1, 'ordinary context'));
      socket.deliver(make(2, 'first request', true));
      socket.deliver({ ...make(1, 'edited context'), version: String(base + 10) }, 'MessageUpdate');
      socket.deliver(make(3, 'second request', true));
    },
    admit: async (message: unknown) => { admitted.push(message); if (admitted.length === 2) setImmediate(() => controller.abort()); },
  });
  try {
    await run;
    assert.equal(admitted.length, 2);
    assert.equal(admitted[0].history.some((item: any) => item.body === 'ordinary context'), true);
    assert.equal(admitted[1].history.some((item: any) => item.body === 'edited context'), true);
    assert.equal(admitted[1].history.some((item: any) => item.body === 'ordinary context'), false);
  } finally { controller.abort(); await rm(root, { recursive: true, force: true }); }
});
