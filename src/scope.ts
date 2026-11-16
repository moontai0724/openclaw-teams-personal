import { PocError } from "./errors.ts";
export type Scope = { chatId: string; expectedAccount: string };

export function parseScope(value: unknown): Scope {
  if (!value || typeof value !== 'object') throw new PocError('Scope must be an object');
  const { chatId, expectedAccount } = value as Record<string, unknown>;
  if (typeof chatId !== 'string' || !/^19:[A-Za-z0-9_-]+@thread\.v2$/.test(chatId) || chatId.startsWith('19:uni01_')) {
    throw new PocError('An exact Teams group ID is required');
  }
  if (typeof expectedAccount !== 'string' || !/^8:(?:live:|orgid:)[A-Za-z0-9.:-]+$/.test(expectedAccount)) {
    throw new PocError('An exact expected account MRI is required');
  }
  return { chatId, expectedAccount };
}
