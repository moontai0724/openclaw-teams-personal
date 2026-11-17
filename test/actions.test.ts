import assert from 'node:assert/strict';
import test from 'node:test';
import { createTeamsActions } from '../plugin/actions.mjs';

const group = '19:synthetic@thread.v2';
const other = '19:synthetic-other@thread.v2';
const bot = '8:live:.cid.synthetic';
const messageId = '1794800000001';
const emojis = [{ key: 'like', emoji: '👍' }, { key: 'heart', emoji: '❤️' }];

function fixture(options: { failWrite?: boolean; failAfterWrite?: boolean; neverVisible?: boolean } = {}) {
  let enabled = true;
  let identity = 'live:.cid.synthetic';
  let reads = 0;
  let writes = 0;
  let authCalls = 0;
  let beforeAuth = () => {};
  let beforeRead = () => {};
  const mine = new Set<string>();
  const cfg = () => ({ channels: { 'teams-personal': { enabled } } });
  const actions = createTeamsActions({
    policy: { CHANNEL: 'teams-personal', BOT: bot,
      normalizedTarget: (to: string) => to.replace(/^teams-personal:/, ''),
      targetAllowed: (to: string) => typeof to === 'string' && [group, other].includes(to.replace(/^teams-personal:/, '')),
      validConfig: (account: { enabled: boolean }) => account.enabled,
    },
    currentConfig: cfg,
    getSkypeToken: async () => {
      authCalls++;
      beforeAuth();
      return { token: `header.${Buffer.from(JSON.stringify({ skypeid: identity })).toString('base64url')}.signature`, expiresAt: Date.now() + 3600_000 };
    },
    reactionEmojis: emojis,
    normalizeReactionKey: (input: string) => {
      const match = emojis.find(item => item.emoji === input || item.key === input);
      if (!match) throw new Error('Unknown reaction');
      return match.key;
    },
    jsonResult: (value: unknown) => value,
    createTeamsClient: (auth: () => Promise<unknown>) => ({
      getMessage: async (chat: string, id: string) => {
        await auth();
        reads++;
        beforeRead();
        return { id, conversationId: chat,
          reactions: [{ key: 'like', mine: false }, ...[...mine].map(key => ({ key, mine: true }))] };
      },
      react: async (chat: string, id: string, key: string, { remove }: { remove: boolean }) => {
        await auth();
        assert.equal(chat, group);
        assert.equal(id, messageId);
        writes++;
        if (options.failWrite) throw new Error('Failed before write');
        if (!options.neverVisible) { if (remove) mine.delete(key); else mine.add(key); }
        if (options.failAfterWrite) throw new Error('Lost response after write');
      },
    }),
  });
  const context = { action: 'react', accountId: 'default', params: { to: group, messageId, emoji: '👍' },
    toolContext: { currentChannelProvider: 'teams-personal', currentChannelId: group, currentMessageId: messageId } };
  return { actions, context, cfg, mine,
    stats: () => ({ reads, writes, authCalls }),
    disable: () => { enabled = false; }, changeIdentity: () => { identity = 'live:.cid.unapproved'; },
    onAuth: (fn: () => void) => { beforeAuth = fn; }, onRead: (fn: () => void) => { beforeRead = fn; },
  };
}

test('reaction addition is read back as the bot, not another user, and repeated calls are idempotent', async () => {
  const f = fixture();
  assert.deepEqual(await f.actions.handleAction(f.context), {
    ok: true, channel: 'teams-personal', chatId: group, messageId, key: 'like', remove: false,
    changed: true, verified: true, reconciled: false,
  });
  const second = await f.actions.handleAction(f.context);
  assert.equal(second.changed, false);
  assert.equal(second.verified, true);
  assert.equal(f.stats().writes, 1);
});

test('removing a named reaction preserves the bot other emoji and other users reactions', async () => {
  const f = fixture();
  f.mine.add('like'); f.mine.add('heart');
  const result = await f.actions.handleAction({ ...f.context, params: { ...f.context.params, remove: true } });
  assert.equal(result.ok, true);
  assert.equal(result.remove, true);
  assert.deepEqual([...f.mine], ['heart']);
  assert.equal((await f.actions.handleAction({ ...f.context, params: { ...f.context.params, remove: true } })).changed, false);
  assert.equal(f.stats().writes, 1);
});

