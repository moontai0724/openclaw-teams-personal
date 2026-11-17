import assert from 'node:assert/strict';
import test from 'node:test';
import { ContextWindow, channelMessage } from '../plugin/receiver.mjs';

const bot = '8:live:.cid.synthetic';
const group = '19:synthetic-group@thread.v2';
const raw = { id: '1794800000000', version: '1', from: '8:orgid:synthetic-user', conversationid: group,
  originalarrivaltime: '2026-11-16T00:00:00Z', content: 'old', messagetype: 'Text', properties: {} };

test('edits replace context in place and stale repair cannot undo an edit or deletion', () => {
  const window = new ContextWindow();
  const original = channelMessage(raw, 'NewMessage', group, bot)!;
  window.record(original);
  window.record(channelMessage({ ...raw, version: '2', content: 'edited' }, 'MessageUpdate', group, bot));
  assert.equal(window.find(group, raw.id).text, 'edited');
  window.record(original);
  assert.equal(window.find(group, raw.id).text, 'edited');
  window.record(channelMessage({ ...raw, version: '3', properties: { deletetime: 'now' } }, 'MessageRemoved', group, bot));
  window.record(original);
  assert.equal(window.find(group, raw.id), undefined);
  assert.equal(window.history(group, { id: '1794800000001' }).length, 0);
});

test('context remains per-chat, bounded, and retains bot messages for verified reply gating', () => {
  const window = new ContextWindow();
  for (let i = 0; i < 110; i++) window.record(channelMessage({ ...raw, id: String(Number(raw.id) + i), from: bot, content: 'synthetic bot' }, 'NewMessage', group, bot));
  assert.equal(window.windows.get(group).length, 100);
  const history = window.history(group, { id: '1794800000999' });
  assert.equal(history.length, 50);
  assert.match(history[0].sender, /synthetic/);
  assert.deepEqual(window.history('19:other@thread.v2', { id: '1794800000999' }), []);
  assert.equal(window.find(group, '1794800000109').isMine, true);
});
