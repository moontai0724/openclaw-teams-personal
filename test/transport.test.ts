import assert from 'node:assert/strict';
import test from 'node:test';
import { listen, type Socket } from '../src/transport.ts';
import { checkCredential, IdentityError } from '../src/auth.ts';
import { eventFrame } from '../src/protocol.ts';

class FakeSocket extends EventTarget {
  readyState = 1;
  sent: string[] = [];
  receive(value: string) { this.dispatchEvent(new MessageEvent('message', { data: value })); }
  send(value: string) { this.sent.push(value); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}
const options = { endpointId: 'synthetic-endpoint', registrar: 'https://teams.microsoft.com/registrar/prod/v2/registrations' };
const auth = async () => ({ token: 'synthetic-token-not-a-credential', expiresAt: Date.now() + 3600_000 });
const route = { surl: 'https://trouter2-test.trouter.teams.microsoft.com/v4/f/synthetic/', ttl: 3600 };

test('refuses unexpected credential identity and expired credentials without logging token data', () => {
  const token = `header.${Buffer.from(JSON.stringify({ skypeid: 'live:.cid.synthetic', exp: Date.now() / 1000 + 3600 })).toString('base64url')}.signature`;
  assert.equal(checkCredential({ token }, '8:live:.cid.synthetic').token, token);
  assert.throws(() => checkCredential({ token }, '8:live:.cid.other'), IdentityError);
  assert.throws(() => checkCredential({ token, expiresAt: 0 }, '8:live:.cid.synthetic'), IdentityError);
});

test('waits for authenticated route before registration, durably processes before ACK', async () => {
  const controller = new AbortController();
  const socket = new FakeSocket();
  const events: string[] = [];
  let captured = false;
  const run = listen({ auth, socket: () => socket as Socket,
    fetch: (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.transports.TROUTER[0].path, route.surl);
      assert.equal(body.clientDescription.templateKey, 'TeamsCDLWebWorker_2.7');
      assert.equal(init?.redirect, 'error');
      assert.equal(events.includes('authenticated'), true);
      return new Response(null, { status: 201 });
    }) as typeof fetch,
    onReady: async () => {
      socket.receive(`3:::${JSON.stringify({ id: 7, url: '/v4/f/synthetic/messaging', body: '{"resourceType":"NewMessage"}' })}`);
    },
    onBody: async () => {
      assert.equal(socket.sent.some((value) => value.includes('"status":200')), false);
      captured = true;
      setImmediate(() => controller.abort());
    },
    onLoss: async () => {}, log: (event) => { events.push(event); },
  }, options, controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  socket.receive('1::');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.includes('registered'), false);
  assert.match(socket.sent[0], /user.authenticate/);
  socket.receive(eventFrame('trouter.connected', [route]));
  await run;
  assert.equal(captured, true);
  assert.equal(events.includes('registered'), true);
  assert.equal(socket.sent.some((value) => value.includes('"id":7,"status":200')), true);
});

test('failed registration never reports ready and logs no raw server response', async () => {
  const controller = new AbortController();
  const socket = new FakeSocket();
  const events: string[] = [];
  let ready = false;
  const run = listen({ auth, socket: () => socket as Socket,
    fetch: (async () => new Response('sensitive-server-response', { status: 403 })) as typeof fetch,
    onReady: async () => { ready = true; }, onBody: async () => {}, onLoss: async () => {},
    log: (event, data) => { events.push(JSON.stringify({ event, data })); if (event === 'session_failed') controller.abort(); },
  }, options, controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  socket.receive('1::');
  socket.receive(eventFrame('trouter.connected', [route]));
  await run;
  assert.equal(ready, false);
  assert.equal(events.some((event) => event.includes('sensitive-server-response')), false);
});

test('message-loss requests repair before confirming processed indicators', async () => {
  const controller = new AbortController();
  const socket = new FakeSocket();
  let repaired = false;
  const run = listen({ auth, socket: () => socket as Socket,
    fetch: (async () => new Response(null, { status: 201 })) as typeof fetch,
    onReady: async () => { socket.receive(eventFrame('trouter.message_loss', [{ droppedIndicators: ['synthetic'] }])); },
    onBody: async () => {}, onLoss: async () => { repaired = true; setImmediate(() => controller.abort()); }, log: () => {},
  }, options, controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  socket.receive('1::');
  socket.receive(eventFrame('trouter.connected', [route]));
  await run;
  assert.equal(repaired, true);
  assert.equal(socket.sent.some((value) => value.includes('trouter.processed_message_loss')), true);
});

test('socket closure reconnects with the same endpoint and repairs each authenticated session', async () => {
  const controller = new AbortController();
  const sockets: FakeSocket[] = [];
  let repaired = 0;
  const registrations: string[] = [];
  const run = listen({ auth,
    socket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      setImmediate(() => { socket.receive('1::'); socket.receive(eventFrame('trouter.connected', [route])); });
      return socket as Socket;
    },
    fetch: (async (_url, init) => { registrations.push(JSON.parse(String(init?.body)).registrationId); return new Response(null, { status: 201 }); }) as typeof fetch,
    onReady: async () => { repaired++; setImmediate(() => { if (repaired === 1) sockets[0].close(); else controller.abort(); }); },
    onBody: async () => {}, onLoss: async () => {}, log: () => {},
  }, options, controller.signal);
  await run;
  assert.equal(sockets.length, 2);
  assert.equal(repaired, 2);
  assert.deepEqual(registrations, [options.endpointId, options.endpointId]);
});

test('stopped registration cannot report connected or start recovery after a late HTTP completion', async (t) => {
  // Abort can win after HTTP headers arrive but before response cleanup completes.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  const socket = new FakeSocket();
  const events: string[] = [];
  let ready = false;
  const run = listen({ auth, socket: () => socket,
    fetch: (async () => new Response(new ReadableStream({
      cancel() { controller.abort(); },
    }), { status: 201 })) as typeof fetch,
    onReady: async () => { ready = true; }, onBody: async () => {}, onLoss: async () => {},
    log: event => { events.push(event); },
  }, options, controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  socket.receive('1::');
  socket.receive(eventFrame('trouter.connected', [route]));
  await run;
  assert.equal(socket.readyState, 3);
  assert.equal(ready, false);
  assert.equal(events.includes('registered'), false);
  assert.equal(events.includes('registration_renewed'), false);
});
