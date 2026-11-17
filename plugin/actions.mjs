import { checkCredential } from '../src/auth.ts';

// Native message actions retain the host's direct-adapter authority boundary.
export function createTeamsActions({ policy, currentConfig, getSkypeToken,
  createTeamsClient, reactionEmojis, normalizeReactionKey, jsonResult }) {
  const { CHANNEL, BOT, validConfig, targetAllowed, normalizedTarget } = policy;
  const configured = cfg => validConfig({ accountId: 'default', ...cfg.channels?.[CHANNEL] });
  return {
    describeMessageTool: ({ cfg, accountId }) => ({
      actions: configured(cfg) && (!accountId || accountId === 'default') ? ['send', 'react', 'emoji-list', 'read', 'edit', 'delete'] : [],
    }),
    supportsAction: ({ action }) => ['react', 'emoji-list', 'read', 'edit', 'delete'].includes(action),
    handleAction: async ctx => {
      const assertAuthority = () => {
        ctx.assertDirectAdapterHandoff?.();
        if (ctx.accountId && ctx.accountId !== 'default') throw new Error('Teams Personal account not approved');
        if (!configured(currentConfig())) throw new Error('Teams Personal policy not enabled or differs from approved account');
      };
      assertAuthority();
      if (ctx.action === 'emoji-list') return jsonResult({ ok: true, emojis: reactionEmojis });
      if (!['react', 'read', 'edit', 'delete'].includes(ctx.action)) throw new Error('Unsupported Teams Personal action');
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
      if (ctx.action !== 'react') {
        if (!current || normalizedTarget(current) !== chatId) throw new Error('Teams message actions are limited to the current conversation');
        if (explicitId !== undefined && !/^[1-9]\d{0,23}$/.test(String(explicitId))) throw new Error('A valid messageId is required');
        if (['edit', 'delete'].includes(ctx.action) && !explicitId) throw new Error('Editing/deletion requires an explicit bot-owned messageId');
        const text = params.message ?? params.text;
        if (ctx.action === 'edit' && (typeof text !== 'string' || !text.trim())) throw new Error('Replacement message text is required');
        if (ctx.dryRun) return jsonResult({ ok: true, dryRun: true, action: ctx.action, chatId, messageId: explicitId });
        const guarded = createTeamsClient(async () => {
          assertDestination(); const auth = await getSkypeToken(); assertDestination(); return checkCredential(auth, BOT);
        });
        let result;
        if (ctx.action === 'read') result = explicitId ? await guarded.getMessage(chatId, String(explicitId))
          : await guarded.getMessages(chatId, { limit: params.limit ?? 30, before: params.before, after: params.after });
        if (ctx.action === 'edit') result = await guarded.editMessage(chatId, String(explicitId), text);
        if (ctx.action === 'delete') result = await guarded.deleteMessage(chatId, String(explicitId));
        assertDestination(); return jsonResult({ ok: true, channel: CHANNEL, chatId, ...(['edit', 'delete'].includes(ctx.action) ? result : { messages: result }) });
      }
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
