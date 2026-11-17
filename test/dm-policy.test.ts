import assert from 'node:assert/strict';
import test from 'node:test';
import { createScopedPolicy, createGroupAccessTool } from '../plugin/enrollment.mjs';

const channel = 'teams-personal';
const primary = '19:uni01_owner@thread.v2';
const dm = '19:uni01_member@thread.v2';
const otherDm = '19:uni01_other@thread.v2';
const group = '19:synthetic-group@thread.v2';
const owner = '8:orgid:synthetic-owner';
const member = '8:live:.cid.synthetic-member';
const bot = '8:live:.cid.synthetic-bot';
const activation = 1794800000000;
const base = { CHANNEL: channel, CHAT: primary, SENDER: owner, BOT: bot, GROUP: group, GROUPS: [group],
  validConfig: (value: any) => value?.enabled === true,
  normalizedTarget: (value: string) => value.replace(/^teams-personal:/, ''),
  admitted: (message: any) => message.conversationId === primary && message.fromId === owner,
  groupAdmitted: () => false,
};
const message = () => ({ conversationId: dm, fromId: member, isMine: false, id: String(activation + 1),
  time: new Date(activation + 1).toISOString(), text: 'synthetic request' });
const setup = () => {
  const config: any = { commands: { ownerAllowFrom: ['telegram:synthetic-owner'] }, channels: {
    [channel]: { enabled: true, enrollmentOwnerId: owner,
      dms: { [dm]: { allowFrom: [member], activatedAt: activation } } },
  } };
  return { config, policy: createScopedPolicy(base, () => config) };
};

test('DM admission binds an exact conversation/sender pair and activation fence', () => {
  const { config, policy } = setup();
  const before = structuredClone(config);
  assert.deepEqual(policy.DM_CHATS, [primary, dm]);
  assert.equal(policy.targetAllowed(`teams-personal:${dm}`), true);
  assert.equal(policy.admitted(message(), 0), true);
  for (const patch of [{ conversationId: otherDm }, { conversationId: primary }, { fromId: owner },
    { fromId: bot }, { fromId: '8:orgid:unknown' }, { isMine: true }, { edited: true }, { deleted: true },
    { id: 'invalid' }, { time: new Date(activation - 1).toISOString() }, { text: '' }]) {
    assert.equal(policy.admitted({ ...message(), ...patch }, 0), false);
  }
  assert.equal(policy.admitted(message(), activation + 2), false);
  assert.equal(policy.admitted({ ...message(), conversationId: primary, fromId: owner }, 0), true);
  assert.equal(policy.targetAllowed(otherDm), false);
  assert.deepEqual(config, before); // Admission never mutates owner or room settings.
});

test('malformed, wildcard, missing-fence and disabled DM entries fail closed', () => {
  const { config, policy } = setup();
  for (const entry of [{ allowFrom: ['*'], activatedAt: activation }, { allowFrom: [bot], activatedAt: activation },
    { allowFrom: [member, owner], activatedAt: activation }, { allowFrom: [member] },
    { allowFrom: [member], activatedAt: -1 }, { allowFrom: [member], activatedAt: '1' },
    { allowFrom: [member], activatedAt: activation, enabled: false },
    { allowFrom: [member], activatedAt: activation, enabled: 'true' }]) {
    config.channels[channel].dms[dm] = entry;
    assert.equal(policy.targetAllowed(dm), false);
    assert.equal(policy.admitted(message(), 0), false);
  }
  config.channels[channel].dms = { [group]: { allowFrom: [member], activatedAt: activation } };
  assert.deepEqual(policy.DM_CHATS, [primary]);
  assert.equal(policy.targetAllowed(group), true); // Existing group policy is independent.
  config.channels[channel].enabled = false;
  assert.deepEqual(policy.DM_CHATS, []);
  assert.equal(policy.targetAllowed(primary), false);
});

test('DM revocation and peer changes apply immediately without granting group enrollment', async () => {
  const { config, policy } = setup();
  const owners = structuredClone(config.commands);
  assert.equal(createGroupAccessTool({ messageChannel: channel, nativeChannelId: '19:synthetic-new@thread.v2',
    requesterSenderId: member, assertInvocationCurrent() {} }, { policy: base, current: () => config,
    sharedEnroll: () => { throw new Error('Ordinary DM peer must not enroll groups'); },
    mutate: () => { throw new Error('Unexpected config write'); } }), null);
  config.channels[channel].dms[dm].allowFrom = [owner];
  assert.equal(policy.admitted(message(), 0), false);
  assert.deepEqual(policy.dmAllowFrom(dm), [owner]);
  config.channels[channel].dms[dm].enabled = false;
  assert.equal(policy.targetAllowed(dm), false);
  assert.deepEqual(policy.DM_CHATS, [primary]);
  delete config.channels[channel].dms[dm];
  assert.equal(policy.targetAllowed(dm), false);
  assert.deepEqual(config.commands, owners);
});
