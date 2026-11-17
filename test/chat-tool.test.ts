import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatTool } from '../plugin/chat-tool.mjs';

const chat = '19:synthetic@thread.v2';
function setup() {
  let active = true, saved = 0;
  const bytes = Buffer.from('original bytes; no parsing');
  const context = { messageChannel: 'teams-personal', nativeChannelId: chat,
    assertInvocationCurrent() { if (!active) throw new Error('expired'); } };
  const options = { policy: { CHANNEL: 'teams-personal', BOT: '8:live:synthetic', targetAllowed: (to: string) => to === chat, validConfig: () => true },
    currentConfig: () => ({}), getSkypeToken: async () => ({}), sdk: { jsonResult: (result: unknown) => result,
      saveMediaBuffer: async (input: Buffer, _type: string, _subdir: string, _max: number, name: string) => {
        assert.equal(name, 'original.docx'); assert.deepEqual(input, bytes); saved++; return { path: '/synthetic/original.docx' };
      } },
    clientFactory: (_auth: unknown, { assertChat }: any) => ({
      readAttachment: async (to: string) => { assertChat(to); return { bytes, name: 'original.docx', contentType: 'application/octet-stream', size: bytes.length }; },
      getMessages: async (to: string) => { assertChat(to); return []; },
    }),
  };
  return { context, options, expire: () => { active = false; }, saves: () => saved };
}
test('chat tool is unavailable outside its exact trusted Teams conversation', () => {
  const f = setup();
  assert.equal(createChatTool({ ...f.context, messageChannel: 'telegram' }, f.options), null);
  assert.equal(createChatTool({ ...f.context, nativeChannelId: '19:other@thread.v2' }, f.options), null);
  assert.equal(createChatTool({ messageChannel: 'teams-personal' }, f.options), null);
});
test('chat tool delivers an unchanged original document and no generated extraction', async () => {
  const f = setup(); const tool = createChatTool(f.context, f.options)!;
  const result = await tool.execute('synthetic', { action: 'read-file', messageId: '1794800000001' });
  assert.equal(f.saves(), 1);
  assert.equal(result.details.name, 'original.docx');
  assert.equal(result.details.size, 26);
  assert.equal(result.details.text, undefined);
  assert.equal(result.content.length, 1);
  f.expire(); await assert.rejects(tool.execute('expired', { action: 'read' }), /expired/);
});
