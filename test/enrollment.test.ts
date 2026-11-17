import test from 'node:test';
import assert from 'node:assert/strict';
import { createScopedPolicy, createOwnerEnrollment } from '../plugin/enrollment.mjs';

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

test('ordinary, other-user, edited, forwarded, reply, command, old and DM traffic never invokes enrollment/config I/O', async () => {
  const enroll = createOwnerEnrollment({ policy: base,
    current: () => { throw Error('unexpected config read'); }, mutate: () => { throw Error('unexpected write'); },
    sharedEnroll: () => { throw Error('unexpected core call'); }, assertAuthority() {},
  });
  for (const patch of [ { mentions: [] }, { fromId: '8:orgid:other' }, { edited: true }, { deleted: true },
    { forwarded: true }, { replyTo: {} }, { text: '/command' }, { isMine: true },
    { time: '2026-11-15T00:00:00Z' }, { conversationId: dm }, { conversationId: '__proto__' } ]) {
    assert.equal(await enroll({ ...msg(), ...patch }, startedAt), false);
  }
});

test('adapter persists only the shared room result and trigger fence, without granting global ownership', async () => {
  const cfg: any = config();
  const originalOwners = structuredClone(cfg.commands);
  const other = structuredClone(cfg.channels.other);
  let mutations = 0;
  const enroll = createOwnerEnrollment({ policy: base, current: () => cfg, assertAuthority() {},
    sharedEnroll: async (facts: any, deps: any) => {
      const projected = deps.current();
      assert.equal(facts.senderId, owner);
      assert.equal(facts.explicitMention, true);
      assert.deepEqual(projected.commands.ownerAllowFrom, [`${channel}:${owner}`]);
      const receipt = await deps.mutate({ afterWrite: { mode: 'auto' },
        mutate: (draft: any) => { draft.channels[channel].groups[newGroup] = { requireMention: true, allowFrom: ['*'] }; return true; },
        writeOptions: { assertCurrent() {} },
      });
      return { changed: receipt.result };
    },
    mutate: async (options: any) => { mutations++; options.writeOptions.assertCurrent(); return { result: options.mutate(cfg) }; },
  });
  assert.equal(await enroll(msg(), startedAt), true);
  assert.equal(mutations, 1);
  assert.deepEqual(cfg.commands, originalOwners);
  assert.deepEqual(cfg.channels.other, other);
  assert.deepEqual(cfg.channels[channel].groups[newGroup], { requireMention: true, allowFrom: ['*'],
    activationId: msg().id, activatedAt: Date.parse(msg().time) });
});

const corePath = process.env.TEAMS_ENROLLMENT_CORE;
test('host shared core: fail closed until identity confirmed; disabled rooms, repeats and owner revocation remain unchanged', { skip: !corePath }, async () => {
  const { enrollOwnerGroup } = await import(corePath!);
  const cfg: any = config();
  let writes = 0;
  let revoke = false;
  const enroll = createOwnerEnrollment({ policy: base, current: () => cfg, sharedEnroll: enrollOwnerGroup, assertAuthority() {},
    mutate: async (options: any) => {
      if (revoke) delete cfg.channels[channel].enrollmentOwnerId;
      options.writeOptions.assertCurrent();
      const result = options.mutate(cfg); writes++; return { result };
    },
  });
  delete cfg.channels[channel].enrollmentOwnerId;
  assert.equal(await enroll(msg(), startedAt), false);
  assert.equal(writes, 0);
  cfg.channels[channel].enrollmentOwnerId = owner;
  cfg.channels[channel].groups[newGroup] = { enabled: false };
  assert.equal(await enroll(msg(), startedAt), false);
  delete cfg.channels[channel].groups[newGroup];
  cfg.channels[channel].groupPolicy = 'disabled';
  assert.equal(await enroll(msg(), startedAt), false);
  cfg.channels[channel].groupPolicy = 'allowlist';
  revoke = true;
  await assert.rejects(enroll(msg(), startedAt), /authorization changed/);
  assert.equal(writes, 0);
  revoke = false;
  cfg.channels[channel].enrollmentOwnerId = owner;
  assert.equal(await enroll(msg(), startedAt), true);
  assert.equal(await enroll(msg(), startedAt), false);
  assert.equal(writes, 1);
  assert.deepEqual(cfg.commands.ownerAllowFrom, ['telegram:synthetic-owner']);
});

test('persisted enrollment waits for the immutable published snapshot, without admitting the draft', async () => {
  let published: any = config();
  const policy = createScopedPolicy(base, () => published);
  let persisted: any;
  let release!: () => void;
  const written = new Promise<void>(resolve => { release = resolve; });
  const enroll = createOwnerEnrollment({ policy: base, current: () => published, assertAuthority() {},
    sharedEnroll: async (_facts: any, deps: any) => ({ changed: (await deps.mutate({
      mutate: (draft: any) => { draft.channels[channel].groups[newGroup] = { requireMention: true, allowFrom: ['*'] }; return true; },
    })).result }),
    mutate: async (options: any) => {
      persisted = structuredClone(published);
      options.writeOptions.assertCurrent();
      const result = options.mutate(persisted);
      release();
      return { result };
    },
  });
  let settled = false;
  const pending = enroll(msg(), startedAt).then(result => { settled = true; return result; });
  await written;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(policy.groupAllowed(newGroup), false);
  assert.equal(policy.groupAdmitted(msg(), 0), false);
  assert.equal(policy.targetAllowed(newGroup), false);
  assert.equal(persisted.channels[channel].groups[newGroup].activationId, msg().id);
  published = persisted;
  assert.equal(await pending, true);
  assert.equal(policy.groupAllowed(newGroup), true);
  assert.equal(policy.groupAdmitted(msg(), 0), true);
  assert.equal(policy.targetAllowed(newGroup), true);
});

for (const outcome of ['owner-revoked', 'room-disabled', 'superseded', 'abort', 'timeout']) {
  test(`unpublished enrollment fails closed on ${outcome}`, async () => {
    let published: any = config();
    const controller = new AbortController();
    const enroll = createOwnerEnrollment({ policy: base, current: () => published, assertAuthority() {},
      signal: controller.signal, activationTimeoutMs: 40,
      sharedEnroll: async (_facts: any, deps: any) => ({ changed: (await deps.mutate({
        mutate: (draft: any) => { draft.channels[channel].groups[newGroup] = { requireMention: true, allowFrom: ['*'] }; return true; },
      })).result }),
      mutate: async (options: any) => {
        const draft = structuredClone(published);
        options.writeOptions.assertCurrent();
        const result = options.mutate(draft);
        setImmediate(() => {
          const next = structuredClone(published);
          if (outcome === 'owner-revoked') delete next.channels[channel].enrollmentOwnerId;
          if (outcome === 'room-disabled') next.channels[channel].groups[newGroup] = { enabled: false };
          if (outcome === 'superseded') next.channels[channel].groups[newGroup] = {
            ...draft.channels[channel].groups[newGroup], activationId: '1794800000999' };
          if (outcome === 'abort') controller.abort();
          published = next;
        });
        return { result };
      },
    });
    await assert.rejects(enroll(msg(), startedAt), outcome === 'abort' ? { name: 'AbortError' } :
      outcome === 'timeout' ? /persisted but runtime activation timed out/ : /authorization changed|revoked or superseded/);
    assert.equal(createScopedPolicy(base, () => published).groupAllowed(newGroup), outcome === 'superseded');
  });
}
