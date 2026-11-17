import { PocError } from "./errors.ts";
import { createHash } from 'node:crypto';
import { object, type Json } from './protocol.ts';
import type { Scope } from './scope.ts';

export type Message = {
  kind: 'message' | 'update' | 'delete'; chatId: string; id: string; version: string;
  author: { id: string; name: string }; time: string; text: string;
  mentions: { id: string; name: string }[];
  replyTo?: { id: string; authorId?: string; preview: string };
};

export function plainText(value: string): string {
  return value.replace(/<img\b[^>]*\balt="([^"]*)"[^>]*>/gi, '$1')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(?:p|div|li)>/gi, '\n')
    .replace(/<[^>]*>/g, '').replace(/&#(?:x([\da-f]+)|(\d+));/gi, (_all, hex, dec) => {
      const code = Number.parseInt(hex ?? dec, hex ? 16 : 10);
      return code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
    }).replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/g, (_all, entity) => ({
      nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'",
    })[entity] ?? '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

function parseProperty(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return undefined; }
}
function idFromLink(value: unknown, type: 'contact' | 'conversation'): string | undefined {
  if (typeof value !== 'string') return;
  if (type === 'contact' && value.startsWith('8:')) return value;
  const match = (type === 'contact' ? /\/contacts\/([^/?#]+)/ : /\/conversations\/([^/?#]+)/).exec(value);
  if (!match) return;
  try { return decodeURIComponent(match[1]); } catch { return; }
}

export function normalize(resource: unknown, resourceType: string, scope: Scope, includeSelf = false): Message | null {
  const raw = object(resource);
  const chatId = raw.conversationid ?? raw.conversationId ?? idFromLink(raw.conversationLink ?? raw.resourceLink, 'conversation');
  if (chatId !== scope.chatId) return null;
  // Ephemeral typing controls have no durable chat-message identity.
  if (['Control/Typing', 'Control/ClearTyping'].includes(String(raw.messagetype))) return null;
  const authorId = idFromLink(raw.fromId ?? raw.from, 'contact');
  if (!authorId || (!includeSelf && authorId === scope.expectedAccount)) return null;
  if (typeof raw.id !== 'string' || !/^\d{1,24}$/.test(raw.id)) throw new PocError('Message lacks stable ID');
  const properties = raw.properties ? object(raw.properties) : {};
  const deleted = resourceType === 'MessageRemoved' || Boolean(properties.deletetime);
  if (!deleted && (!['Text', 'RichText/Html', 'RichText'].includes(String(raw.messagetype)) || typeof raw.content !== 'string')) return null;
  let content = typeof raw.content === 'string' ? raw.content : '';
  const reply = /<blockquote\b[^>]*itemtype="http:\/\/schema\.skype\.com\/Reply"[^>]*>([\s\S]*?)<\/blockquote>/i.exec(content);
  let replyTo: Message['replyTo'];
  if (reply) {
    const id = /\bitemid="([^"]+)"/.exec(reply[0])?.[1];
    if (id) replyTo = { id, authorId: /<strong[^>]*itemid="([^"]+)"/.exec(reply[1])?.[1],
      preview: plainText(/<p[^>]*itemprop="preview"[^>]*>([\s\S]*?)<\/p>/i.exec(reply[1])?.[1] ?? '') };
    content = content.replace(reply[0], '');
  }
  const quotes = parseProperty(properties.qtdMsgs);
  if (!replyTo && Array.isArray(quotes) && quotes[0] && typeof quotes[0].messageId === 'string') {
    replyTo = { id: quotes[0].messageId, preview: '' };
  }
  const mentions: Message['mentions'] = [];
  const parsed = parseProperty(properties.mentions);
  if (Array.isArray(parsed)) for (const item of parsed) {
    if (item && typeof item.mri === 'string') mentions.push({ id: item.mri, name: typeof item.displayName === 'string' ? item.displayName : '' });
  }
  const time = String(raw.originalarrivaltime ?? raw.composetime ?? new Date(Number(raw.id)).toISOString());
  if (!Number.isFinite(Date.parse(time))) throw new PocError('Message has invalid time');
  return {
    kind: deleted ? 'delete' : resourceType === 'MessageUpdate' ? 'update' : 'message',
    chatId, id: raw.id, version: String(raw.version ?? properties.edittime ?? raw.id),
    author: { id: authorId, name: typeof raw.imdisplayname === 'string' ? raw.imdisplayname : authorId },
    time, text: deleted ? '' : plainText(content), mentions, ...(replyTo ? { replyTo } : {}),
  };
}

export function eventKey(message: Message): string {
  return createHash('sha256').update(JSON.stringify(message)).digest('hex');
}

export function eventResource(body: Json): { type: string; resource: unknown } | null {
  const type = body.resourceType;
  return typeof type === 'string' && ['NewMessage', 'MessageUpdate', 'MessageRemoved'].includes(type)
    ? { type, resource: body.resource } : null;
}
