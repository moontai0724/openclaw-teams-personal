import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeamsChannel } from '../plugin/index.mjs';

for (const group of ['19:synthetic@thread.v2', '19:synthetic-new@thread.v2']) test(`channel routes context, quotes and replies only into their approved group: ${group}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'teams-channel-test-'));
  const policy = {
    CHANNEL: 'teams-personal', CHAT: '19:uni01_synthetic@thread.v2', GROUP: '19:synthetic@thread.v2',
    GROUPS: ['19:synthetic@thread.v2', '19:synthetic-new@thread.v2'],
    groupLabel: (id: string) => `label:${id}`,
    BOT: '8:live:.cid.synthetic', SENDER: '8:orgid:synthetic-user',
    normalizedTarget: (target: string) => target,
    validConfig: (account: { enabled: boolean }) => account.enabled,
    admitted: (message: { conversationId: string }) => message.conversationId === '19:uni01_synthetic@thread.v2',
    groupAdmitted: (message: { conversationId: string }) => ['19:synthetic@thread.v2', '19:synthetic-new@thread.v2'].includes(message.conversationId),
    targetAllowed: (id: string) => ['19:synthetic@thread.v2', '19:synthetic-new@thread.v2', '19:uni01_synthetic@thread.v2'].includes(id),
  };
  const config = { channels: { 'teams-personal': { enabled: true } } };
  const history = [{ sender: 'Synthetic user', body: 'untagged context', messageId: '1794800000000' }];
  const quote = { id: '1794800000000', body: 'quoted context', senderAllowed: true, isQuote: true };
  let built: any;
  let dispatched = false;
  let monitor: any;
  const entry = createTeamsChannel({ policy,
    getSkypeToken: async () => ({ token: 'not-used' }), hasSavedLogin: () => true,
    createTeamsClient: () => ({ whoAmI: async () => ({ mri: policy.BOT }),
      sendMessage: async (to: string, text: string) => { assert.equal(to, group); assert.equal(text, 'synthetic reply'); return { arrivalTime: '1794800000002' }; },
    }),
    receiver: async ({ admit }: { admit: (m: unknown) => Promise<void> }) => {
      await admit({ conversationId: group, id: '1794800000001', text: 'current request',
        time: new Date().toISOString(), fromId: policy.SENDER, from: 'Synthetic user',
        mentions: [{ mri: policy.BOT }], history, quote });
    },
    sdk: {
      defineChannelPluginEntry: (value: unknown) => value,
      createChannelMessageAdapterFromOutbound: () => ({}), bindIngressLifecycleToReplyOptions: () => ({}),
      createChannelIngressMonitor: (options: any) => {
        monitor = { start() {}, stop() {}, admit: (message: unknown) => options.deliver(message, {}) };
        return monitor;
      },
      dispatchChannelInboundTurn: async ({ ctxPayload, delivery }: any) => { assert.equal(ctxPayload, built); await delivery.deliver({ text: 'synthetic reply' }); dispatched = true; },
      dispatchInboundDirectDm: async () => { throw new Error('Group must not route into DM dispatcher'); },
    },
  });
  entry.setRuntime({ config: { current: () => config }, state: { resolveStateDir: () => root } });
  try {
    await entry.plugin.gateway.startAccount({ cfg: config, abortSignal: new AbortController().signal, setStatus() {},
      channelRuntime: {
        routing: { resolveAgentRoute: ({ peer }: any) => { assert.equal(peer.id, group); return { agentId: 'test', sessionKey: `session:${group}` }; } },
        inbound: {
          ingress: { resolveStable: async (args: any) => { assert.equal(args.conversation.id, group); assert.equal(args.route.id, group); assert.equal(args.groupPolicy, 'allowlist'); assert.deepEqual(args.groupAllowFrom, ['*']); return { senderAccess: { allowed: true } }; } },
          buildContext: async (value: unknown) => { built = value; return value; },
        },
      },
    });
    assert.equal(dispatched, true);
    assert.deepEqual(built.message.inboundHistory, history);
    assert.deepEqual(built.supplemental.quote, quote);
    assert.equal(built.message.rawBody, 'current request');
    assert.equal(built.access.commands.authorized, false);
    assert.equal(built.access.mentions.requireMention, true);
    assert.equal(built.route.dispatchSessionKey, `session:${group}`);
    assert.equal(built.conversation.id, group);
    assert.equal(built.conversation.label, `label:${group}`);
    assert.equal(built.reply.to, group);
    await assert.rejects(entry.plugin.outbound.sendText({ cfg: config, to: '19:unapproved@thread.v2', text: 'must not send' }), /destination not approved/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
