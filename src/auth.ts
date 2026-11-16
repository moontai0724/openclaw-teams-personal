import { PocError } from "./errors.ts";
import { pathToFileURL } from 'node:url';
import { isAbsolute } from 'node:path';
import { json } from './protocol.ts';

export type Credential = { token: string; expiresAt: number };
export type AuthProvider = () => Promise<Credential>;
export class IdentityError extends PocError {}

export function checkCredential(value: unknown, expectedAccount: string): Credential {
  if (!value || typeof value !== 'object') throw new IdentityError('Auth provider returned no credential');
  const { token, expiresAt } = value as Record<string, unknown>;
  if (typeof token !== 'string' || token.length > 32768) throw new IdentityError('Invalid credential');
  let claims;
  try { claims = json(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); }
  catch { throw new IdentityError('Cannot identify credential account'); }
  if (`8:${claims.skypeid}` !== expectedAccount) throw new IdentityError('Credential account does not match configured identity');
  const expires = typeof expiresAt === 'number' ? expiresAt : Number(claims.exp) * 1000;
  if (!Number.isFinite(expires) || expires - Date.now() < 60_000) throw new IdentityError('Credential is expired or too close to expiry');
  return { token, expiresAt: expires };
}

export async function loadAuth(modulePath: string, expectedAccount: string): Promise<AuthProvider> {
  if (!isAbsolute(modulePath)) throw new PocError('Auth module path must be absolute');
  const provider = await import(pathToFileURL(modulePath).href);
  if (typeof provider.getSkypeToken !== 'function') throw new PocError('Auth module must export getSkypeToken()');
  return async () => checkCredential(await provider.getSkypeToken(), expectedAccount);
}
