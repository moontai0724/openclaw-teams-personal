import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeamsChannel } from '../plugin/index.mjs';

test('outbound selects inline images or explicit originals after host media checks and rechecks revocation', async () => {
  const chat = '19:synthetic@thread.v2';
  const bot = '8:live:synthetic';
  const cfg = { channels: { 'teams-personal': { enabled: true, groups: { [chat]: { enabled: true } } } } };
  const bytes = Buffer.from('synthetic image');
  let contentType = 'image/jpeg', forceRevoke = false, metadataCalls = 0;
  const sends: string[] = [];
  const entry = createTeamsChannel({
    policy: { CHANNEL: 'teams-personal', CHAT: '19:uni01_synthetic@thread.v2', GROUP: chat, BOT: bot, SENDER: '8:live:owner',
      normalizedTarget: (value: string) => value, validConfig: (value: any) => value?.enabled === true },
    getSkypeToken: async () => ({}), hasSavedLogin: () => true,
    createTeamsClient: (_auth: any, options: any = {}) => ({
      sendImage: async (to: string, buffer: Buffer, name: string, caption: string, meta: any) => {
        options.assertChat(to); assert.deepEqual(buffer, bytes); assert.equal(name, 'a.jpg'); assert.equal(caption, 'caption');
        assert.deepEqual(meta, { width: 640, height: 480, contentType: 'image/jpeg' }); sends.push('image'); return { arrivalTime: '1794800000001' };
      },
      sendFile: async (to: string, buffer: Buffer) => {
        options.assertChat(to); assert.deepEqual(buffer, bytes); sends.push('file'); return { arrivalTime: '1794800000002' };
      },
    }),
    sdk: {
      defineChannelPluginEntry: (value: any) => value, createChannelMessageAdapterFromOutbound: () => ({}),
      loadOutboundMediaFromUrl: async (_url: string, options: any) => {
        assert.equal(options.optimizeImages, false); assert.equal(options.mediaAccess, 'synthetic-authority');
        if (forceRevoke) cfg.channels['teams-personal'].groups[chat].enabled = false;
        return { buffer: bytes, fileName: 'a.jpg', contentType };
      },
      getImageMetadata: async (buffer: Buffer) => { assert.deepEqual(buffer, bytes); metadataCalls++; return { width: 640, height: 480 }; },
    },
  });
  entry.setRuntime({ config: { current: () => cfg } });
  const context = { cfg, to: chat, text: 'caption', mediaUrl: '/synthetic/a.jpg', mediaAccess: 'synthetic-authority' };
  await entry.plugin.outbound.sendMedia(context);
  await entry.plugin.outbound.sendMedia({ ...context, forceDocument: true });
  contentType = 'application/pdf'; await entry.plugin.outbound.sendMedia(context);
  contentType = 'image/svg+xml'; await entry.plugin.outbound.sendMedia(context);
  assert.deepEqual(sends, ['image', 'file', 'file', 'file']); assert.equal(metadataCalls, 1);
  forceRevoke = true; contentType = 'image/jpeg';
  await assert.rejects(entry.plugin.outbound.sendMedia(context), /no longer approved/);
  assert.equal(sends.length, 4);
});
