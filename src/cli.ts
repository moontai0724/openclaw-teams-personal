import { PocError, failureReason } from "./errors.ts";
import { parseArgs } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseScope } from './scope.ts';
import { json, trustedUrl, type Json } from './protocol.ts';
import { loadAuth } from './auth.ts';
import { Journal, type Capture } from './journal.ts';
import { eventResource, normalize } from './messages.ts';
import { repairHistory } from './history.ts';
import { listen, type Log } from './transport.ts';

const usage = `Receive-only Teams Personal PoC (Node.js 24+)

  node src/cli.ts check --config FILE
  node src/cli.ts replay --config FILE --input SYNTHETIC_JSONL --journal FILE
  node src/cli.ts listen --config FILE --auth-module ABSOLUTE_MODULE --journal FILE
    [--duration 300] [--drop-after 30 --reconnect-delay 10]

listen creates a bounded account event registration, but never sends chat messages.
Captures contain selected-group text; keep the journal under gitignored local/.
The external auth module must export getSkypeToken() -> { token, expiresAt }.
No tokens belong in command-line arguments, config or this repository.
`;

const log: Log = (event, data) => { process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...data })}\n`); };
function seconds(value: string | undefined, fallback: number, max: number) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 1 || number > max) throw new PocError('Time option must be a positive integer within its limit');
  return number * 1000;
}

export async function main(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    config: { type: 'string' }, journal: { type: 'string' }, input: { type: 'string' },
    'auth-module': { type: 'string' }, duration: { type: 'string' },
    'drop-after': { type: 'string' }, 'reconnect-delay': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help || args.length === 0) { process.stdout.write(usage); return 0; }
  const [command] = positionals;
  if (positionals.length !== 1 || !['check', 'replay', 'listen'].includes(command)) throw new PocError('Expected check, replay or listen');
  if (!values.config) throw new PocError('--config is required');
  const config = json(await readFile(values.config, 'utf8'));
  if (Object.keys(config).some((key) => !['chatId', 'expectedAccount', 'registrar'].includes(key))) throw new PocError('Unknown config field; do not put credentials in config');
  const scope = parseScope(config);
  const registrar = typeof config.registrar === 'string' ? config.registrar : 'https://teams.microsoft.com/registrar/prod/v2/registrations';
  trustedUrl(registrar, 'registrar');
  if (command === 'check') { log('config_valid', { mode: 'receive-only' }); return 0; }
  if (!values.journal) throw new PocError('--journal is required');
  if (command === 'listen' && /REPLACE|synthetic/i.test(scope.chatId)) throw new PocError('Replace the synthetic group with the explicitly approved test group');
  const duration = seconds(values.duration, 300, 3600);
  const dropAfterMs = values['drop-after'] ? seconds(values['drop-after'], 30, 3599) : undefined;
  if (dropAfterMs && dropAfterMs >= duration) throw new PocError('--drop-after must be shorter than --duration');
  if (values['reconnect-delay'] && !dropAfterMs) throw new PocError('--reconnect-delay requires --drop-after');
  const reconnectDelayMs = values['reconnect-delay'] ? seconds(values['reconnect-delay'], 10, 60) : undefined;
  if (command === 'listen' && !values['auth-module']) throw new PocError('--auth-module is required');
  if (command === 'replay' && !values.input) throw new PocError('--input is required');
  const journal = await Journal.create(resolve(values.journal), scope, command === 'replay' ? 0 : Date.now());
  const capture = async (body: Json, source: Capture['source']) => {
    const event = eventResource(body);
    if (!event) return;
    const message = normalize(event.resource, event.type, scope);
    if (message && await journal.record(message, source)) log('captured', { source, id: message.id, kind: message.kind });
  };
  try {
    if (command === 'replay') {
      if ((await stat(values.input!)).size > 1_048_576) throw new PocError('Replay fixture exceeds limit');
      for (const line of (await readFile(values.input!, 'utf8')).split('\n')) if (line.trim()) await capture(json(line), 'replay');
      log('replay_complete', journal.counts);
      return 0;
    }
    const auth = await loadAuth(values['auth-module']!, scope.expectedAccount);
    const controller = new AbortController();
    let stopping = false;
    const stop = () => { stopping = true; controller.abort(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    const deadline = setTimeout(stop, duration);
    const repair = async () => {
      log('repair_started');
      const result = await repairHistory({ fetch, auth, journal }, controller.signal);
      log('repair_complete', result);
    };
    let registered = false;
    try {
      log('live_run_started', { durationSeconds: duration / 1000, endpointId: journal.meta.endpointId });
      await listen({ auth, fetch, socket: (url) => new WebSocket(url), log,
        onBody: (body) => capture(body, 'push'),
        onReady: async () => { registered = true; await repair(); }, onLoss: repair,
      }, { endpointId: journal.meta.endpointId, registrar, dropAfterMs, reconnectDelayMs }, controller.signal);
    } finally {
      clearTimeout(deadline);
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      log('live_run_complete', { ...journal.counts, registered, boundedStop: stopping });
    }
    // Registered alone is not end-to-end proof. A run without a push event is incomplete.
    return registered && journal.counts.push > 0 ? 0 : 2;
  } finally { await journal.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { log('fatal', { message: failureReason(error) }); process.exitCode = 1; }
}
