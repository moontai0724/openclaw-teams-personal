import { randomInt } from 'node:crypto';
import { checkCredential } from './auth.ts';
import { request, readJson, HttpError } from './http.ts';
import { plainText } from './messages.ts';

export const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function composeText(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 20_000) throw new Error('A nonempty Teams message of at most 20000 characters is required');
  const mentions = [];
  const expression = /@\[([^\]\r\n]{1,100})\]\((8:[^\s()<>"']{1,200})\)/g;
  let html = '', position = 0;
  for (const hit of text.matchAll(expression)) {
    html += escapeHtml(text.slice(position, hit.index));
    const itemid = String(mentions.length);
    mentions.push({ '@type': 'http://schema.skype.com/Mention', itemid, mri: hit[2], mentionType: 'person', displayName: hit[1] });
    html += `<readonly contenteditable="false"><span itemtype="http://schema.skype.com/Mention" itemscope itemid="${itemid}">${escapeHtml(hit[1])}</span></readonly>`;
    position = hit.index + hit[0].length;
  }
  html += escapeHtml(text.slice(position));
  return { content: `<p>${html.replace(/\r?\n/g, '<br>')}</p>`, properties: mentions.length ? { mentions: JSON.stringify(mentions) } : {} };
}
const reactionKeys = { '👍': 'like', '❤': 'heart', '😆': 'laugh', '😮': 'surprised', '😢': 'sad', '😠': 'angry',
  '👎': 'no', '🙌': 'handsinair', '🔥': 'fire', '✋': 'highfive', '👊': 'fistbump', '✔': '2714_heavycheckmark', '👀': '1f440_eyes' };
export const REACTION_EMOJIS = Object.entries(reactionKeys).map(([emoji, key]) => ({ emoji, key }));
export function normalizeReactionKey(input) {
  const value = String(input).trim().replace(/\ufe0f/g, '');
  if (reactionKeys[value]) return reactionKeys[value];
  if ([...Object.values(reactionKeys), 'yes', 'loudlycrying', 'lipssealed'].includes(value.replace(/-tone[1-5]$/, '')) || /^[a-f0-9]{4,5}_[a-z0-9_]+$/.test(value)) return value;
  throw new Error('Unknown Teams emoji; use emoji-list');
}
const parse = value => { if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return undefined; } };
export const messageAuthor = raw => { try { return decodeURIComponent(String(raw.fromId ?? raw.from ?? '').split('/contacts/').at(-1)); } catch { throw new Error('Invalid Teams author identity'); } };
export function messageView(raw, chat, self) {
  return { id: String(raw.id), conversationId: chat, fromId: messageAuthor(raw), from: raw.imdisplayname || messageAuthor(raw),
    isMine: messageAuthor(raw) === self, text: plainText(String(raw.content || '').replace(/<blockquote\b[\s\S]*?<\/blockquote>/gi, '')),
    time: raw.originalarrivaltime || raw.composetime, deleted: Boolean(raw.properties?.deletetime),
    attachments: attachmentList(raw), reactions: (parse(raw.properties?.emotions) || []).map(item => ({ key: item.key,
      mine: item.users?.some(user => user.mri === self) === true, count: item.users?.length || 0 })) };
}
export function attachmentList(raw) {
  const attachments = [];
  const files = parse(raw.properties?.files);
  if (Array.isArray(files)) for (const value of files) attachments.push({ name: value.fileName || value.title || 'attachment', kind: 'file',
    shareUrl: value.fileInfo?.shareUrl, drive: /\/personal\/([^/?#]+)/.exec(value.fileInfo?.siteUrl || '')?.[1], item: value.fileInfo?.itemId });
  for (const image of String(raw.content || '').matchAll(/<img\b[^>]*>/gi)) {
    if (!/itemtype=["']http:\/\/schema\.skype\.com\/AMSImage["']/i.test(image[0])) continue;
    const url = /\bsrc=["']([^"']+)["']/i.exec(image[0])?.[1]?.replace(/&amp;/g, '&');
    if (url) attachments.push({ kind: 'image', name: `image-${attachments.length + 1}`, url });
  }
  for (const file of String(raw.content || '').matchAll(/<URIObject\b([^>]*)>([\s\S]*?)<\/URIObject>/gi)) {
    if (!/\btype=["']File\.1["']/i.test(file[1])) continue;
    const base = /\buri=["']([^"']+)["']/i.exec(file[1])?.[1]?.replace(/&amp;/g, '&');
    const name = /<OriginalName\b[^>]*\bv=["']([^"']+)["']/i.exec(file[2])?.[1];
    if (base) attachments.push({ kind: 'file', name: name ? plainText(name) : 'attachment', url: `${base.replace(/\/$/, '')}/views/original` });
  }
  return attachments.slice(0, 20).map((value, index) => ({ ...value, index }));
}
export function createTeamsClient(getSkypeToken, { expectedAccount, assertChat = () => {}, fetcher = fetch, signal = new AbortController().signal,
  getGraphToken, displayName = '日太' } = {}) {
  let self;
  const guard = chat => { if (typeof chat !== 'string' || !/^(?:19:[\w-]+@thread\.v2|8:[^\s/<>"']+)$/.test(chat)) throw new Error('Invalid Teams conversation'); assertChat(chat); signal.throwIfAborted(); };
  const credential = async () => { const value = await getSkypeToken(); if (expectedAccount) checkCredential(value, expectedAccount);
    const claims = JSON.parse(Buffer.from(value.token.split('.')[1], 'base64url').toString()); self = `8:${claims.skypeid}`; return value; };
  async function call(chat, suffix = '', method = 'GET', body, absolute) {
    guard(chat);
    const url = new URL(absolute || `https://teams.live.com/api/chatsvc/consumer/v1/users/ME/conversations/${encodeURIComponent(chat)}/messages${suffix}`);
    if (!['teams.live.com', 'msgapi.teams.live.com'].includes(url.hostname) || url.protocol !== 'https:' || url.port || url.username || url.password) throw new Error('Untrusted Teams endpoint');
    const route = /\/conversations\/([^/]+)\/(?:messages|properties)(?:\/|$)/.exec(url.pathname);
    if (!route || decodeURIComponent(route[1]) !== chat) throw new Error('Teams response crossed conversation scope');
    const auth = await credential(); guard(chat);
    const response = await request(fetcher, url, { method, headers: { Authentication: `skypetoken=${auth.token}`, 'Content-Type': 'application/json',
      'ms-ic3-product': 'tfl', 'ms-ic3-additional-product': 'Sfl', 'X-MS-Client-Consumer-Type': 'teams4life', BehaviorOverride: 'redirectAs404' },
      ...(body ? { body: JSON.stringify(body) } : {}) }, signal);
    const text = response.body ? (await boundedBytes(response, 2_000_000)).toString('utf8') : ''; guard(chat);
    if (!text) return {};
    try { return JSON.parse(text); } catch { throw new Error('Teams returned invalid JSON'); }
  }
  const validId = id => { if (!/^[1-9]\d{0,23}$/.test(String(id))) throw new Error('Invalid Teams message ID'); return String(id); };
  async function rawMessage(chat, id) {
    id = validId(id);
    const data = await call(chat, `/${id}`);
    if (String(data.id) !== id || data.conversationid && data.conversationid !== chat) throw new Error('Teams message target mismatch');
    return data;
  }
  async function rawHistory(chat, { limit = 50, before, after } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Teams history limit must be 1–500');
    const result = []; let next;
    for (let page = 0; page < 5; page++) {
      const data = await call(chat, '?startTime=0&pageSize=100&view=msnp24Equivalent', 'GET', undefined, next);
      if (!Array.isArray(data.messages)) throw new Error('Teams history returned no message list');
      for (const raw of data.messages) {
        if (raw.conversationid && raw.conversationid !== chat) throw new Error('Teams history crossed scope');
        if (!/^\d{1,24}$/.test(String(raw.id))) continue;
        if ((!before || BigInt(raw.id) < BigInt(validId(before))) && (!after || BigInt(raw.id) > BigInt(validId(after)))) result.push(raw);
        if (result.length >= limit) return result;
      }
      next = data._metadata?.backwardLink;
      if (!next) break;
    }
    return result;
  }
  async function publish(chat, body) {
    body.clientmessageid = String(BigInt(Date.now()) * 1_000_000n + BigInt(randomInt(1_000_000)));
    let value;
    try { value = await call(chat, '', 'POST', body); } catch { /* Reconcile exactly once; never resend a possibly committed write. */ }
    let id = value?.OriginalArrivalTime;
    if (!id) {
      const recent = await rawHistory(chat, { limit: 100 });
      id = recent.find(item => item.clientmessageid === body.clientmessageid && messageAuthor(item) === self)?.id;
    }
    if (!id) throw new Error('Teams send outcome unknown; do not resend automatically');
    return { arrivalTime: String(id), clientmessageid: body.clientmessageid, sent: true };
  }
  async function sendMessage(chat, text, { replyTo } = {}) {
    guard(chat); const body = { ...composeText(text), messagetype: 'RichText/Html', contenttype: 'text', imdisplayname: displayName };
    if (replyTo) {
      const raw = await rawMessage(chat, replyTo);
      const author = messageAuthor(raw);
      body.content = `<blockquote itemscope="" itemtype="http://schema.skype.com/Reply" itemid="${validId(replyTo)}"><strong itemprop="mri" itemid="${escapeHtml(author)}">${escapeHtml(raw.imdisplayname || author)}</strong><span itemprop="time" itemid="${validId(replyTo)}"></span><p itemprop="preview">${escapeHtml(plainText(raw.content || '').slice(0, 150))}</p></blockquote>` + body.content;
      body.properties.qtdMsgs = JSON.stringify([{ messageId: String(replyTo), sender: author, time: Number(replyTo) }]);
    }
    return publish(chat, body);
  }
  async function ownMessage(chat, id) { const raw = await rawMessage(chat, id); if (messageAuthor(raw) !== self) throw new Error('Only the bot’s own message may be modified'); return raw; }
  async function uploadAttachment(chat, bytes, name, image = false) {
    guard(chat);
    const maxBytes = (image ? 5 : 15) * 1024 * 1024;
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > maxBytes) throw new Error(`Attachment must contain 1 byte–${image ? 5 : 15} MiB`);
    if (typeof name !== 'string' || !name.trim() || name.length > 200 || /[\x00-\x1f/\\]/.test(name)) throw new Error('Invalid attachment filename');
    const upload = async (route, method, body, contentType) => {
      const auth = await credential(); guard(chat);
      return request(fetcher, new URL(`https://api.asm.skype.com/v1/objects/${route}`), {
        method, headers: { Authorization: `skype_token ${auth.token}`, 'Content-Type': contentType,
          'x-ms-client-version': '1415/1.0.0.2018090100' }, body,
      }, signal);
    };
    const created = await readJson(await upload('', 'POST', JSON.stringify({ type: image ? 'pish/image' : 'sharing/file', filename: name,
      ...(image ? { sharingMode: 'Inline' } : {}), permissions: { [chat]: ['read'] } }), 'application/json'));
    guard(chat);
    if (typeof created.id !== 'string' || !/^[a-zA-Z0-9._-]{1,200}$/.test(created.id)) throw new Error('Invalid Teams attachment object ID');
    const uploaded = await upload(`${created.id}/content/${image ? 'imgpsh' : 'original'}`, 'PUT', bytes, 'application/octet-stream');
    await uploaded.body?.cancel(); guard(chat);
    return { id: created.id, base: `https://api.asm.skype.com/v1/objects/${created.id}` };
  }
  return {
    async whoAmI() { const auth = await credential(); return { mri: self, region: auth.region }; },
    getRawMessage: rawMessage,
    async getMessage(chat, id) { return messageView(await rawMessage(chat, id), chat, self); },
    async getMessages(chat, options) { const values = await rawHistory(chat, options); return values.map(value => messageView(value, chat, self)); },
    async searchMessages(chat, query, options) {
      if (typeof query !== 'string' || !query.trim()) throw new Error('A search query is required');
      const messages = await rawHistory(chat, { ...options, limit: options?.limit || 100 });
      const words = query.toLocaleLowerCase().trim().split(/\s+/);
      return { scannedMessages: messages.length, coverage: 'bounded recent chat history, not account-wide search',
        messages: messages.map(value => messageView(value, chat, self)).filter(value => words.every(word => value.text.toLocaleLowerCase().includes(word))) };
    },
    sendMessage,
    async sendFile(chat, bytes, name, caption = '') {
      const text = caption ? composeText(caption) : { content: '', properties: {} };
      const { id, base } = await uploadAttachment(chat, bytes, name);
      // Explicit file mode preserves originals, including pictures.
      const content = `<URIObject type="File.1" uri="${base}"><Title>${escapeHtml(name)}</Title><Description></Description><OriginalName v="${escapeHtml(name)}"/><FileSize v="${bytes.length}"/></URIObject>`;
      const body = { ...text, content: text.content + content, contenttype: 'text',
        messagetype: 'RichText/Media_GenericFile', imdisplayname: displayName, amsreferences: [id] };
      return publish(chat, body);
    },
    async sendImage(chat, bytes, name, caption = '', { contentType, width, height } = {}) {
      guard(chat);
      if (!/^image\/(jpeg|png|gif|webp)$/.test(contentType) || !Number.isInteger(width) || !Number.isInteger(height)
        || width < 1 || height < 1 || width * height > 25_000_000) throw new Error('Unsupported image type or dimensions');
      const text = caption ? composeText(caption) : { content: '', properties: {} };
      const { id, base } = await uploadAttachment(chat, bytes, name, true);
      const scale = Math.min(1, 400 / width, 250 / height);
      const image = `<p><img src="${base}/views/imgo" itemtype="http://schema.skype.com/AMSImage" itemscope="${contentType.slice(6)}" width="${width * scale}" height="${height * scale}" alt="${escapeHtml(name)}" id="x_${id}" itemid="${id}"></p>`;
      const body = { ...text, content: text.content + image, contenttype: 'Text',
        messagetype: 'RichText/Html', imdisplayname: displayName, amsreferences: [id] };
      return publish(chat, body);
    },
    replyToMessage: (chat, id, text) => sendMessage(chat, text, { replyTo: validId(id) }),
    async editMessage(chat, id, text) {
      const original = await ownMessage(chat, id);
      if (original.properties?.deletetime) throw new Error('Cannot edit a deleted message');
      const body = composeText(text);
      body.content = (/<blockquote\b[\s\S]*?<\/blockquote>/i.exec(original.content || '')?.[0] || '') + body.content;
      if (original.properties?.qtdMsgs) body.properties.qtdMsgs = original.properties.qtdMsgs;
      try { await call(chat, `/${validId(id)}`, 'PUT', { ...body, id: String(id), type: 'Message', conversationid: chat,
        messagetype: 'RichText/Html', contenttype: 'text', imdisplayname: original.imdisplayname || displayName }); } catch { /* Read back before reporting an ambiguous mutation. */ }
      const observed = await rawMessage(chat, id);
      if (observed.content !== body.content) throw new Error('Teams edit not verified; do not resend automatically');
      return { edited: true, verified: true, messageId: String(id), conversationId: chat };
    },
    async deleteMessage(chat, id) {
      const original = await ownMessage(chat, id);
      if (!original.properties?.deletetime) {
        try { await call(chat, `/${validId(id)}?behavior=softDelete`, 'DELETE'); } catch { /* Read back below. */ }
      }
      try { if (!(await rawMessage(chat, id)).properties?.deletetime) throw new Error('Teams deletion not verified'); }
      catch (error) { if (!(error instanceof HttpError && error.status === 404)) throw error; }
      return { deleted: true, verified: true, messageId: String(id), conversationId: chat };
    },
    async react(chat, id, emoji, { remove = false } = {}) {
      const key = normalizeReactionKey(emoji);
      await call(chat, `/${validId(id)}/properties?name=emotions`, remove ? 'DELETE' : 'PUT', { emotions: remove ? { key } : { key, value: Date.now() } });
    },
    async markRead(chat, id) {
      const original = await rawMessage(chat, id);
      const url = `https://teams.live.com/api/chatsvc/consumer/v1/users/ME/conversations/${encodeURIComponent(chat)}/properties?name=consumptionhorizon`;
      await call(chat, '', 'PUT', { consumptionhorizon: `${original.id};${Date.parse(original.originalarrivaltime || original.composetime) || Number(original.id)};${original.clientmessageid || original.id}` }, url);
      return { markedRead: true, messageId: String(id) };
    },
    async readAttachment(chat, id, index = 0) {
      const raw = await rawMessage(chat, id);
      const attachments = attachmentList(raw);
      if (!Number.isInteger(index) || index < 0 || !attachments[index]) throw new Error('Invalid Teams attachment index');
      const item = attachments[index];
      let url, headers = {};
      if (item.kind === 'image' || item.url) {
        url = trustedDownload(item.url, true);
        const auth = await credential(); guard(chat);
        headers.Authorization = `skype_token ${auth.token}`;
      } else {
        if (!getGraphToken) throw new Error('Graph file authentication is unavailable');
        if (!item.shareUrl && !(item.drive && item.item)) throw new Error('Attachment has no usable OneDrive reference');
        if (item.shareUrl) trustedShare(item.shareUrl);
        const route = item.shareUrl ? `shares/u!${Buffer.from(item.shareUrl).toString('base64url')}/driveItem`
          : `drives/${encodeURIComponent(item.drive)}/items/${encodeURIComponent(item.item)}`;
        const token = await getGraphToken(); guard(chat);
        const metadata = await request(fetcher, new URL(`https://graph.microsoft.com/v1.0/${route}`), {
          headers: { Authorization: `Bearer ${token}`, Prefer: 'redeemSharingLinkIfNecessary' } }, signal);
        const value = await readJson(metadata); guard(chat);
        if (Number(value.size) > 15 * 1024 * 1024) throw new Error('Attachment exceeds 15 MiB');
        url = trustedDownload(value['@microsoft.graph.downloadUrl'], false);
        item.name = value.name || item.name;
      }
      guard(chat);
      const response = await request(fetcher, url, { headers }, signal);
      const contentType = response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
      if (item.kind === 'image' && !/^image\/(png|jpeg|gif|webp)$/.test(contentType)) throw new Error('Unsupported image response');
      const bytes = await boundedBytes(response, item.kind === 'image' ? 5 * 1024 * 1024 : 15 * 1024 * 1024); guard(chat);
      return { bytes, contentType, name: item.name, kind: item.kind, size: bytes.length };
    },
  };
}
export function trustedShare(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !/(^|\.)(1drv\.ms|onedrive\.live\.com|sharepoint\.com|microsoftpersonalcontent\.com)$/.test(url.hostname)) throw new Error('Untrusted OneDrive reference');
  return url;
}
export function trustedDownload(value, image) {
  const url = new URL(value);
  const allowed = image ? /(^|\.)asm\.skype\.com$/ : /(^|\.)(microsoftpersonalcontent\.com|1drv\.com|livefilestore\.com|onedrive\.com|sharepoint\.com)$/;
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !allowed.test(url.hostname)) throw new Error('Untrusted attachment download');
  return url;
}
export async function boundedBytes(response, maximum) {
  if (Number(response.headers.get('content-length')) > maximum) { await response.body?.cancel(); throw new Error('Attachment exceeds size limit'); }
  const chunks = []; let total = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Attachment response is empty');
  try { for (;;) { const part = await reader.read(); if (part.done) break; total += part.value.length;
    if (total > maximum) throw new Error('Attachment exceeds size limit'); chunks.push(part.value); } }
  finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}
