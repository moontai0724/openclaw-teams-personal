import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeamsClient, composeText, attachmentList, trustedDownload } from '../src/client.mjs';

const chat = '19:synthetic@thread.v2';
const bot = '8:live:synthetic';
const id = '1794800000001';
const auth = async () => ({ token: `x.${Buffer.from(JSON.stringify({ skypeid: 'live:synthetic' })).toString('base64url')}.x`, expiresAt: Date.now() + 3600_000 });
function fixture({ lost = false, otherOwner = false, redirected = false } = {}) {
  const messages: any[] = [];
  const writes: any[] = [];
  let revoked = false;
  const client = createTeamsClient(auth, { expectedAccount: bot,
    assertChat: (value: string) => { if (value !== chat || revoked) throw new Error('scope'); },
    fetcher: async (input: URL, options: any) => {
      assert.equal(options.redirect, 'error');
      const body = options.body && JSON.parse(options.body);
      if (options.method === 'POST') {
        writes.push(body); messages.unshift({ ...body, id, conversationid: chat, from: bot });
        if (lost) throw new Error('synthetic connection lost');
        return Response.json({ OriginalArrivalTime: id });
      }
      if (options.method === 'PUT') { writes.push(body); Object.assign(messages[0], body); return new Response(null, { status: 204 }); }
      if (options.method === 'DELETE') { writes.push('delete'); messages[0].properties = { deletetime: 'now' }; return new Response(null, { status: 204 }); }
      if (input.pathname.endsWith('/messages')) return Response.json({ messages, ...(redirected ? { _metadata: { backwardLink: 'https://evil.example/messages' } } : {}) });
      return Response.json(messages[0] || { id, conversationid: chat, from: otherOwner ? '8:live:other' : bot, content: 'original' });
    },
  });
  return { client, messages, writes, revoke: () => { revoked = true; } };
}

test('send escapes content, keeps explicit mentions, and reconciles a lost response without a second POST', async () => {
  const f = fixture({ lost: true });
  const receipt = await f.client.sendMessage(chat, 'Hi @[User](8:live:other) <script>');
  assert.equal(receipt.arrivalTime, id);
  assert.equal(f.writes.length, 1);
  assert.match(f.writes[0].content, /&lt;script&gt;/);
  assert.equal(JSON.parse(f.writes[0].properties.mentions)[0].mri, '8:live:other');
});

test('edit/readback retains a quote; delete is bot-only and verified', async () => {
  const f = fixture();
  await f.client.sendMessage(chat, 'original');
  f.messages[0].content = '<blockquote itemtype="http://schema.skype.com/Reply">quote</blockquote><p>original</p>';
  f.messages[0].properties = { qtdMsgs: '[{"messageId":"123"}]' };
  assert.equal((await f.client.editMessage(chat, id, 'replacement')).verified, true);
  assert.match(f.messages[0].content, /blockquote/);
  assert.equal(f.messages[0].properties.qtdMsgs, '[{"messageId":"123"}]');
  assert.equal((await f.client.deleteMessage(chat, id)).verified, true);
  const notMine = fixture({ otherOwner: true });
  await assert.rejects(notMine.client.editMessage(chat, id, 'wrong'), /own message/);
  await assert.rejects(notMine.client.deleteMessage(chat, id), /own message/);
  assert.equal(notMine.writes.length, 0);
});

test('history pagination, revoked scope and malformed IDs fail before credential disclosure/writes', async () => {
  const f = fixture({ redirected: true });
  await assert.rejects(f.client.getMessages(chat, { limit: 10 }), /Untrusted Teams endpoint/);
  await assert.rejects(f.client.getMessage(chat, '0'), /Invalid/);
  f.revoke(); await assert.rejects(f.client.sendMessage(chat, 'no'), /scope/);
  assert.equal(f.writes.length, 0);
});

test('attachments retain original references and reject external image/download hosts', async () => {
  assert.throws(() => trustedDownload('https://asm.skype.com.evil.example/file', true));
  assert.throws(() => trustedDownload('https://user:password@api.asm.skype.com/file', true));
  const original = Buffer.from('unchanged original bytes');
  const requests: any[] = [];
  const client = createTeamsClient(auth, { expectedAccount: bot, getGraphToken: async () => 'synthetic-graph',
    fetcher: async (url: URL, options: any) => {
      requests.push([url.hostname, options.headers]); assert.equal(options.redirect, 'error');
      if (url.hostname === 'graph.microsoft.com') return Response.json({ name: 'original.bin', size: original.length,
        '@microsoft.graph.downloadUrl': 'https://files.1drv.com/original' });
      if (url.hostname === 'files.1drv.com') { assert.equal(options.headers.Authorization, undefined); return new Response(original); }
      return Response.json({ id, conversationid: chat, from: bot, properties: { files: JSON.stringify([
        { fileName: 'original.bin', fileInfo: { shareUrl: 'https://1drv.ms/u/synthetic' } },
      ]) } });
    },
  });
  assert.deepEqual((await client.readAttachment(chat, id, 0)).bytes, original);
  assert.equal(requests.length, 3);
  const list = attachmentList({ content: '<URIObject type="File.1" uri="https://api.asm.skype.com/v1/objects/synthetic"><OriginalName v="a.txt"/></URIObject>' });
  assert.equal(list[0].name, 'a.txt'); assert.match(list[0].url, /views\/original$/);
});

