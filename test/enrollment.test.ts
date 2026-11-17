import test from 'node:test';
import assert from 'node:assert/strict';
import { createScopedPolicy, createGroupAccessTool } from '../plugin/enrollment.mjs';

const oldGroup = '19:synthetic@thread.v2';
const newGroup = '19:synthetic-new@thread.v2';
const dm = '19:uni01_synthetic@thread.v2';
const bot = '8:live:.cid.synthetic';
const owner = '8:orgid:synthetic-owner';
const channel = 'teams-personal';
const base = { CHANNEL: channel, CHAT: dm, BOT: bot, SENDER: owner, GROUP: oldGroup, GROUPS: [oldGroup],
  validConfig: (a: any) => a?.enabled === true,
  normalizedTarget: (s: string) => typeof s === 'string' ? s.replace(/^teams-personal:/, '') : '',
  groupAdmitted: (m: any) => m.conversationId === oldGroup && m.isMine === false &&
    !m.edited && !m.forwarded && (m.mentions.some((x: any) => x.mri === bot) || m.replyToBot),
};
const config = () => ({ commands: { ownerAllowFrom: ['telegram:synthetic-owner'] }, channels: {
  [channel]: { enabled: true, enrollmentOwnerId: owner, groupPolicy: 'allowlist',
    groups: { [oldGroup]: { requireMention: true, allowFrom: ['*'] } } },
  other: { groups: { untouched: {} } },
} });
const msg = () => ({ conversationId: newGroup, id: '1794800000001', time: '2026-11-16T08:00:00Z',
  text: 'native tag', fromId: owner, isMine: false, mentions: [{ mri: bot }] });
const startedAt = Date.parse('2026-11-16T07:59:00Z');

test('dynamic room policy honors disabled entries/revocation, preserves DM and does not grant member management', () => {
  const cfg: any = config();
  const policy = createScopedPolicy(base, () => cfg);
  assert.deepEqual(policy.GROUPS, [oldGroup]);
  assert.equal(policy.targetAllowed(newGroup), false);
  cfg.channels[channel].groups[newGroup] = { requireMention: true, allowFrom: ['*'] };
  assert.equal(policy.targetAllowed(`teams-personal:${newGroup}`), true);
  assert.equal(policy.groupAdmitted({ ...msg(), fromId: '8:orgid:member' }, 0), true);
  assert.equal(policy.groupAdmitted({ ...msg(), fromId: '8:orgid:member', mentions: [] }, 0), false);
  cfg.channels[channel].groups[newGroup].allowFrom = [owner];
  assert.equal(policy.groupAdmitted({ ...msg(), fromId: '8:orgid:member' }, 0), false);
  cfg.channels[channel].groups[newGroup].enabled = false;
  assert.equal(policy.targetAllowed(newGroup), false);
  cfg.channels[channel].groupPolicy = 'disabled';
  assert.deepEqual(policy.GROUPS, []);
  assert.equal(policy.targetAllowed(dm), true);
});


test('owner native mentions allow only their exact turn, never persistent targets or other members', () => {
  const cfg: any = config();
  const policy = createScopedPolicy(base, () => cfg);
  const before = structuredClone(cfg);
  assert.equal(policy.ownerMentionAllowed(msg(), startedAt), true);
  assert.equal(policy.groupAdmitted(msg(), startedAt), true);
  assert.equal(policy.targetAllowed(newGroup), false);
  assert.deepEqual(policy.GROUPS, [oldGroup]);
  for (const patch of [{ fromId: '8:orgid:member' }, { mentions: [] }, { edited: true }, { deleted: true },
    { forwarded: true }, { isMine: true }, { conversationId: dm }, { time: '2026-11-15T00:00:00Z' }]) {
    assert.equal(policy.groupAdmitted({ ...msg(), ...patch }, startedAt), false);
  }
  assert.deepEqual(cfg, before);
  cfg.channels[channel].groups[newGroup] = { enabled: false };
  assert.equal(policy.groupAdmitted(msg(), startedAt), false);
  delete cfg.channels[channel].groups[newGroup];
  cfg.channels[channel].groupPolicy = 'disabled';
  assert.equal(policy.groupAdmitted(msg(), startedAt), false);
  cfg.channels[channel].groupPolicy = 'allowlist';
  delete cfg.channels[channel].enrollmentOwnerId;
  assert.equal(policy.groupAdmitted(msg(), startedAt), false);
});

