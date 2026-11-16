import { parseArgs } from 'node:util';
import { access, copyFile, readFile, writeFile, rename, constants } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const { values } = parseArgs({ options: {
  target: { type: 'string' }, restore: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
  esbuild: { type: 'string' },
} });
if (!values.target) throw new Error('--target must name the existing approved plugin index.mjs');
const target = resolve(values.target);
if (!target.endsWith('/plugin/index.mjs')) throw new Error('Target must be the existing plugin/index.mjs');
const root = dirname(dirname(target));
const backup = join(dirname(target), 'index.polling-backup.mjs');
await access(join(root, 'upstream/src/auth.js'));
await access(join(dirname(target), 'policy.mjs'));
const manifest = JSON.parse(await readFile(join(dirname(target), 'openclaw.plugin.json'), 'utf8'));
if (manifest.id !== 'teams-personal') throw new Error('Wrong plugin ID');
if (values.restore) {
  if (!values['dry-run']) await copyFile(backup, target);
  process.stdout.write('Restore prepared from the preserved polling entry. Reload teams-personal to apply.\n');
} else {
  const factory = resolve(dirname(fileURLToPath(import.meta.url)), '../plugin/index.mjs');
  const source = `import { defineChannelPluginEntry } from 'openclaw/plugin-sdk/channel-core';
import { dispatchInboundDirectDm, dispatchChannelInboundTurn } from 'openclaw/plugin-sdk/channel-inbound';
import { createChannelIngressMonitor, bindIngressLifecycleToReplyOptions, createChannelMessageAdapterFromOutbound } from 'openclaw/plugin-sdk/channel-outbound';
import { getSkypeToken, hasSavedLogin } from '../upstream/src/auth.js';
import { createTeamsClient } from '../upstream/src/core/teams.js';
import * as policy from './policy.mjs';
import { createTeamsChannel } from './realtime.mjs';
export default createTeamsChannel({ getSkypeToken, hasSavedLogin, createTeamsClient, policy,
  sdk: { defineChannelPluginEntry, dispatchInboundDirectDm, dispatchChannelInboundTurn,
    createChannelIngressMonitor, bindIngressLifecycleToReplyOptions, createChannelMessageAdapterFromOutbound } });
`;
  if (values['dry-run']) process.stdout.write(source);
  else {
    if (!values.esbuild) throw new Error('--esbuild must name the existing host bundler; no packages are installed');
    const built = spawnSync(values.esbuild, [factory, '--bundle', '--platform=node', '--format=esm', '--target=node24', `--outfile=${join(dirname(target), 'realtime.mjs.tmp')}`], { stdio: 'inherit' });
    if (built.status !== 0) throw new Error('Transport bundle failed; original entry was not changed');
    // Preserve exactly one original. Never overwrite it with a later bridge.
    try { await copyFile(target, backup, constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await rename(join(dirname(target), 'realtime.mjs.tmp'), join(dirname(target), 'realtime.mjs'));
    await writeFile(target + '.tmp', source, { mode: 0o644 });
    await rename(target + '.tmp', target);
    process.stdout.write('Deployment bridge written. Reload teams-personal to apply; Gateway config was not changed.\n');
  }
}
