import { PocError } from "./errors.ts";
import { normalize } from './messages.ts';
import { Journal } from './journal.ts';
import { object, trustedUrl } from './protocol.ts';
import { readJson, request, type Fetch } from './http.ts';
import type { AuthProvider } from './auth.ts';

export async function repairHistory(deps: { fetch: Fetch; auth: AuthProvider; journal: Journal }, signal: AbortSignal, now = Date.now()): Promise<{ pages: number; recovered: number }> {
  const { journal } = deps;
  const { chatId } = journal.meta.scope;
  const since = Math.max(journal.meta.since, journal.cursor - 120_000);
  const initial = `https://teams.live.com/api/chatsvc/consumer/v1/users/ME/conversations/${encodeURIComponent(chatId)}/messages?startTime=0&pageSize=100&view=msnp24Equivalent`;
  let next: string | undefined = initial;
  let recovered = 0;
  for (let page = 1; page <= 5; page++) {
    const url = trustedUrl(next!, 'history');
    const pathChat = /\/conversations\/([^/]+)\/messages$/.exec(url.pathname)?.[1];
    if (!pathChat || decodeURIComponent(pathChat) !== chatId) throw new PocError('History pagination crossed conversation boundary');
    const { token } = await deps.auth();
    const response = await request(deps.fetch, url, { headers: {
      Authentication: `skypetoken=${token}`, 'ms-ic3-product': 'tfl', 'ms-ic3-additional-product': 'Sfl',
      'X-MS-Client-Consumer-Type': 'teams4life', BehaviorOverride: 'redirectAs404', Accept: 'application/json',
    } }, signal);
    const body = await readJson(response);
    if (!Array.isArray(body.messages)) throw new PocError('History response lacks messages');
    let reachedFence = false;
    const messages = [];
    for (const item of body.messages) {
      const raw = object(item);
      const time = Date.parse(String(raw.originalarrivaltime ?? raw.composetime ?? ''));
      if (!Number.isFinite(time)) throw new PocError('History response contains invalid time');
      if (time < since) reachedFence = true;
      // Do not assume sorted pagination or break on the first older result.
      if (time < since || time > now) continue;
      const conversationid = raw.conversationid ?? raw.conversationId ?? (!raw.conversationLink && !raw.resourceLink ? chatId : undefined);
      const message = normalize({ ...raw, conversationid }, raw.properties && object(raw.properties).edittime ? 'MessageUpdate' : 'NewMessage', journal.meta.scope);
      if (message) messages.push(message);
    }
    for (const message of messages.sort((a, b) => Date.parse(a.time) - Date.parse(b.time))) {
      if (await journal.record(message, 'repair')) recovered++;
    }
    const metadata = body._metadata ? object(body._metadata) : {};
    next = typeof metadata.backwardLink === 'string' ? metadata.backwardLink : undefined;
    if (reachedFence || !next) {
      await journal.checkpoint(now);
      return { pages: page, recovered };
    }
  }
  throw new PocError('History gap exceeds five pages; checkpoint was not advanced');
}
