import { PocError } from "./errors.ts";
import { gunzipSync } from 'node:zlib';

const MAX_BYTES = 1_048_576;
export type Json = Record<string, unknown>;
export function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PocError('Expected JSON object');
  return value as Json;
}
export function json(text: string): Json {
  if (Buffer.byteLength(text) > MAX_BYTES) throw new PocError('Payload exceeds limit');
  return object(JSON.parse(text));
}

export type Frame = { type: string; id: string; wantsAck: boolean; data: string };
export function parseFrame(value: string): Frame {
  if (Buffer.byteLength(value) > MAX_BYTES) throw new PocError('Frame exceeds limit');
  const match = /^([0-8]):(\d*)(\+)?:([^:]*)(?::([\s\S]*))?$/.exec(value);
  if (!match || match[4] !== '') throw new PocError('Invalid Socket.IO 0.9 frame');
  return { type: match[1], id: match[2], wantsAck: Boolean(match[3]), data: match[5] ?? '' };
}
export const eventFrame = (name: string, args: unknown[] = []) => `5:::${JSON.stringify({ name, args })}`;
export const requestAck = (id: number) => `3:::${JSON.stringify({ id, status: 200, body: '' })}`;

export function decodeBody(headers: Json, body: string): Json {
  const encoding = Object.entries(headers).find(([key]) => key.toLowerCase() === 'x-microsoft-skype-content-encoding')?.[1];
  const inflate = (value: string) => {
    if (Buffer.byteLength(value) > MAX_BYTES) throw new PocError('Compressed payload exceeds limit');
    return gunzipSync(Buffer.from(value, 'base64'), { maxOutputLength: MAX_BYTES }).toString('utf8');
  };
  let decoded = json(encoding === 'gzip' ? inflate(body) : body);
  if (typeof decoded.cp === 'string') decoded = json(inflate(decoded.cp));
  else if (typeof decoded.gp === 'string') decoded = json(Buffer.from(decoded.gp, 'base64').toString('utf8'));
  return decoded;
}

export function trustedUrl(value: string, kind: 'socket' | 'registrar' | 'history'): URL {
  const url = new URL(value);
  if (url.username || url.password || (url.port && url.port !== '443')) throw new PocError('Untrusted endpoint');
  const host = url.hostname.toLowerCase();
  const trouter = host === 'go.trouter.teams.microsoft.com' || host.endsWith('.trouter.teams.microsoft.com') || host.endsWith('.trouter.skype.com');
  const allowed = kind === 'socket'
    ? url.protocol === 'wss:' && trouter && url.pathname === '/v4/c'
    : kind === 'registrar'
      ? url.protocol === 'https:' && ['teams.microsoft.com', 'edge.skype.com'].includes(host) && /^\/registrar\/prod\/v[23]\/registrations$/i.test(url.pathname)
      : url.protocol === 'https:' && ['teams.live.com', 'msgapi.teams.live.com'].includes(host) && /\/(?:api\/chatsvc\/consumer\/)?v1\/users\/ME\/conversations\//.test(url.pathname);
  if (!allowed) throw new PocError('Untrusted endpoint');
  return url;
}

export function socketUrl(endpointId: string, host = 'go.trouter.teams.microsoft.com'): URL {
  const url = trustedUrl(`wss://${host}/v4/c`, 'socket');
  url.search = new URLSearchParams({
    tc: JSON.stringify({ cv: '2026.11.16.1', ua: 'TeamsCDL', hr: '', v: '1415/1.0.0.0' }),
    timeout: '70', epid: endpointId, con_num: `${Date.now()}_1`,
  }).toString();
  return url;
}

export function connectedRoute(value: unknown): { path: string; ttl: number } {
  const data = object(value);
  if (typeof data.surl !== 'string') throw new PocError('Connected event lacks routing URL');
  const url = new URL(data.surl);
  trustedUrl(`wss://${url.hostname}/v4/c`, 'socket');
  if (url.protocol !== 'https:' || (url.port && !['443', '3443'].includes(url.port)) || url.username || url.password || url.search || url.hash || !url.pathname.startsWith('/v4/f/')) {
    throw new PocError('Invalid connected routing URL');
  }
  const ttl = Number(data.ttl);
  if (!Number.isFinite(ttl) || ttl < 60 || ttl > 604800) throw new PocError('Invalid connection TTL');
  return { path: url.href, ttl };
}

export function registration(endpointId: string, route: { path: string; ttl: number }) {
  return {
    registrationId: endpointId, nodeId: '',
    clientDescription: {
      appId: 'TeamsCDLWebWorker', aesKey: '', languageId: 'en-US', platform: '1415',
      templateKey: 'TeamsCDLWebWorker_2.7', platformUIVersion: '1415/1.0.0.0', productContext: 'TFL',
    },
    transports: { TROUTER: [{ context: '', path: route.path, ttl: Math.min(route.ttl, 3600) }] },
  };
}
