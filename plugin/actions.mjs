import { checkCredential } from '../src/auth.ts';

// Reuse the installed client's emoji catalogue and emotion-property API.
export function createTeamsActions({ policy, currentConfig, getSkypeToken,
  createTeamsClient, reactionEmojis, normalizeReactionKey, jsonResult }) {
  const { CHANNEL, BOT, validConfig, targetAllowed, normalizedTarget } = policy;
  const configured = cfg => validConfig({ accountId: 'default', ...cfg.channels?.[CHANNEL] });
  return {
    describeMessageTool: ({ cfg, accountId }) => ({
      actions: configured(cfg) && (!accountId || accountId === 'default') ? ['send', 'react', 'emoji-list'] : [],
    }),
    supportsAction: ({ action }) => ['react', 'emoji-list'].includes(action),
    handleAction: async ctx => {
      const assertAuthority = () => {
        ctx.assertDirectAdapterHandoff?.();
        if (ctx.accountId && ctx.accountId !== 'default') throw new Error('Teams Personal account not approved');
        if (!configured(currentConfig())) throw new Error('Teams Personal policy not enabled or differs from approved account');
      };
      assertAuthority();
      if (ctx.action === 'emoji-list') return jsonResult({ ok: true, emojis: reactionEmojis });
      if (ctx.action !== 'react') throw new Error('Unsupported Teams Personal action');
      const { params, toolContext } = ctx;
      const destinations = [params.to, params.target, params.chatId, params.channelId]
        .filter(value => value !== undefined && value !== null);
      const current = toolContext?.currentChannelProvider === CHANNEL
        ? toolContext.currentMessagingTarget ?? toolContext.currentChannelId : undefined;
      const to = destinations[0] ?? current;
      if (!targetAllowed(to) || destinations.some(value => normalizedTarget(value) !== normalizedTarget(to))) {
        throw new Error('Teams Personal destination not approved or conflicting');
      }
      const chatId = normalizedTarget(to);
      const assertDestination = () => { assertAuthority(); if (!targetAllowed(chatId)) throw new Error('Teams Personal destination no longer approved'); };
      const explicitId = params.messageId ?? params.message_id;
      // Never borrow the current message ID for another conversation or provider.
      const id = explicitId ?? (current && normalizedTarget(current) === chatId ? toolContext.currentMessageId : undefined);
      if ((typeof id !== 'string' && !(typeof id === 'number' && Number.isSafeInteger(id))) || !/^[1-9]\d{0,23}$/.test(String(id))) {
        throw new Error('Teams reaction requires a valid messageId; do not guess or retry');
      }
      const messageId = String(id);
      if (params.remove !== undefined && typeof params.remove !== 'boolean') throw new Error('Reaction remove must be boolean');
      if (typeof params.emoji !== 'string' || !params.emoji.trim()) throw new Error('Emoji is required, including when removing a reaction');
      const key = normalizeReactionKey(params.emoji);
      const remove = params.remove === true;
      const result = { channel: CHANNEL, chatId, messageId, key, remove };
      if (ctx.dryRun) return jsonResult({ ok: true, dryRun: true, ...result });
      const client = createTeamsClient(async () => {
        assertDestination();
        const credential = await getSkypeToken();
        assertDestination();
        checkCredential(credential, BOT);
        return credential;
      });
      const read = async () => {
        assertDestination();
        const message = await client.getMessage(chatId, messageId);
        assertDestination();
        if (String(message.id) !== messageId || message.conversationId !== chatId) throw new Error('Teams reaction readback target mismatch');
        return message.reactions?.some(reaction => reaction.key === key && reaction.mine === true) === true;
      };
      const wanted = !remove;
      if (await read() === wanted) return jsonResult({ ok: true, ...result, changed: false, verified: true });
      assertDestination();
      let writeFailed = false;
      try { await client.react(chatId, messageId, key, { remove }); }
      catch { writeFailed = true; } // A lost response may still have changed the platform.
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await new Promise(resolve => setTimeout(resolve, attempt * 250));
        let matches;
        try { matches = await read() === wanted; }
        catch { break; }
        if (matches) return jsonResult({ ok: true, ...result, changed: true, verified: true, reconciled: writeFailed });
      }
      // Never resend on an unknown outcome. Reconcile by reading the same message.
      return jsonResult({ ok: false, ...result, verified: false, reason: 'reaction_not_verified',
        hint: 'Platform outcome is unverified. Read back this message before retrying; do not resend automatically.' });
    },
  };
}
