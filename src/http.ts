import { PocError } from "./errors.ts";
import { json, type Json } from './protocol.ts';

export type Fetch = typeof globalThis.fetch;
export class HttpError extends PocError {
  status: number;
  retryAfterMs: number;
  constructor(status: number, retryAfterMs = 0) {
    super(`Teams HTTP status ${status}`);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export async function readJson(response: Response): Promise<Json> {
  const reader = response.body?.getReader();
  if (!reader) throw new PocError('Empty HTTP response');
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1_048_576) throw new PocError('HTTP response exceeds limit');
      parts.push(value);
    }
  } finally { await reader.cancel(); }
  return json(Buffer.concat(parts).toString('utf8'));
}

export async function request(fetcher: Fetch, url: URL, init: RequestInit, signal: AbortSignal): Promise<Response> {
  const response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
  if (!response.ok) {
    const header = response.headers.get('retry-after');
    const seconds = header === null ? 0 : Number(header);
    const wait = header && !Number.isFinite(seconds) ? Date.parse(header) - Date.now() : seconds * 1000;
    await response.body?.cancel();
    throw new HttpError(response.status, Math.max(0, Math.min(Number.isFinite(wait) ? wait : 0, 300_000)));
  }
  return response;
}