test('reaction fallback is limited to the exact current Teams conversation; explicit bad IDs fail closed', async () => {
  const f = fixture();
  const { messageId: _id, ...params } = f.context.params;
  assert.equal((await f.actions.handleAction({ ...f.context, params })).messageId, messageId);
  for (const value of [
    { params: { ...params, to: other } },
    { toolContext: { ...f.context.toolContext, currentChannelProvider: 'telegram' }, params },
    { params: { ...params, messageId: '' } },
    { params: { ...params, messageId: '0' } },
    { params: { ...params, messageId: 9007199254740992 } },
  ]) await assert.rejects(f.actions.handleAction({ ...f.context, ...value }), /valid messageId/);
  assert.equal(f.stats().writes, 1);
});

test('unsupported targets/accounts/emojis and conflicting destinations do no I/O', async () => {
  const f = fixture();
  for (const value of [
    { accountId: 'unapproved' },
    { params: { ...f.context.params, to: '19:unapproved@thread.v2' } },
    { params: { ...f.context.params, target: other } },
    { params: { ...f.context.params, emoji: '' } },
    { params: { ...f.context.params, emoji: 'unknown' } },
    { params: { ...f.context.params, remove: 'true' } },
    { params: { ...f.context.params, emoji: '', remove: true } },
  ]) await assert.rejects(f.actions.handleAction({ ...f.context, ...value }));
  assert.deepEqual(f.stats(), { reads: 0, writes: 0, authCalls: 0 });
});

test('dry-run and emoji discovery do not authenticate or mutate', async () => {
  const f = fixture();
  assert.deepEqual(f.actions.describeMessageTool({ cfg: f.cfg() }).actions, ['send', 'react', 'emoji-list', 'read', 'edit', 'delete']);
  assert.equal((await f.actions.handleAction({ ...f.context, dryRun: true })).dryRun, true);
  assert.deepEqual((await f.actions.handleAction({ ...f.context, action: 'emoji-list' })).emojis, emojis);
  assert.deepEqual(f.stats(), { reads: 0, writes: 0, authCalls: 0 });
  f.disable();
  assert.deepEqual(f.actions.describeMessageTool({ cfg: f.cfg() }).actions, []);
  await assert.rejects(f.actions.handleAction(f.context), /policy not enabled/);
});

test('native edit/delete/read validate the current conversation and explicit IDs before I/O', async () => {
  const f = fixture();
  const edit = { ...f.context, action: 'edit', params: { to: group, messageId, message: 'replacement' }, dryRun: true };
  assert.equal((await f.actions.handleAction(edit)).dryRun, true);
  for (const action of ['edit', 'delete']) {
    await assert.rejects(f.actions.handleAction({ ...f.context, action, params: { to: group } }), /explicit/);
    await assert.rejects(f.actions.handleAction({ ...edit, action, params: { ...edit.params, to: other } }), /current conversation/);
  }
  await assert.rejects(f.actions.handleAction({ ...edit, toolContext: { ...edit.toolContext, currentChannelProvider: 'telegram' } }), /current conversation/);
  assert.deepEqual(f.stats(), { reads: 0, writes: 0, authCalls: 0 });
});

test('reaction response lost after success is reconciled without a second write', async () => {
  const f = fixture({ failAfterWrite: true });
  const result = await f.actions.handleAction(f.context);
  assert.equal(result.ok, true);
  assert.equal(result.reconciled, true);
  assert.equal(f.stats().writes, 1);
});

test('unverified write returns failure without retrying or falsely acknowledging success', async () => {
  const f = fixture({ failWrite: true });
  const result = await f.actions.handleAction(f.context);
  assert.equal(result.ok, false);
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'reaction_not_verified');
  assert.equal(f.stats().writes, 1);
});

test('live policy, host handoff and credential identity are rechecked after asynchronous preparation', async () => {
  for (const scenario of ['identity', 'config', 'handoff']) {
    const f = fixture();
    let revoked = false;
    f.onRead(() => {
      if (scenario === 'identity') f.changeIdentity();
      if (scenario === 'config') f.disable();
      revoked = true;
    });
    const ctx = { ...f.context, assertDirectAdapterHandoff: () => {
      if (scenario === 'handoff' && revoked) throw new Error('Handoff revoked');
    } };
    if (scenario === 'identity') assert.equal((await f.actions.handleAction(ctx)).ok, false);
    else await assert.rejects(f.actions.handleAction(ctx));
    assert.equal(f.stats().writes, 0);
  }
  const f = fixture();
  f.onAuth(f.disable);
  await assert.rejects(f.actions.handleAction(f.context), /policy not enabled/);
  assert.equal(f.stats().reads, 0);
});
