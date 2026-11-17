import { checkCredential } from '../src/auth.ts';
import { HttpError, request } from '../src/http.ts';

// The shipped Teams Free worker posts this ephemeral control, not a chat message.
export function createTypingSender({ policy, currentConfig, getSkypeToken, to,
  assertAuthority, signal, fetcher = fetch }) {
  const chat = policy.normalizedTarget(to);
  const assertDestination = () => {
    signal.throwIfAborted();
    assertAuthority();
    if (!policy.validConfig({ accountId: 'default', ...currentConfig().channels?.[policy.CHANNEL] }) || !policy.targetAllowed(chat)) {
      throw new Error('Teams typing destination no longer approved');
    }
  };
  return async () => {
    assertDestination();
    const credential = await getSkypeToken();
    assertDestination();
    checkCredential(credential, policy.BOT);
    const url = new URL(`https://teams.live.com/api/chatsvc/consumer/v1/users/ME/conversations/${encodeURIComponent(chat)}/messages`);
    const response = await request(fetcher, url, { method: 'POST', headers: {
      Authentication: `skypetoken=${credential.token}`, 'Content-Type': 'application/json',
      'ms-ic3-product': 'tfl', 'ms-ic3-additional-product': 'Sfl',
      'X-MS-Client-Consumer-Type': 'teams4life', BehaviorOverride: 'redirectAs404',
    }, body: JSON.stringify({ content: '', contenttype: 'Application/Message', messagetype: 'Control/Typing' }) }, signal);
    await response.body?.cancel();
  };
}

export function createTeamsTyping({ createTypingCallbacks, log, ...options }) {
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  const send = createTypingSender({ ...options, signal });
  let observed = false;
  const callbacks = createTypingCallbacks({
    start: async () => {
      await send();
      if (!observed) { observed = true; log?.info('Teams typing started'); }
    },
    // Native controls expire. Stop refreshing instead of inventing a clear write.
    stop: async () => {
      controller.abort();
      options.signal.removeEventListener('abort', cleanup);
      if (observed) log?.info('Teams typing stopped');
    },
    keepaliveIntervalMs: 4000, maxDurationMs: 10 * 60_000,
    onStartError: error => {
      if (!signal.aborted) log?.warn(`Teams typing failed (${error instanceof HttpError ? `HTTP ${error.status}` : 'Error'})`);
    },
  });
  const cleanup = () => {
    controller.abort(); // Also cancel an in-flight request before it can refresh again.
    options.signal.removeEventListener('abort', cleanup);
    callbacks.onCleanup();
  };
  options.signal.addEventListener('abort', cleanup, { once: true });
  if (options.signal.aborted) cleanup();
  return { callbacks: { ...callbacks, onIdle: cleanup, onCleanup: cleanup }, cleanup };
}
