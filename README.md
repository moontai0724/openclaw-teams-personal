# Teams Personal realtime transport and OpenClaw channel

Independent Trouter transport, a receive-only validation CLI, and a channel adapter
that replaces the installed polling receive loop through a small deployment bridge.
The adapter retains the existing approved account, auth store, native ingress and
outbound client. Chat scope is an exact per-room allowlist. A verified enrollment
owner can authorize a new room by an original native bot mention; the feature is off until
the host config explicitly binds that identity.
See [live acceptance/deployment](docs/LIVE-TEST.md).

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
- Joining alone never enrolls a group. With the verified enrollment identity
  configured, only that owner's fresh original native bot tag enrolls a new group.
  Replies, commands, forwards, edits, old history and other senders do not enroll.
  Each new room allows all members, retains mention/reply gating and grants no
  global owner or administrative permissions. Disabled rooms remain disabled.
- The shared `message` tool supports `react` and `emoji-list`. Reactions reuse the
  installed outbound client's emoji catalogue; `remove: true` removes only the
  bot's selected emoji. Every mutation is read back as the bot's own reaction.
  Missing message IDs fall back only to the current Teams message in the same
  chat. Account/destination guards remain in force; no new dependency is added.
  An unverified outcome is reported without automatically resending the mutation.

- Addressed DM/group turns send native typing controls while the model works,
  refreshed every four seconds through the host SDK. Completion, silence, errors
  and cancellation stop refresh; Teams clears the transient indicator on expiry.
  Live policy and bot identity are rechecked before every control. Typing failures
  do not block text replies. Typing does not change presence, scope or global config.

- The channel publishes native Available presence while its authenticated message
  transport is connected, refreshing its own endpoint every 60 seconds. Socket
  loss, account stop and plugin replacement abort refresh and remove only this
  connector's presence endpoint. A separate random ID keeps it independent of
  the messaging endpoint and other clients. No forced account-wide availability,
  status note, new permission, schedule or config field is introduced. Manual
  availability and other clients may affect the combined status. Unclean process
  exits depend on Teams expiry; offline presentation is not guaranteed immediate.
  Presence errors are contained and do not stop text receipt/replies.

Presence is loaded in production generation 4 (2026-11-17 09:35 Asia/Taipei).
The normal 60-second refresh succeeded and self-readback is Available/Available;
requester-observed green-dot visibility remains unverified. See the status record
for deployed artifact provenance and the pending UI check.

See [status](docs/STATUS.md) for observed verification; synthetic fixtures and local
tests never establish successful Teams registration or actual message delivery.
