import { PocError } from "./errors.ts";
import { open, mkdir, unlink, constants, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { json, object } from './protocol.ts';
import { eventKey, type Message } from './messages.ts';
import type { Scope } from './scope.ts';

type Meta = { type: 'meta'; version: 1; scope: Scope; endpointId: string; since: number };
export type Capture = { type: 'event'; key: string; source: 'push' | 'repair' | 'replay'; capturedAt: string; message: Message };
const MAX_BYTES = 32 * 1024 * 1024;

export class Journal {
  file: FileHandle;
  lockPath: string;
  meta: Meta;
  cursor: number;
  keys = new Set<string>();
  counts = { push: 0, repair: 0, replay: 0 };
  private lane: Promise<unknown> = Promise.resolve();
  private bytes = 0;
  private constructor(file: FileHandle, lockPath: string, meta: Meta) {
    this.file = file; this.lockPath = lockPath; this.meta = meta; this.cursor = meta.since;
  }

  static async create(path: string, scope: Scope, now = Date.now()): Promise<Journal> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const lockPath = `${path}.lock`;
    const lock = await open(lockPath, 'wx', 0o600);
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
    await lock.close();
    let file: FileHandle | undefined;
    try {
      file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new PocError('Journal is not a bounded regular file');
      await file.chmod(0o600);
      const text = await file.readFile('utf8');
      if (text && !text.endsWith('\n')) throw new PocError('Journal has an incomplete tail; inspect before resuming');
      const lines = text.trim() ? text.trimEnd().split('\n').map(json) : [];
      const first = lines[0];
      if (first && (first.type !== 'meta' || first.version !== 1 || JSON.stringify(first.scope) !== JSON.stringify(scope) ||
        typeof first.endpointId !== 'string' || !/^[\da-f-]{36}$/.test(first.endpointId) || typeof first.since !== 'number' || !Number.isFinite(first.since))) {
        throw new PocError('Journal scope or metadata mismatch');
      }
      const meta = (first ?? { type: 'meta', version: 1, scope, endpointId: randomUUID(), since: now }) as Meta;
      const journal = new Journal(file, lockPath, meta);
      journal.bytes = stat.size;
      for (const row of lines.slice(1)) {
        if (row.type === 'checkpoint') {
          if (typeof row.through !== 'number' || !Number.isFinite(row.through) || row.through < journal.cursor) throw new PocError('Invalid checkpoint');
          journal.cursor = row.through;
        } else if (row.type === 'event') {
          const message = object(row.message);
          if (message.chatId !== scope.chatId || row.key !== eventKey(message as Message)) throw new PocError('Invalid captured event');
          journal.keys.add(String(row.key));
        } else throw new PocError('Unknown journal row');
      }
      if (!first) await journal.append(meta);
      return journal;
    } catch (error) {
      await file?.close();
      await unlink(lockPath);
      throw error;
    }
  }

  private async append(value: unknown) {
    const line = `${JSON.stringify(value)}\n`;
    const size = Buffer.byteLength(line);
    if (this.bytes + size > MAX_BYTES) throw new PocError('Journal reached size limit');
    await this.file.writeFile(line);
    await this.file.sync();
    this.bytes += size;
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.lane.then(work);
    // A failed write poisons the journal lane; subsequent writes cannot acknowledge data.
    this.lane = next;
    return next;
  }
  record(message: Message, source: Capture['source']): Promise<boolean> {
    return this.serial(async () => {
      if (message.chatId !== this.meta.scope.chatId || message.author.id === this.meta.scope.expectedAccount) throw new PocError('Capture outside scope');
      if (Date.parse(message.time) < this.meta.since) return false;
      const key = eventKey(message);
      if (this.keys.has(key)) return false;
      await this.append({ type: 'event', key, source, capturedAt: new Date().toISOString(), message } satisfies Capture);
      this.keys.add(key); this.counts[source]++;
      return true;
    });
  }
  checkpoint(through: number): Promise<void> {
    return this.serial(async () => {
      if (!Number.isFinite(through) || through < this.cursor) throw new PocError('Checkpoint cannot move backward');
      await this.append({ type: 'checkpoint', through });
      this.cursor = through;
    });
  }
  async close() {
    try { await this.lane; }
    finally {
      await this.file.close();
      await unlink(this.lockPath);
    }
  }
}
