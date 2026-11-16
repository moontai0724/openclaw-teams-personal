# Teams Personal realtime transport and OpenClaw channel

Independent Trouter transport, a receive-only validation CLI, and a channel adapter
that replaces the installed polling receive loop through a small deployment bridge.
The adapter retains the existing approved account, auth store, native ingress and
outbound client. Chat scope is an explicit host allowlist; adding a group requires
owner authorization. See [live acceptance/deployment](docs/LIVE-TEST.md).

## Receive-only CLI boundary

- One explicitly selected group, text messages only.
- Trouter connection, authentication, notification registration and recovery.
- Preserve message identity, author, time, native mentions and reply metadata.
- No model invocation, sending, marking read, presence publication or group management.
- No new login or credential store. An explicit external auth-provider module supplies
  the existing bot account's short-lived token in memory.

## Runtime

Node.js 24 or newer. No dependency installation or build is required; Node executes
erasable TypeScript directly. This stage has runtime tests and syntax checks, not a
TypeScript compiler gate. The compiler/tooling choice is deferred to plugin packaging.

```sh
node --version
npm test
npm run check
```

For a credential-free demo:

```sh
node src/cli.ts replay --config test/fixtures/scope.json \
  --input test/fixtures/events.jsonl --journal local/synthetic.jsonl
```

## Channel behavior

- WebSocket events are primary; history reads happen at connection / gap recovery,
  not every 20 seconds. No new public HTTP endpoint is opened.
- Only authorized groups/DMs reach context or native ingress. Native mentions,
  verified replies to the bot and commands retain the existing group trigger rule.
- Untagged group text becomes bounded recent context. Quoted text is attached via
  the SDK's supplemental quote facts. Edits update context without a new reply.
- Existing native turn queue/deduplication and outbound destination checks remain.
- Multiple explicitly approved groups have separate context, sessions and reply
  destinations. Adding a group preserves existing replay cursors and starts its
  dispatch fence at activation; older text may supply context, not replayed turns.
- Joining a group or mentioning the bot does not automatically enroll that group.
- The shared `message` tool supports `react` and `emoji-list`. Reactions reuse the
  installed outbound client's emoji catalogue; `remove: true` removes only the
  bot's selected emoji. Every mutation is read back as the bot's own reaction.
  Missing message IDs fall back only to the current Teams message in the same
  chat. Account/destination guards remain in force; no new dependency is added.
  An unverified outcome is reported without automatically resending the mutation.

See [status](docs/STATUS.md) for observed verification; synthetic fixtures and local
tests never establish successful Teams registration or actual message delivery.
