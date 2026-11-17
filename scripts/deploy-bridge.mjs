import { parseArgs } from 'node:util';
import { access, readFile, writeFile, rename } from 'node:fs/promises';
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
await access(join(dirname(target), 'policy.mjs'));
const manifest = JSON.parse(await readFile(join(dirname(target), 'openclaw.plugin.json'), 'utf8'));
if (manifest.id !== 'teams-personal') throw new Error('Wrong plugin ID');
if (values.restore) {
  throw new Error('Polling rollback is retired. Deploy a reviewed independent source revision instead; retain replay/auth state.');
} else {
  const factory = resolve(dirname(fileURLToPath(import.meta.url)), '../plugin/index.mjs');
  const source = `import { defineChannelPluginEntry } from 'openclaw/plugin-sdk/channel-core';
import { createChannelInboundEnvelopeBuilderAsync, dispatchChannelInboundTurn } from 'openclaw/plugin-sdk/channel-inbound';
import { createChannelIngressMonitor, bindIngressLifecycleToReplyOptions, createTypingCallbacks, createChannelMessageAdapterFromOutbound, createChannelDeliveryAccumulator } from 'openclaw/plugin-sdk/channel-outbound';
import { jsonResult } from 'openclaw/plugin-sdk/channel-actions';
import { saveMediaBuffer } from 'openclaw/plugin-sdk/media-store';
import { loadOutboundMediaFromUrl } from 'openclaw/plugin-sdk/outbound-media';
import * as policy from './policy.mjs';
import { createTeamsChannel } from './realtime.mjs';
import { enrollOwnerGroup as sharedEnroll } from '../../../maintenance/owner-group-enrollment/enrollment.mjs';
export default createTeamsChannel({ policy, sharedEnroll,
  sdk: { defineChannelPluginEntry, createChannelInboundEnvelopeBuilderAsync, dispatchChannelInboundTurn,
    createChannelIngressMonitor, bindIngressLifecycleToReplyOptions, createTypingCallbacks, createChannelMessageAdapterFromOutbound,
    jsonResult, saveMediaBuffer, loadOutboundMediaFromUrl, createChannelDeliveryAccumulator } });
`;
  if (values['dry-run']) process.stdout.write(source);
  else {
    await access(resolve(dirname(target), '../../../maintenance/owner-group-enrollment/enrollment.mjs'));
    if (!values.esbuild) throw new Error('--esbuild must name the existing host bundler; no packages are installed');
    const built = spawnSync(values.esbuild, [factory, '--bundle', '--platform=node', '--format=esm', '--target=node24', `--outfile=${join(dirname(target), 'realtime.mjs.tmp')}`], { stdio: 'inherit' });
    if (built.status !== 0) throw new Error('Transport bundle failed; original entry was not changed');
    await rename(join(dirname(target), 'realtime.mjs.tmp'), join(dirname(target), 'realtime.mjs'));
    const schema = manifest.channelConfigs?.['teams-personal']?.schema;
    if (!schema?.properties) throw new Error('Expected existing Teams channel config schema');
    Object.assign(schema.properties, {
      groupPolicy: { type: 'string', enum: ['allowlist', 'disabled'] },
      enrollmentOwnerId: { type: 'string' },
      groups: { type: 'object', propertyNames: { pattern: '^19:[a-zA-Z0-9-]+@thread\\.v2$' },
        additionalProperties: { type: 'object', additionalProperties: false, properties: {
          enabled: { type: 'boolean' }, requireMention: { type: 'boolean', const: true },
          allowFrom: { type: 'array', items: { type: 'string' } },
          activationId: { type: 'string', pattern: '^[1-9]\\d{0,23}$' }, activatedAt: { type: 'number' },
        } },
      },
    });
    const manifestPath = join(dirname(target), 'openclaw.plugin.json');
    manifest.description = 'Independent Teams personal account, realtime chat and scoped file/message tools';
    manifest.contracts = { ...manifest.contracts,
      tools: [...new Set([...(manifest.contracts?.tools ?? []), 'teams_chat'])] };
    await writeFile(manifestPath + '.tmp', JSON.stringify(manifest, null, 2) + '\n', { mode: 0o644 });
    await rename(manifestPath + '.tmp', manifestPath);
    await writeFile(target + '.tmp', source, { mode: 0o644 });
    await rename(target + '.tmp', target);
    process.stdout.write('Deployment bridge written. Reload teams-personal to apply; Gateway config was not changed.\n');
  }
}
