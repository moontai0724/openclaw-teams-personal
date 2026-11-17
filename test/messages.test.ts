import assert from 'node:assert/strict';
import test from 'node:test';
import { normalize, eventKey } from '../src/messages.ts';

const scope = { chatId: '19:synthetic-group@thread.v2', expectedAccount: '8:live:.cid.synthetic' };
const raw = { id: '1794800000000', conversationid: scope.chatId, from: '8:orgid:synthetic-sender',
  imdisplayname: 'Synthetic sender', messagetype: 'RichText/Html', content: '<p>hello &amp; world</p>',
  originalarrivaltime: '2026-11-16T00:00:00Z', properties: {} };

test('untagged group text is retained; other groups and self messages never leave normalization', () => {
  assert.equal(normalize(raw, 'NewMessage', scope)?.text, 'hello & world');
  assert.equal(normalize({ ...raw, conversationid: '19:other@thread.v2' }, 'NewMessage', scope), null);
  assert.equal(normalize({ ...raw, from: scope.expectedAccount }, 'NewMessage', scope), null);
  assert.equal(normalize({ ...raw, messagetype: 'RichText/Media_GenericFile' }, 'NewMessage', scope)?.text, 'hello & world');
});

test('preserves authoritative mention MRI and separates quoted text from reply body', () => {
  const message = normalize({ ...raw,
    content: '<blockquote itemtype="http://schema.skype.com/Reply" itemid="123"><strong itemid="8:orgid:original">Person</strong><p itemprop="preview">old words</p></blockquote><p>new words</p>',
    properties: { mentions: JSON.stringify([{ mri: scope.expectedAccount, displayName: 'Synthetic bot' }]) },
  }, 'NewMessage', scope)!;
  assert.equal(message.text, 'new words');
  assert.equal(message.replyTo?.id, '123');
  assert.equal(message.replyTo?.preview, 'old words');
  assert.equal(message.mentions[0].id, scope.expectedAccount);
});

test('edit and deletion events have different durable keys from original messages', () => {
  const first = normalize(raw, 'NewMessage', scope)!;
  const edited = normalize({ ...raw, content: '<p>edited</p>', version: '2' }, 'MessageUpdate', scope)!;
  const deleted = normalize({ ...raw, properties: { deletetime: 'now' } }, 'MessageUpdate', scope)!;
  assert.notEqual(eventKey(first), eventKey(edited));
  assert.notEqual(eventKey(first), eventKey(deleted));
  assert.equal(deleted.kind, 'delete');
  assert.equal(deleted.text, '');
});

test('ephemeral typing controls without message IDs never enter context or durable ingress', () => {
  for (const messagetype of ['Control/Typing', 'Control/ClearTyping']) {
    assert.equal(normalize({ ...raw, id: undefined, messagetype, content: '' }, 'NewMessage', scope, true), null);
  }
});
