import { PocError, failureReason } from "./errors.ts";
import { setTimeout as delay } from 'node:timers/promises';
import { IdentityError, type AuthProvider } from './auth.ts';
import { HttpError, request, type Fetch } from './http.ts';
import { connectedRoute, decodeBody, eventFrame, json, object, parseFrame, registration, requestAck, socketUrl, trustedUrl, type Json } from './protocol.ts';

export type Log = (event: string, data?: Record<string, string | number | boolean>) => void;
export type Socket = Pick<WebSocket, 'readyState' | 'send' | 'close' | 'addEventListener' | 'removeEventListener'>;
type Deps = {
  auth: AuthProvider; fetch: Fetch; socket: (url: URL) => Socket;
  onBody: (body: Json) => Promise<void>;
  onReady: () => Promise<void>; onLoss: () => Promise<void>; log: Log;
  onDisconnected?: () => void;
};
export type Options = { endpointId: string; registrar: string; dropAfterMs?: number; reconnectDelayMs?: number };

// No raw error/URL/body is logged: remote exceptions may contain credentials or other chats.
export async function listen(deps: Deps, options: Options, signal: AbortSignal): Promise<void> {
  trustedUrl(options.registrar, 'registrar');
  let host = 'go.trouter.teams.microsoft.com';
  let failures = 0;
  let forcedDropUsed = false;
  let attempts = 0;
  while (!signal.aborted) {
    attempts++;
    deps.log('connecting', { attempt: attempts });
    try {
      const credential = await deps.auth();
      if (signal.aborted) break;
      await session(deps, options, credential, host, signal, (newHost) => { host = newHost; }, () => {
        failures = 0;
        if (forcedDropUsed || !options.dropAfterMs) return undefined;
        forcedDropUsed = true;
        return options.dropAfterMs;
      });
    } catch (error) {
      if (signal.aborted) break;
      if (error instanceof IdentityError) throw error;
      failures++;
      deps.log('session_failed', { reason: failureReason(error), consecutiveFailures: failures, ...(error instanceof HttpError ? { status: error.status } : {}) });
      if (failures >= 8) throw new PocError('Eight consecutive transport failures; inspect protocol/account before retrying');
      const backoff = Math.min(1000 * 2 ** (failures - 1), 30_000);
      const wait = Math.max(backoff, options.reconnectDelayMs ?? 0, error instanceof HttpError ? error.retryAfterMs : 0);
      deps.log('reconnect_wait', { milliseconds: wait });
      await delay(wait, undefined, { signal }).catch((failure) => { if (!signal.aborted) throw failure; });
    }
  }
}

