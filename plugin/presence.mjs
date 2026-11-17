import { randomUUID } from 'node:crypto';
import timers from 'node:timers/promises';
import { checkCredential, IdentityError } from '../src/auth.ts';
import { HttpError, request } from '../src/http.ts';

// Publish this connector's endpoint, never an account-wide forced availability.
export function createPresenceApi({ policy, currentConfig, getSkypeToken, assertAuthority,
  endpointId = randomUUID(), fetcher = fetch }) {
  if (!/^[\da-f-]{36}$/.test(endpointId)) throw new Error('Invalid presence endpoint');
  const authority = () => {
    assertAuthority();
    if (!policy.validConfig({ accountId: 'default', ...currentConfig().channels?.[policy.CHANNEL] })) {
      throw new Error('Teams presence account no longer approved');
    }
  };
  const call = async (method, route, body, signal, cleanup = false) => {
    signal.throwIfAborted();
    if (!cleanup) authority();
    const credential = await getSkypeToken();
    signal.throwIfAborted();
    if (!cleanup) authority();
    checkCredential(credential, policy.BOT);
    const response = await request(fetcher, new URL(`https://teams.live.com/ups/global/v1/me/${route}`), {
      method, headers: { 'X-Skypetoken': credential.token, 'Content-Type': 'application/json',
        'X-MS-Client-Consumer-Type': 'teams4life', 'x-ms-client-user-agent': 'Teams-V2-Web',
        'x-ms-endpoint-id': endpointId },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }, signal);
    await response.body?.cancel();
  };
  return {
    publish: signal => call('PUT', 'endpoints/', { id: endpointId, availability: 'Available',
      activity: 'Available', deviceType: 'Web', activityReporting: 'Direct' }, signal),
    active: signal => call('POST', 'reportmyactivity/', { endpointId, isActive: true }, signal),
    // Disabled/stopped config must not prevent removal of our own endpoint.
    // The credential identity is still verified, and no other endpoint is touched.
    remove: signal => call('DELETE', `endpoints/${endpointId}`, undefined, signal, true),
  };
}

export function createTeamsPresence({ api, signal, log, intervalMs = 60_000,
  sleep = (ms, local) => timers.setTimeout(ms, undefined, { signal: local }) }) {
  let connected = false;
  let stopped = signal.aborted;
  let controller;
  let pending;
  const warn = (operation, error) => log?.warn?.(`Teams presence ${operation} failed (${error instanceof HttpError ? `HTTP ${error.status}` : 'Error'})`);
  const run = async (local) => {
    let dirty = false;
    let published = false;
    let refreshed = false;
    let failures = 0;
    try {
      while (!local.aborted) {
        let wait = intervalMs;
        try {
          // Mark before sending: a lost response may still have created it.
          if (!published) { dirty = true; await api.publish(local); }
          else await api.active(local);
          local.throwIfAborted();
          if (!published) log?.info?.('Teams presence available');
          else if (!refreshed) { log?.info?.('Teams presence refreshed'); refreshed = true; }
          published = true;
          failures = 0;
        } catch (error) {
          if (local.aborted) break;
          warn('refresh', error);
          if (error instanceof IdentityError || error instanceof HttpError && [401, 403].includes(error.status)) break;
          if (error instanceof HttpError && error.status === 404) published = false;
          wait = Math.max(Math.min(intervalMs * 2 ** Math.min(failures++, 3), 300_000),
            error instanceof HttpError ? error.retryAfterMs : 0);
        }
        try { await sleep(wait, local); }
        catch (error) { if (!local.aborted) throw error; }
      }
    } finally {
      if (dirty) {
        try {
          await api.remove(AbortSignal.timeout(15_000));
          log?.info?.('Teams presence endpoint removed');
        } catch (error) { if (!(error instanceof HttpError && error.status === 404)) warn('cleanup', error); }
      }
    }
  };
  const start = () => {
    if (pending || stopped || !connected) return;
    controller = new AbortController();
    const local = controller;
    pending = run(local.signal).catch(error => warn('loop', error)).finally(() => {
      pending = undefined;
      // Only a disconnect/reconnect during cleanup starts another run. A fatal
      // auth failure while still connected does not create a retry spin.
      if (local.signal.aborted && !stopped && connected) start();
    });
  };
  const setConnected = value => {
    if (stopped || connected === value) return;
    connected = value;
    if (value) start();
    else controller?.abort();
  };
  const onAbort = () => { stopped = true; connected = false; controller?.abort(); };
  signal.addEventListener('abort', onAbort, { once: true });
  return {
    setConnected,
    stop: async () => {
      onAbort();
      signal.removeEventListener('abort', onAbort);
      await pending;
    },
  };
}
