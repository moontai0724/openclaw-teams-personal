import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeamsChannel } from '../plugin/index.mjs';

for (const group of ['19:synthetic@thread.v2', '19:synthetic-new@thread.v2', '19:uni01_synthetic@thread.v2']) test(`channel routes replies and typing only into the approved conversation: ${group}`, async () => {
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
  const direct = group === policy.CHAT;
  const history = [{ sender: 'Synthetic user', body: 'untagged context', messageId: '1794800000000' }];
  const quote = { id: '1794800000000', body: 'quoted context', senderAllowed: true, isQuote: true };
  let built: any;
  let dispatched = false;
  let monitor: any;
  let typingOptions: any;
  let typingCleaned = false;
  let dispatchMode = 'reply';
  const abort = new AbortController();
  const typingCallbacks = { onReplyStart() {}, onIdle() {}, onCleanup() { typingCleaned = true; } };
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
      createTypingCallbacks: (options: any) => { typingOptions = options; return typingCallbacks; },
      createChannelInboundEnvelopeBuilderAsync: async ({ cfg }: any) => {
        assert.equal(cfg.session.dmScope, 'per-channel-peer');
        return ({ body }: any) => `synthetic envelope: ${body}`;
      },
      createChannelMessageAdapterFromOutbound: () => ({}), bindIngressLifecycleToReplyOptions: () => ({}),
      createChannelIngressMonitor: (options: any) => {
        monitor = { start() {}, stop() {}, admit: (message: unknown) => options.deliver(message, {}) };
        return monitor;
      },
      dispatchChannelInboundTurn: async ({ cfg, ctxPayload, delivery, replyPipeline }: any) => {
        assert.equal(cfg.session.typingMode, 'instant');
        assert.equal(replyPipeline.typingCallbacks.onReplyStart, typingCallbacks.onReplyStart);
        assert.equal(ctxPayload, built);
        if (dispatchMode === 'error') throw new Error('synthetic dispatch failure');
        if (dispatchMode === 'deferred') return { dispatchResult: { deferredToActiveRun: true } };
        await delivery.deliver({ text: 'synthetic reply' }); dispatched = true;
      },
      dispatchInboundDirectDm: async () => { throw new Error('Group must not route into DM dispatcher'); },
    },
  });
  entry.setRuntime({ config: { current: () => config }, state: { resolveStateDir: () => root } });
  try {
    await entry.plugin.gateway.startAccount({ cfg: config, abortSignal: abort.signal, setStatus() {},
      channelRuntime: {
        routing: { resolveAgentRoute: ({ peer }: any) => { assert.equal(peer.id, group); return { agentId: 'test', sessionKey: `session:${group}` }; } },
        inbound: {
          ingress: { resolveStable: async (args: any) => {
            assert.equal(args.conversation.id, group);
            assert.equal(args.groupPolicy, direct ? 'disabled' : 'allowlist');
            if (direct) assert.deepEqual(args.allowFrom, [policy.SENDER]);
            else { assert.equal(args.route.id, group); assert.deepEqual(args.groupAllowFrom, ['*']); }
            return { senderAccess: { allowed: true } };
          } },
          buildContext: async (value: unknown) => { built = value; return value; },
        },
      },
    });
    assert.equal(dispatched, true);
    assert.equal(typingCleaned, true);
    assert.equal(typingOptions.keepaliveIntervalMs, 4000);
    assert.equal(typingOptions.maxDurationMs, 600000);
    assert.equal((config as any).session, undefined);
    if (!direct) {
      assert.deepEqual(built.message.inboundHistory, history);
      assert.deepEqual(built.supplemental.quote, quote);
      assert.equal(built.access.mentions.requireMention, true);
    } else {
      assert.equal(built.conversation.kind, 'direct');
      assert.equal(built.message.body, 'synthetic envelope: current request');
      assert.equal(built.extra.NativeDirectUserId, policy.CHAT);
      assert.equal(built.message.inboundHistory, undefined);
    }
    assert.equal(built.message.rawBody, 'current request');
    assert.equal(built.access.commands.authorized, false);
    assert.equal(built.route.dispatchSessionKey, `session:${group}`);
    assert.equal(built.conversation.id, group);
    assert.equal(built.conversation.label, direct ? '月太' : `label:${group}`);
    assert.equal(built.reply.to, group);
    await assert.rejects(entry.plugin.outbound.sendText({ cfg: config, to: '19:unapproved@thread.v2', text: 'must not send' }), /destination not approved/);
    const next = { conversationId: group, id: '1794800000003', text: 'next request', time: new Date().toISOString(), fromId: policy.SENDER };
    typingCleaned = false;
    dispatchMode = 'error';
    await assert.rejects(monitor.admit(next), /synthetic dispatch failure/);
    assert.equal(typingCleaned, true);
    typingCleaned = false;
    dispatchMode = 'deferred';
    await monitor.admit(next);
    assert.equal(typingCleaned, false); // Deferred run still owns its callbacks.
    if (!direct) {
      (config.channels['teams-personal'] as any).groups = { [group]: { enabled: false } };
      await assert.rejects(monitor.admit({ conversationId: group, id: '1794800000003' }), /Group destination no longer approved/);
    }
    abort.abort();
    assert.equal(typingCleaned, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