test('original-file send uploads byte-identically, grants only this chat and does not retry writes', async () => {
  const original = Buffer.from([0, 1, 2, 255]);
  const calls: any[] = [];
  const client = createTeamsClient(auth, { expectedAccount: bot, assertChat: (value: string) => assert.equal(value, chat),
    fetcher: async (url: URL, options: any) => {
      calls.push([url, options]);
      if (url.hostname === 'api.asm.skype.com' && options.method === 'POST') {
        assert.deepEqual(JSON.parse(options.body).permissions, { [chat]: ['read'] }); return Response.json({ id: 'synthetic-object' });
      }
      if (options.method === 'PUT') { assert.deepEqual(options.body, original); return new Response(null, { status: 201 }); }
      return Response.json({ OriginalArrivalTime: id });
    },
  });
  assert.equal((await client.sendFile(chat, original, 'original.bin', 'caption')).arrivalTime, id);
  assert.equal(calls.length, 3);
  const message = JSON.parse(calls[2][1].body);
  assert.match(message.content, /caption.*URIObject/);
  assert.match(message.content, /File\.1/);
  assert.deepEqual(message.amsreferences, ['synthetic-object']);
  await assert.rejects(client.sendFile(chat, original, '../unsafe.bin'), /filename/);
  assert.equal(calls.length, 3);
});

for (const caption of ['', 'Hi @[User](8:live:other) <caption>']) test(`inline image uses native AMS markup in one message: ${caption ? 'caption' : 'image only'}`, async () => {
  const original = Buffer.from('synthetic image bytes');
  const calls: any[] = [];
  let published: any;
  const client = createTeamsClient(auth, { expectedAccount: bot,
    fetcher: async (url: URL, options: any) => {
      calls.push([url, options]);
      if (url.hostname === 'api.asm.skype.com' && options.method === 'POST') {
        assert.deepEqual(JSON.parse(options.body), { type: 'pish/image', filename: 'a&b.png', sharingMode: 'Inline', permissions: { [chat]: ['read'] } });
        return Response.json({ id: 'synthetic-image' });
      }
      if (options.method === 'PUT') {
        assert.match(url.pathname, /\/content\/imgpsh$/); assert.deepEqual(options.body, original);
        return new Response(null, { status: 201 });
      }
      if (options.method === 'POST') { published = JSON.parse(options.body); throw new Error('response lost'); }
      return Response.json({ messages: [{ ...published, id, from: bot, conversationid: chat }] });
    },
  });
  const receipt = await client.sendImage(chat, original, 'a&b.png', caption, { contentType: 'image/png', width: 800, height: 400 });
  assert.equal(receipt.arrivalTime, id);
  assert.equal(calls.length, 4); // One create, upload, publish and reconciliation read; never a second publish.
  assert.equal(published.messagetype, 'RichText/Html');
  assert.match(published.content, /<img src="https:\/\/api\.asm\.skype\.com\/v1\/objects\/synthetic-image\/views\/imgo"/);
  assert.match(published.content, /itemtype="http:\/\/schema\.skype\.com\/AMSImage" itemscope="png" width="400" height="200"/);
  assert.match(published.content, /alt="a&amp;b.png"/);
  assert.doesNotMatch(published.content, /URIObject|File\.1/);
  assert.deepEqual(published.amsreferences, ['synthetic-image']);
  if (caption) {
    assert.match(published.content, /&lt;caption&gt;<\/p><p><img/);
    assert.equal(JSON.parse(published.properties.mentions)[0].mri, '8:live:other');
  } else assert.match(published.content, /^<p><img/);
});

test('image validation precedes uploads, and revoked scope or failed uploads never publish', async () => {
  let calls = 0, revoked = false, failedUpload = false;
  const client = createTeamsClient(auth, { expectedAccount: bot, assertChat: () => { if (revoked) throw new Error('revoked'); },
    fetcher: async (_url: URL, options: any) => {
      calls++;
      if (options.method === 'PUT') { assert.equal(failedUpload, true); return new Response(null, { status: 500 }); }
      assert.equal(options.method, 'POST');
      if (!failedUpload) revoked = true;
      return Response.json({ id: 'synthetic-image' });
    },
  });
  const bytes = Buffer.from('synthetic image');
  const meta = { contentType: 'image/jpeg', width: 800, height: 400 };
  for (const bad of [{ ...meta, width: 0 }, { ...meta, height: NaN }, { ...meta, width: 100000 }, { ...meta, contentType: 'image/svg+xml' }]) {
    await assert.rejects(client.sendImage(chat, bytes, 'a.jpg', '', bad), /Unsupported/);
  }
  await assert.rejects(client.sendImage(chat, Buffer.alloc(5 * 1024 * 1024 + 1), 'a.jpg', '', meta), /5 MiB/);
  await assert.rejects(client.sendImage(chat, bytes, '../a.jpg', '', meta), /filename/);
  await assert.rejects(client.sendImage(chat, bytes, 'a.jpg', 'x'.repeat(20001), meta), /20000/);
  assert.equal(calls, 0);
  await assert.rejects(client.sendImage(chat, bytes, 'a.jpg', '', meta), /revoked/);
  assert.equal(calls, 1);
  revoked = false; failedUpload = true;
  await assert.rejects(client.sendImage(chat, bytes, 'a.jpg', '', meta), /500/);
  assert.equal(calls, 3);
});