async function session(deps: Deps, options: Options, credential: Awaited<ReturnType<AuthProvider>>, host: string,
  parentSignal: AbortSignal, redirect: (host: string) => void, registered: () => number | undefined): Promise<void> {
  const socket = deps.socket(socketUrl(options.endpointId, host));
  const controller = new AbortController();
  const signal = AbortSignal.any([parentSignal, controller.signal]);
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let lastReceived = Date.now();
  let authenticated = false;
  let ready = false;
  let pending = 0;
  let sequence = 0;
  let lane: Promise<unknown> = Promise.resolve();
  let failure: unknown;
  let done!: () => void;
  const closed = new Promise<void>((resolve) => { done = resolve; });
  let finished = false;
  const finish = (error?: unknown) => {
    if (finished) return;
    finished = true; failure = error;
    controller.abort();
    for (const timer of timers) clearTimeout(timer);
    socket.close(); done();
    // Notify before draining pending history/ingress work, so presence can stop
    // as soon as the transport is lost rather than after that work completes.
    deps.onDisconnected?.();
  };
  const later = (work: () => void, ms: number) => {
    if (signal.aborted) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!finished) { try { work(); } catch (error) { finish(error); } }
    }, ms);
    timers.add(timer); return timer;
  };
  const send = (value: string) => { if (socket.readyState !== 1) throw new PocError('Socket not open'); socket.send(value); };
  const watchdog = () => {
    if (Date.now() - lastReceived > 90_000) return finish(new PocError('Heartbeat silence'));
    if (ready) send(`5:${++sequence}+::{"name":"ping","args":[]}`);
    later(watchdog, 30_000);
  };
  const renew = async (route: { path: string; ttl: number }) => {
    const fresh = await deps.auth();
    if (signal.aborted) return;
    const response = await request(deps.fetch, trustedUrl(options.registrar, 'registrar'), {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Skypetoken': fresh.token, 'X-MS-Migration': 'True' },
      body: JSON.stringify(registration(options.endpointId, route)),
    }, signal);
    await response.body?.cancel();
    // An abort may occur while the successful response is being released.
    // Never resurrect connected status or schedule renewal for a closed session.
    if (signal.aborted) return;
    deps.log(ready ? 'registration_renewed' : 'registered');
    later(() => { void renew(route).catch(finish); }, Math.max(30_000, (Math.min(route.ttl, 3600) - 30) * 1000));
  };
  const processFrame = async (value: string) => {
    const frame = parseFrame(value);
    if (frame.type === '1') {
      if (authenticated) throw new PocError('Unexpected repeated authentication handshake');
      authenticated = true;
      send(eventFrame('user.authenticate', [{ headers: { 'X-Skypetoken': credential.token, 'X-MS-Migration': 'True' } }]));
      deps.log('authentication_sent');
    } else if (frame.type === '5') {
      if (frame.wantsAck && frame.id) send(`6:${frame.id}::`);
      const event = json(frame.data);
      const args = Array.isArray(event.args) ? event.args : [];
      if (event.name === 'trouter.connected') {
        if (!authenticated || ready) throw new PocError('Unexpected connected event');
        const route = connectedRoute(args[0]);
        later(() => finish(new PocError('Refresh connection before route expiry')), (route.ttl - 10) * 1000);
        deps.log('authenticated');
        await renew(route);
        if (signal.aborted) return;
        ready = true;
        // Repair once on each authenticated connection, never on a periodic history loop.
        await deps.onReady();
        const dropAfter = registered();
        if (dropAfter) later(() => { deps.log('forced_disconnect'); finish(new PocError('Controlled reconnect test')); }, dropAfter);
      } else if (event.name === 'trouter.reconnect') {
        const details = args[0] ? object(args[0]) : {};
        if (typeof details.url === 'string' && details.target === 'host') {
          const supplied = new URL(details.url.includes('://') ? details.url : `https://${details.url}`);
          const candidate = trustedUrl(`wss://${supplied.host}/v4/c`, 'socket');
          redirect(candidate.hostname);
        }
        finish(new PocError('Server requested reconnect'));
      } else if (event.name === 'trouter.message_loss') {
        const details = object(args[0]);
        deps.log('message_loss');
        await deps.onLoss();
        send(eventFrame('trouter.processed_message_loss', [{ droppedIndicators: details.droppedIndicators ?? [] }]));
      }
    } else if (frame.type === '3') {
      if (!ready) throw new PocError('Message arrived before successful registration');
      const envelope = json(frame.data);
      if (typeof envelope.id !== 'number' || !Number.isSafeInteger(envelope.id)) throw new PocError('Request lacks acknowledgement ID');
      if (typeof envelope.url === 'string' && /\/messaging\/?$/.test(envelope.url) && typeof envelope.body === 'string') {
        await deps.onBody(decodeBody(envelope.headers ? object(envelope.headers) : {}, envelope.body));
      }
      if (!signal.aborted) send(requestAck(envelope.id));
    } else if (frame.type === '0' || frame.type === '7') finish(new PocError('Server disconnected or rejected connection'));
  };
  const onMessage = (event: Event) => {
    lastReceived = Date.now();
    const value = (event as MessageEvent).data;
    if (typeof value !== 'string') return finish(new PocError('Unexpected binary frame'));
    // Heartbeat replies must not wait for history/file I/O in the processing lane.
    if (value === '2::') { try { send('2::'); } catch (error) { finish(error); } return; }
    if (++pending > 100) return finish(new PocError('Pending frame limit exceeded'));
    lane = lane.then(async () => { if (!finished) await processFrame(value); }).catch(finish).finally(() => { pending--; });
  };
  const onClose = () => finish(new PocError('Socket closed'));
  const onError = () => finish(new PocError('WebSocket transport error'));
  const onAbort = () => finish();
  socket.addEventListener('message', onMessage);
  socket.addEventListener('close', onClose);
  socket.addEventListener('error', onError);
  parentSignal.addEventListener('abort', onAbort, { once: true });
  later(() => { if (!ready) finish(new PocError('Authentication or registration timed out')); }, 30_000);
  later(() => finish(new PocError('Refresh credentials before token expiry')), Math.max(1000, credential.expiresAt - Date.now() - 45_000));
  later(watchdog, 30_000);
  if (parentSignal.aborted) finish();
  await closed;
  socket.removeEventListener('message', onMessage);
  socket.removeEventListener('close', onClose);
  socket.removeEventListener('error', onError);
  parentSignal.removeEventListener('abort', onAbort);
  await lane;
  if (failure) throw failure;
}