// A controlled core isolates the host mutation contract; host-core integration
// below exercises its real owner policy with the same adapter/tool path.
const fakeCore = async (_facts: any, deps: any) => {
  if (deps.current().channels[channel].groups[newGroup]) return { changed: false };
  return { changed: (await deps.mutate({
    mutate: (cfg: any) => { cfg.channels[channel].groups[newGroup] = { requireMention: true, allowFrom: ['*'] }; return true; },
  })).result };
};
function setup(sharedEnroll = fakeCore) {
  let cfg: any = config(), active = true, writes = 0;
  const context: any = { messageChannel: channel, nativeChannelId: newGroup, requesterSenderId: owner,
    assertInvocationCurrent() { if (!active) throw new Error('invocation expired'); } };
  const deps: any = { policy: base, current: () => cfg, sharedEnroll, jsonResult: (value: any) => value,
    mutate: async (options: any) => {
      options.writeOptions.assertCurrent();
      const draft = structuredClone(cfg);
      const result = options.mutate(draft); writes++; cfg = draft; return { result };
    },
  };
  return { context, deps, config: () => cfg, publish: (next: any) => { cfg = next; },
    expire: () => { active = false; }, writes: () => writes };
}
const action = { action: 'allow-current-group' };
test('only the trusted current-group owner can discover the management tool', () => {
  const f = setup();
  assert.equal(createGroupAccessTool(f.context, f.deps)!.name, 'teams_group_access');
  for (const patch of [{ messageChannel: 'telegram' }, { requesterSenderId: '8:orgid:member' },
    { requesterSenderId: undefined, senderIsOwner: true }, { nativeChannelId: dm }, { agentAccountId: 'other' },
    { assertInvocationCurrent: undefined }]) {
    assert.equal(createGroupAccessTool({ ...f.context, ...patch }, f.deps), null);
  }
  f.config().channels[channel].groups[newGroup] = { enabled: false };
  assert.equal(createGroupAccessTool(f.context, f.deps), null);
});
test('explicit tool persists one exact group with approval-time fence, preserving owners, DMs and other groups', async () => {
  const f = setup();
  const before = structuredClone(f.config());
  const tool = createGroupAccessTool(f.context, f.deps)!;
  assert.deepEqual(tool.parameters.properties.action.enum, ['allow-current-group']);
  await assert.rejects(tool.execute('x', { ...action, groupId: oldGroup }), /Only the current/);
  await assert.rejects(tool.execute('x', { action: 'other' }), /Only the current/);
  assert.equal(f.writes(), 0);
  const result = await tool.execute('x', action);
  assert.deepEqual(result, { changed: true, active: true, chatId: newGroup });
  const entry = f.config().channels[channel].groups[newGroup];
  assert.equal(entry.requireMention, true); assert.deepEqual(entry.allowFrom, ['*']);
  assert.equal(Number.isFinite(entry.activatedAt), true); assert.equal(entry.activationId, undefined);
  assert.deepEqual(f.config().commands, before.commands);
  assert.deepEqual(f.config().channels.other, before.channels.other);
  assert.deepEqual(f.config().channels[channel].groups[oldGroup], before.channels[channel].groups[oldGroup]);
  assert.equal((await tool.execute('x', action)).changed, false);
  assert.equal(f.writes(), 1);
  f.expire(); await assert.rejects(tool.execute('x', action), /expired/);
});

test('tool waits for published policy and never authorizes from its persisted draft', async () => {
  const f = setup(); let persisted: any;
  let written!: () => void;
  const ready = new Promise<void>(resolve => { written = resolve; });
  f.deps.mutate = async (options: any) => {
    options.writeOptions.assertCurrent();
    persisted = structuredClone(f.config());
    const result = options.mutate(persisted); written(); return { result };
  };
  const tool = createGroupAccessTool(f.context, f.deps)!;
  let settled = false;
  const pending = tool.execute('x', action).then((result: any) => { settled = true; return result; });
  await ready; await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(createScopedPolicy(base, f.deps.current).targetAllowed(newGroup), false);
  f.publish(persisted);
  assert.equal((await pending).active, true);
});

for (const outcome of ['owner-revoked', 'room-disabled', 'superseded', 'abort', 'timeout', 'invocation-expired']) {
  test(`management tool fails closed on ${outcome} during publication`, async () => {
    const f = setup(); const controller = new AbortController(); f.deps.activationTimeoutMs = 40;
    f.deps.mutate = async (options: any) => {
      options.writeOptions.assertCurrent(); const draft = structuredClone(f.config());
      const result = options.mutate(draft);
      setImmediate(() => {
        const next = structuredClone(f.config());
        if (outcome === 'owner-revoked') delete next.channels[channel].enrollmentOwnerId;
        if (outcome === 'room-disabled') next.channels[channel].groups[newGroup] = { enabled: false };
        if (outcome === 'superseded') next.channels[channel].groups[newGroup] = { ...draft.channels[channel].groups[newGroup], activatedAt: 1 };
        if (outcome === 'abort') controller.abort();
        if (outcome === 'invocation-expired') f.expire();
        f.publish(next);
      });
      return { result };
    };
    const pending = createGroupAccessTool(f.context, f.deps)!.execute('x', action, controller.signal);
    if (outcome === 'timeout') assert.equal((await pending).active, false);
    else await assert.rejects(pending, outcome === 'abort' ? { name: 'AbortError' } : /authorization|superseded|expired/);
  });
}

test('persisted draft owner revocation blocks mutation even while published owner remains unchanged', async () => {
  const f = setup();
  f.deps.mutate = async (options: any) => {
    const draft = structuredClone(f.config()); delete draft.channels[channel].enrollmentOwnerId;
    return { result: options.mutate(draft) };
  };
  await assert.rejects(createGroupAccessTool(f.context, f.deps)!.execute('x', action), /authorization changed in configuration/);
});
const corePath = process.env.TEAMS_ENROLLMENT_CORE;
test('real shared core is called only by the explicit owner tool, not ordinary mention admission', { skip: !corePath }, async () => {
  const { enrollOwnerGroup } = await import(corePath!);
  const f = setup(enrollOwnerGroup);
  const policy = createScopedPolicy(base, f.deps.current);
  assert.equal(policy.groupAdmitted(msg(), startedAt), true); assert.equal(f.writes(), 0);
  assert.equal((await createGroupAccessTool(f.context, f.deps)!.execute('x', action)).changed, true);
  assert.equal(f.writes(), 1);
  assert.equal((await createGroupAccessTool(f.context, f.deps)!.execute('x', action)).changed, false);
  assert.equal(f.writes(), 1);
  assert.deepEqual(f.config().commands.ownerAllowFrom, ['telegram:synthetic-owner']);
});
