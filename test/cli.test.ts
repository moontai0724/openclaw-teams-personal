import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('CLI replays synthetic data, preserves reply/mention and deduplicates across runs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teams-cli-test-'));
  const journal = join(dir, 'capture.jsonl');
  try {
    for (let run = 0; run < 2; run++) {
      const result = spawnSync(process.execPath, ['src/cli.ts', 'replay', '--config', 'test/fixtures/scope.json', '--input', 'test/fixtures/events.jsonl', '--journal', journal], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
    const entries = (await readFile(journal, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const events = entries.filter((entry) => entry.type === 'event');
    assert.equal(events.length, 3);
    assert.equal(events[1].message.mentions[0].id, '8:live:.cid.synthetic');
    assert.equal(events[2].message.replyTo.id, '1794800000001');
    assert.equal(events.some((entry) => entry.message.chatId.includes('unapproved')), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('live command refuses placeholder group before loading any credential provider', () => {
  const result = spawnSync(process.execPath, ['src/cli.ts', 'listen', '--config', 'config.example.json', '--journal', '/not-used', '--auth-module', '/does-not-exist'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /fatal/);
  assert.doesNotMatch(result.stderr, /does-not-exist/);
});
