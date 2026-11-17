import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('deployment declares the chat tool without discarding other manifest contracts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teams-deployment-'));
  try {
    const plugin = join(root, 'integrations/teams-personal/plugin');
    const enrollment = join(root, 'maintenance/owner-group-enrollment');
    await mkdir(plugin, { recursive: true });
    await mkdir(enrollment, { recursive: true });
    await writeFile(join(plugin, 'policy.mjs'), 'export const CHANNEL = "teams-personal";');
    await writeFile(join(enrollment, 'enrollment.mjs'), 'export const enrollOwnerGroup = () => {};');
    const manifestPath = join(plugin, 'openclaw.plugin.json');
    await writeFile(manifestPath, JSON.stringify({ id: 'teams-personal', channels: ['teams-personal'],
      contracts: { tools: ['existing_tool'], services: ['existing_service'] },
      channelConfigs: { 'teams-personal': { schema: { properties: { enabled: { type: 'boolean' } } } } } }));
    // The stub isolates publishing/metadata from bundling; production uses host esbuild.
    const bundler = join(root, 'bundler.mjs');
    await writeFile(bundler, '#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(process.argv.find(arg => arg.startsWith("--outfile=")).slice(10), "export {};\\n");\n', { mode: 0o755 });
    for (let attempt = 0; attempt < 2; attempt++) {
      const deployed = spawnSync(process.execPath, ['scripts/deploy-bridge.mjs', '--target', join(plugin, 'index.mjs'), '--esbuild', bundler], { encoding: 'utf8' });
      assert.equal(deployed.status, 0, deployed.stderr);
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      assert.deepEqual(manifest.contracts.tools, ['existing_tool', 'teams_chat']);
      assert.deepEqual(manifest.contracts.services, ['existing_service']);
      assert.deepEqual(manifest.channelConfigs['teams-personal'].schema.properties.enabled, { type: 'boolean' });
      assert.match(await readFile(join(plugin, 'index.mjs'), 'utf8'), /createTeamsChannel/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
