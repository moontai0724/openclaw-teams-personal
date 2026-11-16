import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { parseFrame, eventFrame, requestAck, decodeBody, connectedRoute, registration, trustedUrl } from '../src/protocol.ts';

test('Socket.IO 0.9 framing preserves event acknowledgements and multiline content', () => {
  assert.deepEqual(parseFrame('1::'), { type: '1', id: '', wantsAck: false, data: '' });
  assert.equal(parseFrame('5:19+::{"name":"trouter.connected"}').wantsAck, true);
  assert.equal(parseFrame('3:::{"body":"a:b"}').data, '{"body":"a:b"}');
  assert.equal(parseFrame(eventFrame('ping')).type, '5');
  assert.equal(JSON.parse(parseFrame(requestAck(42)).data).status, 200);
  for (const input of ['42["modern"]', '3::/other:{}', 'garbage', '3:::' + 'a'.repeat(1_048_577)]) assert.throws(() => parseFrame(input));
});

test('decodes gzip and nested cp/gp without unbounded decompression', () => {
  const value = { resourceType: 'NewMessage', resource: { id: '123' } };
  const encoded = gzipSync(JSON.stringify(value)).toString('base64');
  assert.deepEqual(decodeBody({ 'x-microsoft-skype-content-encoding': 'gzip' }, encoded), value);
  assert.deepEqual(decodeBody({}, JSON.stringify({ cp: encoded })), value);
  assert.deepEqual(decodeBody({}, JSON.stringify({ gp: Buffer.from(JSON.stringify(value)).toString('base64') })), value);
  assert.throws(() => decodeBody({}, JSON.stringify({ cp: gzipSync('x'.repeat(2_000_000)).toString('base64') })));
});

test('registration uses the authenticated connected route and bounded TTL', () => {
  const route = connectedRoute({ surl: 'https://trouter2-test.trouter.teams.microsoft.com/v4/f/synthetic/', ttl: '7200' });
  assert.equal(registration('endpoint-test', route).transports.TROUTER[0].ttl, 3600);
  assert.equal(registration('endpoint-test', route).registrationId, 'endpoint-test');
  assert.throws(() => connectedRoute({ surl: 'https://evil.example/v4/f/test/', ttl: 3600 }));
  assert.throws(() => connectedRoute({ surl: route.path, ttl: 0 }));
});

test('credentials cannot be sent to arbitrary hosts or endpoint paths', () => {
  assert.equal(trustedUrl('https://edge.skype.com/registrar/prod/v2/registrations', 'registrar').hostname, 'edge.skype.com');
  for (const url of ['https://evil.example/registrar/prod/v2/registrations', 'https://teams.microsoft.com/other', 'https://user:pass@teams.microsoft.com/registrar/prod/v2/registrations']) {
    assert.throws(() => trustedUrl(url, 'registrar'));
  }
});
