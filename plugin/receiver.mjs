import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { listen } from '../src/transport.ts';
import { checkCredential } from '../src/auth.ts';
import { normalize, eventResource } from '../src/messages.ts';
import { trustedUrl, object } from '../src/protocol.ts';
import { request, readJson } from '../src/http.ts';
import { isGroupId, isDmId } from './enrollment.mjs';
import { PocError } from '../src/errors.ts';
import { attachmentList } from '../src/client.mjs';

// Ephemeral context is isolated by conversation, bounded, and refreshed by edits.
export class ContextWindow {
  windows = new Map();
  record(message) {
    const items = this.windows.get(message.conversationId) ?? [];
    const previous = items.findIndex(item => item.id === message.id);
    if (previous >= 0 && /^\d+$/.test(items[previous].version) && /^\d+$/.test(message.version) && BigInt(message.version) < BigInt(items[previous].version)) return;
    if (previous >= 0) items.splice(previous, 1);
    items.push(message); // Retain bounded deletion tombstones against stale history.
    items.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
    this.windows.set(message.conversationId, items.slice(-100));
  }
  find(chat, id) { return this.windows.get(chat)?.find(item => item.id === id && !item.deleted); }
  history(chat, current) {
    const result = [];
    let budget = 20_000;
    const entries = (this.windows.get(chat) ?? []).filter(item => !item.deleted && BigInt(item.id) < BigInt(current.id)).slice(-50);
    for (const item of entries.reverse()) {
      const body = item.text.slice(0, Math.min(4000, budget));
      if (!body) break;
      result.push({ sender: `${item.from} (${item.fromId})`, body, timestamp: Date.parse(item.time), messageId: item.id });
      budget -= body.length;
      if (budget <= 0) break;
    }
    return result.reverse();
  }
}

export function channelMessage(raw, type, chat, bot) {
  const message = normalize(raw, type, { chatId: chat, expectedAccount: bot }, true);
  if (!message) return null;
  const attachments = attachmentList(raw).map(({ index, kind, name }) => ({ index, kind, name }));
  return {
    id: message.id, version: message.version, conversationId: chat, fromId: message.author.id, from: message.author.name,
    isMine: message.author.id === bot, time: message.time, text: message.text || (attachments.length ? '[附件]' : ''), attachments,
    mentions: message.mentions.map(item => ({ mri: item.id, name: item.name })),
    edited: message.kind === 'update' || Boolean(raw.properties?.edittime), deleted: message.kind === 'delete',
    forwarded: Boolean(raw.properties?.originalMessageContext),
    ...(message.replyTo ? { replyTo: { messageId: message.replyTo.id, preview: message.replyTo.preview, fromId: message.replyTo.authorId } } : {}),
  };
}

