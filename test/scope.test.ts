import assert from 'node:assert/strict';
import test from 'node:test';
import { parseScope } from '../src/scope.ts';

test('requires one explicit group and expected identity', () => {
  const scope = { chatId: '19:synthetic-group@thread.v2', expectedAccount: '8:live:.cid.synthetic' };
  assert.deepEqual(parseScope(scope), scope);
  for (const chatId of ['*', '19:uni01_example@thread.v2', '', 'https://example.com']) {
    assert.throws(() => parseScope({ ...scope, chatId }));
  }
  assert.throws(() => parseScope({ chatId: scope.chatId }));
});
