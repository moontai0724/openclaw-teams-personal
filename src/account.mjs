import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { hostname, userInfo, homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { checkCredential } from './auth.ts';

// Keep the existing encrypted credential format/location. This is a data-format
// compatibility boundary, not an import of the former MCP implementation.
export function createCredentialStore({ directory = process.platform === 'win32'
  ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'teams-personal-mcp')
  : join(homedir(), '.teams-personal-mcp'), seed = `${hostname()}::${userInfo().username}::teams-personal-mcp` } = {}) {
  const file = join(directory, 'tokens.enc');
  const key = createHash('sha256').update(seed).digest();
  return {
    read() {
      let data;
      try { data = readFileSync(file); }
      catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('Cannot read Teams credential store'); }
      try {
        const decrypt = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
        decrypt.setAuthTag(data.subarray(12, 28));
        return JSON.parse(Buffer.concat([decrypt.update(data.subarray(28)), decrypt.final()]).toString());
      } catch { throw new Error('Teams credential store cannot be decrypted'); }
    },
    write(value) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const nonce = randomBytes(12);
      const encrypt = createCipheriv('aes-256-gcm', key, nonce);
      const ciphertext = Buffer.concat([encrypt.update(JSON.stringify(value)), encrypt.final()]);
      const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
      writeFileSync(temporary, Buffer.concat([nonce, encrypt.getAuthTag(), ciphertext]), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, file);
    },
  };
}

const application = '8ec6bc83-69c8-4392-8f08-b3c986009232';
const authority = 'https://login.microsoftonline.com';
export function createMicrosoftAuth({ fetcher = fetch, now = Date.now } = {}) {
  async function exchange(url, values, token = false) {
    const call = origin => fetcher(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(origin ? { Origin: 'https://teams.live.com' } : {}) },
      body: new URLSearchParams({ client_id: application, ...values }).toString() });
    let response = await call(false);
    let body = await response.json();
    if (token && !response.ok && String(body.error_description).includes('AADSTS9002327')) {
      response = await call(true); body = await response.json();
    }
    if (!response.ok && !['authorization_pending', 'slow_down'].includes(body.error)) {
      throw new Error(`Microsoft authentication rejected (HTTP ${response.status})`);
    }
    return body;
  }
  async function refresh(refreshToken, graph) {
    const grant = await exchange(`${authority}/consumers/oauth2/v2.0/token`, {
      grant_type: 'refresh_token', refresh_token: refreshToken,
      scope: graph ? 'https://graph.microsoft.com/Files.ReadWrite' : 'service::api.fl.spaces.skype.com::MBI_SSL openid profile offline_access',
    }, true);
    if (!grant.access_token) throw new Error('Microsoft authentication returned no access token');
    if (graph) return { token: grant.access_token, expiresAt: now() + Number(grant.expires_in || 3600) * 1000,
      refreshToken: grant.refresh_token || refreshToken };
    const response = await fetcher('https://teams.live.com/api/auth/v1.0/authz/consumer', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${grant.access_token}`, Origin: 'https://teams.live.com', Accept: 'application/json; ver=1.0' },
    });
    if (!response.ok) throw new Error(`Teams authentication rejected (HTTP ${response.status})`);
    const body = await response.json();
    const data = body.tokens?.skypeToken ?? body.skypeToken;
    const token = typeof data === 'string' ? data : data?.skypetoken;
    if (!token) throw new Error('Teams authentication returned no chat token');
    return { token, expiresAt: now() + Number(body.tokens?.expiresIn ?? data?.expiresIn ?? body.expiresIn ?? 3600) * 1000,
      region: body.region ?? null, refreshToken: grant.refresh_token || refreshToken };
  }
  return {
    refresh,
    async deviceCode() {
      const value = await exchange(`${authority}/common/oauth2/devicecode`, { resource: 'https://api.spaces.skype.com' });
      if (!value.device_code || !value.user_code) throw new Error('Microsoft returned no device code');
      return { secret: value.device_code, code: value.user_code, url: value.verification_uri || value.verification_url,
        interval: Math.max(5, Number(value.interval) || 5) * 1000, expiresAt: now() + Number(value.expires_in || 900) * 1000 };
    },
    async poll(secret) {
      return exchange(`${authority}/common/oauth2/token`, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', code: secret }, true);
    },
  };
}

export function createAccount({ store = createCredentialStore(), microsoft = createMicrosoftAuth(), now = Date.now, expectedAccount } = {}) {
  const cache = new Map();
  let serial = Promise.resolve();
  let login;
  function obtain(kind) {
    const job = serial.then(async () => {
      const saved = cache.get(kind);
      if (saved && saved.expiresAt - now() > 120_000) return saved;
      const state = store.read();
      if (!state.refreshToken) throw new Error('Teams is not signed in; use the account CLI privately');
      const result = await microsoft.refresh(state.refreshToken, kind === 'graph');
      if (!result.token || !Number.isFinite(result.expiresAt)) throw new Error('Invalid Microsoft credential response');
      if (kind === 'chat' && expectedAccount) checkCredential(result, expectedAccount);
      if (result.refreshToken && result.refreshToken !== state.refreshToken) store.write({ ...state, refreshToken: result.refreshToken });
      const credential = { token: result.token, expiresAt: result.expiresAt, region: result.region };
      cache.set(kind, credential);
      return credential;
    });
    serial = job.catch(() => {});
    return job;
  }
  return {
    hasSavedLogin: () => Boolean(store.read().refreshToken),
    getSkypeToken: () => obtain('chat'),
    getGraphToken: async () => (await obtain('graph')).token,
    async beginLogin() {
      if (login && login.expiresAt > now()) return login;
      login = await microsoft.deviceCode(); return login;
    },
    async completeLogin(signal, approvedAccount = expectedAccount) {
      if (!login) throw new Error('Start Teams login first');
      let interval = login.interval;
      while (now() < login.expiresAt) {
        await delay(interval, undefined, { signal });
        const result = await microsoft.poll(login.secret);
        if (result.error === 'authorization_pending') continue;
        if (result.error === 'slow_down') { interval += 5000; continue; }
        if (!result.refresh_token) throw new Error('Microsoft login did not return a refresh token');
        if (!approvedAccount) throw new Error('Login requires the approved account identity');
        checkCredential(await microsoft.refresh(result.refresh_token, false), approvedAccount);
        store.write({ refreshToken: result.refresh_token, savedAt: new Date(now()).toISOString() });
        cache.clear(); login = undefined;
        return;
      }
      login = undefined; throw new Error('Teams device code expired');
    },
  };
}

export const account = createAccount();
export const getSkypeToken = account.getSkypeToken;
export const getGraphToken = account.getGraphToken;
export const hasSavedLogin = account.hasSavedLogin;