export async function runReceiver({ authProvider, policy, stateDir, admit, assertAuthority, status, log, signal,
  fetcher = fetch, makeSocket = url => new WebSocket(url) }) {
  const { CHAT, GROUP, BOT, SENDER, admitted, groupAdmitted } = policy;
  const groups = () => policy.GROUPS ?? [GROUP];
  const dms = () => policy.DM_CHATS ?? [CHAT];
  const chats = () => [...dms(), ...groups()];
  const dmSenderAllowed = (chat, sender) => sender === BOT ||
    (policy.dmAllowFrom?.(chat) ?? (chat === CHAT ? [SENDER] : [])).includes(sender);
  const startedAt = Date.now();
  if (new Set(chats()).size !== chats().length) throw new PocError('Invalid realtime chat scope');
  const context = new ContextWindow();
  const statePath = path.join(stateDir, 'realtime-state.json');
  let state;
  try { state = JSON.parse(await fs.readFile(statePath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // The legacy cursor is a migration fence, never reset or deleted.
    const previous = JSON.parse(await fs.readFile(path.join(stateDir, 'watermark.json'), 'utf8'));
    state = { version: 1, endpointId: randomUUID(), bot: BOT,
      chats: { [CHAT]: { baseline: previous.lastId, since: previous.since, repairedThrough: Number(previous.lastId) || previous.since },
        [GROUP]: { baseline: previous.group.lastId, since: previous.group.since, repairedThrough: Number(previous.group.lastId) || previous.group.since } } };
  }
  if (state.version !== 1 || state.bot !== BOT || !/^[\da-f-]{36}$/.test(state.endpointId) || !state.chats?.[CHAT] || !state.chats?.[GROUP] || Object.keys(state.chats).some(chat => chat !== CHAT && !isGroupId(chat) && !isDmId(chat))) throw new PocError('Realtime migration scope mismatch');
  // New chats start at activation; an enrolled group retains its triggering tag.
  // Existing cursors and the transport endpoint are preserved when adding a chat.
  const activate = (chat) => {
    if (!state.chats[chat]) {
      const direct = dms().includes(chat);
      const entry = direct ? policy.dmEntry?.(chat) : policy.groupEntry?.(chat);
      const trigger = entry?.activationId;
      const since = entry?.activatedAt ?? Date.now();
      if (!Number.isFinite(since) || trigger && !/^[1-9]\d{0,23}$/.test(trigger)) throw new PocError('Invalid chat activation fence');
      state.chats[chat] = { baseline: trigger ? String(BigInt(trigger) - 1n) : String(since), since, repairedThrough: since };
    }
  };
  for (const chat of chats()) activate(chat);
  for (const chat of Object.keys(state.chats)) {
    const item = state.chats[chat];
    if (!/^\d+$/.test(item.baseline) || !Number.isFinite(item.since) || !Number.isFinite(item.repairedThrough)) throw new PocError('Invalid realtime migration state');
  }
  const save = async () => {
    await fs.writeFile(statePath + '.tmp', JSON.stringify(state), { mode: 0o600 });
    await fs.rename(statePath + '.tmp', statePath);
  };
  await save();
  const auth = async () => { assertAuthority(); return checkCredential(await authProvider(), BOT); };
  const accept = async (message, source) => {
    if (!message || !chats().includes(message.conversationId)) return;
    if (dms().includes(message.conversationId) && !dmSenderAllowed(message.conversationId, message.fromId)) return;
    context.record(message);
    if (source === 'push') {
      const kind = message.deleted ? 'delete' : message.edited ? 'update' : 'message';
      status({ lastEventAt: Date.now(), lastEventId: message.id, lastEventKind: kind });
      log('scoped_event', { chat: message.conversationId, id: message.id, kind, self: message.isMine });
    }
    const item = state.chats[message.conversationId];
    if (message.deleted || message.edited || BigInt(message.id) <= BigInt(item.baseline)) return;
    const original = message.replyTo?.messageId ? context.find(message.conversationId, message.replyTo.messageId) : undefined;
    message.replyToBot = Boolean(original?.fromId === BOT && original.isMine);
    const allowed = dms().includes(message.conversationId) ? admitted(message, item.since) : groupAdmitted(message, item.since);
    if (!allowed) return;
    const history = groups().includes(message.conversationId) ? context.history(message.conversationId, message) : undefined;
    const quote = message.replyTo ? {
      id: message.replyTo.messageId, body: original?.text ?? message.replyTo.preview,
      sender: original?.from ?? message.replyTo.fromId, senderAllowed: true, isQuote: true,
    } : undefined;
    assertAuthority();
    await admit({ ...message, history, quote });
    status({ lastInboundAt: Date.now() });
  };
  const body = async (value) => {
    const event = eventResource(value);
    if (!event || !event.resource) return;
    const raw = object(event.resource);
    const chat = raw.conversationid ?? raw.conversationId ?? (() => {
      const match = /\/conversations\/([^/?#]+)/.exec(String(raw.conversationLink ?? raw.resourceLink ?? ''));
      return match ? decodeURIComponent(match[1]) : undefined;
    })();
    if (!chats().includes(chat)) {
      // Account-wide push facts are checked before the unknown-room rejection;
      // ordinary traffic is neither cached nor logged nor sent to the model.
      if (event.type !== 'NewMessage' || !isGroupId(chat)) return;
      const candidate = channelMessage(raw, event.type, chat, BOT);
      if (!candidate || !policy.ownerMentionAllowed?.(candidate, startedAt)) return;
      assertAuthority();
      // No room persistence, context cache, discovery history or transport cursor.
      // Native ingress deduplicates this exact event; every later event is gated anew.
      await admit(candidate);
      log('owner_mention_once', { chat, id: candidate.id });
      status({ lastInboundAt: Date.now() });
      return;
    }
    if (chat !== CHAT && !state.chats[chat]) { activate(chat); await save(); }
    const previous = context.find(chat, raw.id);
    const resource = event.type === 'MessageUpdate' && previous ? {
      from: previous.fromId, imdisplayname: previous.from, messagetype: 'Text', content: previous.text,
      originalarrivaltime: previous.time, ...raw,
      properties: { mentions: previous.mentions.map(item => ({ mri: item.mri, displayName: item.name })), ...raw.properties },
    } : raw;
    await accept(channelMessage(resource, event.type, chat, BOT), 'push');
  };
  const repair = async () => {
    for (const chat of chats()) {
      if (chat !== CHAT) activate(chat);
      const checkpoint = Date.now();
      const fence = Math.max(state.chats[chat].since, state.chats[chat].repairedThrough - 120_000);
      let next = `https://teams.live.com/api/chatsvc/consumer/v1/users/ME/conversations/${encodeURIComponent(chat)}/messages?startTime=0&pageSize=100&view=msnp24Equivalent`;
      const recovered = [];
      let complete = false;
      for (let page = 0; page < 5; page++) {
        const url = trustedUrl(next, 'history');
        const target = /\/conversations\/([^/]+)\/messages$/.exec(url.pathname)?.[1];
        if (!target || decodeURIComponent(target) !== chat) throw new PocError('Realtime history boundary mismatch');
        const credential = await auth();
        const response = await request(fetcher, url, { headers: {
          Authentication: `skypetoken=${credential.token}`, 'ms-ic3-product': 'tfl', 'ms-ic3-additional-product': 'Sfl',
          'X-MS-Client-Consumer-Type': 'teams4life', BehaviorOverride: 'redirectAs404', Accept: 'application/json',
        } }, signal);
        const result = await readJson(response);
        if (!Array.isArray(result.messages)) throw new PocError('Realtime history lacks messages');
        let reached = false;
        for (const raw of result.messages) {
          const resource = object(raw);
          const id = resource.conversationid ?? resource.conversationId ?? chat;
          if (id !== chat) continue;
          const message = channelMessage({ ...resource, conversationid: chat }, resource.properties?.edittime ? 'MessageUpdate' : 'NewMessage', chat, BOT);
          if (!message) continue;
          recovered.push(message);
          if (Date.parse(message.time) < fence) reached = true;
        }
        const older = result._metadata && object(result._metadata).backwardLink;
        if (reached || typeof older !== 'string') { complete = true; break; }
        next = older;
      }
      for (const message of recovered.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1)) await accept(message, 'repair');
      if (!complete) throw new PocError('Realtime history gap exceeds five pages');
      state.chats[chat].repairedThrough = checkpoint;
      await save();
    }
    log('scoped_history_repaired');
  };
  await listen({ auth, fetch: fetcher, socket: makeSocket, onBody: body, onReady: repair, onLoss: repair,
    onDisconnected: () => status({ connected: false }),
    log: (event, data) => {
      log(event, data);
      if (event === 'registered' || event === 'registration_renewed') status({ connected: true, lastError: null });
      if (event === 'session_failed') status({ connected: false, lastError: data?.reason ?? 'Trouter session failed' });
    },
  }, { endpointId: state.endpointId, registrar: 'https://teams.microsoft.com/registrar/prod/v2/registrations' }, signal);
}
