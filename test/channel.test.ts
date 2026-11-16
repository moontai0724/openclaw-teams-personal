import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeamsChannel } from '../plugin/index.mjs';

test('channel adapter passes recent untagged context and quote into native ingress without broadening policy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teams-channel-test-'));
  const policy = {
    CHANNEL: 'teams-personal', CHAT: '19:uni01_synthetic@thread.v2', GROUP: '19:synthetic@thread.v2',
    BOT: '8:live:.cid.synthetic', SENDER: '8:orgid:synthetic-user',
    normalizedTarget: (target: string) => target,
    validConfig: (account: { enabled: boolean }) => account.enabled,
    admitted: (message: { conversationId: string }) => message.conversationId === '19:uni01_synthetic@thread.v2',
    groupAdmitted: (message: { conversationId: string }) => message.conversationId === '19:synthetic@thread.v2',
    targetAllowed: () => false,
  };
  const config = { channels: { 'teams-personal': { enabled: true } } };
  const history = [{ sender: 'Synthetic user', body: 'untagged context', messageId: '1794800000000' }];
  const quote = { id: '1794800000000', body: 'quoted context', senderAllowed: true, isQuote: true };
  let built: any;
  let dispatched = false;
  let monitor: any;
  const entry = createTeamsChannel({ policy,
    getSkypeToken: async () => ({ token: 'not-used' }), hasSavedLogin: () => true,
    createTeamsClient: () => ({ whoAmI: async () => ({ mri: policy.BOT }) }),
    receiver: async ({ admit }: { admit: (m: unknown) => Promise<void> }) => {
      await admit({ conversationId: policy.GROUP, id: '1794800000001', text: 'current request',
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
      dispatchChannelInboundTurn: async ({ ctxPayload }: any) => { assert.equal(ctxPayload, built); dispatched = true; },
      dispatchInboundDirectDm: async () => { throw new Error('Group must not route into DM dispatcher'); },
    },
  });
  entry.setRuntime({ config: { current: () => config }, state: { resolveStateDir: () => root } });
  try {
    await entry.plugin.gateway.startAccount({ cfg: config, abortSignal: new AbortController().signal, setStatus() {},
      channelRuntime: {
        routing: { resolveAgentRoute: () => ({ agentId: 'test', sessionKey: 'synthetic-group-session' }) },
        inbound: {
          ingress: { resolveStable: async (args: any) => { assert.equal(args.groupPolicy, 'allowlist'); assert.deepEqual(args.groupAllowFrom, ['*']); return { senderAccess: { allowed: true } }; } },
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
    assert.equal(built.route.dispatchSessionKey, 'synthetic-group-session');
  } finally { await rm(root, { recursive: true, force: true }); }
});
