import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeamsChannel } from '../plugin/index.mjs';

for (const group of ['19:synthetic@thread.v2', '19:synthetic-new@thread.v2', '19:uni01_synthetic@thread.v2', '19:uni01_member@thread.v2', '19:synthetic-once@thread.v2']) test(`channel routes replies and typing only into the approved conversation: ${group}`, async () => {
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
  const member = '8:orgid:synthetic-member';
  const newDm = '19:uni01_member@thread.v2';
  const config = { channels: { 'teams-personal': { enabled: true,
    dms: { [newDm]: { allowFrom: [member], activatedAt: 1, enabled: true } } } } };
  const direct = group.startsWith('19:uni01_');
  const ownerOnce = group === '19:synthetic-once@thread.v2';
  (config.channels['teams-personal'] as any).enrollmentOwnerId = policy.SENDER;
  const sender = group === newDm ? member : policy.SENDER;
  const history = [{ sender: 'Synthetic user', body: 'untagged context', messageId: '1794800000000' }];
  const quote = { id: '1794800000000', body: 'quoted context', senderAllowed: true, isQuote: true };
  let built: any;
  let dispatched = false;
  let monitor: any;
  let typingOptions: any;
  let typingCleaned = false;
  let dispatchMode = 'reply';
  const originalFile = Buffer.from('synthetic original document');
  const presenceStates: unknown[] = [];
  const abort = new AbortController();
  const typingCallbacks = { onReplyStart() {}, onIdle() {}, onCleanup() { typingCleaned = true; } };
  const entry = createTeamsChannel({ policy,
    getSkypeToken: async () => ({ token: 'not-used' }), hasSavedLogin: () => true,
    createTeamsClient: (_auth: any, options: any = {}) => ({ whoAmI: async () => ({ mri: policy.BOT }),
      sendMessage: async (to: string, text: string) => { options.assertChat?.(to); assert.equal(to, group); assert.equal(text, 'synthetic reply'); return { arrivalTime: '1794800000002' }; },
      readAttachment: async (to: string, id: string, index: number) => {
        options.assertChat?.(to); assert.equal(to, group); assert.equal(id, '1794800000001'); assert.equal(index, 0);
        return { bytes: originalFile, contentType: 'application/octet-stream', name: 'original.bin' };
      },
    }),
    makePresence: () => ({ setConnected: (value: boolean) => presenceStates.push(value),
      stop: async () => { presenceStates.push('stopped'); } }),
    receiver: async ({ admit, status }: { admit: (m: unknown) => Promise<void>; status: (fields: unknown) => void }) => {
      status({ connected: true });
      status({ lastInboundAt: Date.now() });
      await admit({ conversationId: group, id: '1794800000001', text: 'current request',
        time: new Date().toISOString(), fromId: sender, from: 'Synthetic user', isMine: false,
        mentions: [{ mri: policy.BOT }], history, quote, attachments: [{ index: 0, kind: 'file', name: 'original.bin' }] });
      status({ connected: false });
    },
    sdk: {
      defineChannelPluginEntry: (value: unknown) => value,
      saveMediaBuffer: async (bytes: Buffer, contentType: string, _subdir: any, _max: any, _name: any, _unused: any, guards: any) => {
        guards.assertCommitAllowed();
        assert.deepEqual(bytes, originalFile); assert.equal(contentType, 'application/octet-stream');
        return { path: '/synthetic/original.bin' };
      },
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
        if (dispatchMode === 'revoke') config.channels['teams-personal'].dms[newDm].enabled = false;
        if (dispatchMode === 'revoke-owner') delete (config.channels['teams-personal'] as any).enrollmentOwnerId;
        await delivery.deliver({ text: 'synthetic reply' }); dispatched = true;
      },
      dispatchInboundDirectDm: async () => { throw new Error('Group must not route into DM dispatcher'); },
    },
  });
  let toolFactory: any;
  entry.registerFull({ runtime: { config: { current: () => config } }, registerTool: (factory: any) => { toolFactory = factory; } });
  const chatTool = toolFactory({ messageChannel: 'teams-personal', nativeChannelId: group });
  assert.equal(chatTool?.name ?? null, ownerOnce ? null : 'teams_chat');
  assert.equal(toolFactory({ messageChannel: 'telegram', nativeChannelId: group }), null);
  entry.setRuntime({ config: { current: () => config }, state: { resolveStateDir: () => root } });
  try {
    await entry.plugin.gateway.startAccount({ cfg: config, abortSignal: abort.signal, setStatus() {},
      channelRuntime: {
        routing: { resolveAgentRoute: ({ peer }: any) => { assert.equal(peer.id, group); return { agentId: 'test', sessionKey: `session:${group}` }; } },
        inbound: {
          ingress: { resolveStable: async (args: any) => {
            assert.equal(args.conversation.id, group);
            assert.equal(args.groupPolicy, direct ? 'disabled' : 'allowlist');
            if (direct) { assert.deepEqual(args.allowFrom, [sender]); assert.equal(args.subject.stableId, sender); }
            else { assert.equal(args.route.id, group); assert.deepEqual(args.groupAllowFrom, ownerOnce ? [policy.SENDER] : ['*']); }
            return { senderAccess: { allowed: true } };
          } },
          buildContext: async (value: unknown) => { built = value; return value; },
        },
      },
    });
    assert.deepEqual(entry.plugin.config.resolveAllowFrom(config), [policy.SENDER, member]);
    assert.deepEqual(entry.plugin.security.resolveDmPolicy({ cfg: config }).allowFrom, [policy.SENDER, member]);
    assert.equal(dispatched, true);
    assert.equal((config.channels['teams-personal'] as any).groups, undefined);
    assert.deepEqual(presenceStates, [true, false, 'stopped']);
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
      assert.equal(built.extra.NativeDirectUserId, group);
      assert.equal(built.message.inboundHistory, undefined);
    }
    assert.equal(built.message.rawBody, 'current request');
    assert.deepEqual(built.media, [{ path: '/synthetic/original.bin', contentType: 'application/octet-stream',
      fileName: 'original.bin', kind: 'document', messageId: '1794800000001' }]);
    assert.equal(built.access.commands.authorized, false);
    assert.equal(built.route.dispatchSessionKey, `session:${group}`);
    assert.equal(built.conversation.id, group);
    assert.equal(built.conversation.label, direct ? 'Synthetic user' : `label:${group}`);
    assert.equal(built.reply.to, group);
    await assert.rejects(entry.plugin.outbound.sendText({ cfg: config, to: '19:unapproved@thread.v2', text: 'must not send' }), /destination not approved/);
    const next = { conversationId: group, id: '1794800000003', text: 'next request', time: new Date().toISOString(), fromId: sender, isMine: false, mentions: [{ mri: policy.BOT }] };
    if (ownerOnce) {
      await assert.rejects(monitor.admit({ ...next, fromId: '8:orgid:member' }), /no longer admitted/);
      await assert.rejects(monitor.admit({ ...next, mentions: [] }), /no longer admitted/);
      await assert.rejects(entry.plugin.outbound.sendText({ cfg: config, to: group, text: 'not a turn-bound reply' }), /destination not approved/);
    }
    typingCleaned = false;
    dispatchMode = 'error';
    await assert.rejects(monitor.admit(next), /synthetic dispatch failure/);
    assert.equal(typingCleaned, true);
    typingCleaned = false;
    dispatchMode = 'deferred';
    await monitor.admit(next);
    assert.equal(typingCleaned, false); // Deferred run still owns its callbacks.
    if (ownerOnce) {
      dispatchMode = 'revoke-owner';
      await assert.rejects(monitor.admit(next), /owner authorization revoked/);
      (config.channels['teams-personal'] as any).enrollmentOwnerId = policy.SENDER;
    }
    if (!direct) {
      (config.channels['teams-personal'] as any).groups = { [group]: { enabled: false } };
      await assert.rejects(monitor.admit({ conversationId: group, id: '1794800000003' }), /no longer admitted/);
    }
    if (direct) {
      await assert.rejects(monitor.admit({ ...next, fromId: '8:orgid:unapproved' }), /no longer admitted/);
      assert.equal(built.sender.id, sender);
    }
    if (group === newDm) {
      dispatchMode = 'revoke';
      await assert.rejects(monitor.admit(next), /no longer admitted/);
      assert.equal(toolFactory({ messageChannel: 'teams-personal', nativeChannelId: group }), null);
      await assert.rejects(entry.plugin.outbound.sendText({ cfg: config, to: group, text: 'revoked' }), /destination not approved/);
      await assert.rejects(monitor.admit(next), /no longer admitted/);
    }
    abort.abort();
    assert.equal(typingCleaned, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
