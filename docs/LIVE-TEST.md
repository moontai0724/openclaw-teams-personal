# Deployment, acceptance and recovery

Use an approved account and exact chat scope. Keep credentials, account/message
IDs and real captures in private local storage. Run offline gates before deploying;
record results in [STATUS.md](STATUS.md).

## Channel deployment

The channel factory lives in `plugin/`. The deployment bridge binds the host SDK,
local admission policy and shared enrollment core, then bundles account, transport,
message/file and action code into `realtime.mjs`.

The target integration must contain `plugin/index.mjs`, `plugin/policy.mjs` and
`plugin/openclaw.plugin.json` with ID `teams-personal`. The shared core must be at
`maintenance/owner-group-enrollment/enrollment.mjs` relative to the host workspace.
Use an existing esbuild executable:

```sh
node scripts/deploy-bridge.mjs --target /ABSOLUTE/WORKSPACE/integrations/teams-personal/plugin/index.mjs --dry-run
node scripts/deploy-bridge.mjs \
  --target /ABSOLUTE/WORKSPACE/integrations/teams-personal/plugin/index.mjs \
  --esbuild /ABSOLUTE/PATH/TO/esbuild
```

The script writes the bridge, bundle and manifest schema/tool contract. It does
not install dependencies or write the host configuration. The dry run prints the
bridge source without building or writing it. Review the target and diffs before
applying a deployment.

Reload `teams-personal` with OpenClaw's `plugins` tool using
`action: reloadAndResume`. This releases the active turn's plugin lease before
reload. A synchronous CLI reload can wait on that same lease.

### Admission and state

The host policy binds the approved account, DM/sender and default groups.
`GROUP` supplies the primary group's cursor identity; `GROUPS` supplies exact
default room IDs and `groupLabel(id)` supplies display labels. A configured
`channels.teams-personal.groups` map is authoritative, including disabled entries.
The runtime checks that map for context, ingress and outbound actions. Each group
uses a separate route, session and destination.

`watermark.json` supplies the initial migration fence. `realtime-state.json` holds
endpoint identity, per-chat activation baselines and repair checkpoints. Native
ingress owns durable turn deduplication, with 30-day / 2,000-entry completed
retention. Preserve all of these files. Adding a room initializes its activation
fence; earlier history may supply context but cannot open a new turn. Revoked
room checkpoints remain state, not authorization. Malformed state fails closed.

Account-wide socket events are filtered before context or model dispatch. Unknown
rooms qualify only through the verified native-tag enrollment rule; no discovery
history is fetched for unapproved rooms. Joining a room alone does not admit it.

## Post-deployment acceptance

Verify the selected entry, source digest, runtime generation, accepted tool
contract, authenticated registration, scoped repair and ready status. Then send a
fresh addressed request in an approved Teams chat and correlate:

1. One Trouter event and one native ingress/model turn.
2. One correctly routed reply, confirmed by platform readback.
3. No duplicate dispatch or replies from recovered history.
4. Separate DM/group histories and the configured private sender guard.

Test untagged context followed by a native mention, a reply to a bot message,
and an edit. Ordinary unmentioned text and edits should update context without
an extra turn. Edits do not rewrite a turn already running. Context is ephemeral:
100 cached messages per chat, at most 50 entries / 20,000 text characters per turn.

### Messages and original files

Use newly created bot messages for direct send/edit/delete tests. Verify exact
message readback after each mutation. Send an original file, download it and
compare bytes and filename; then remove the test messages when authorized.
An ambiguous write requires reconciliation before any retry.

For native tool acceptance, send an original file with a fresh bot tag in an
approved Teams chat. Ask the agent to list/read it with `teams_chat` and return
the original. Verify one reply, the correct destination and downloaded bytes.
Exercise native read/edit/delete separately using known bot-owned message IDs.
The host binds these tools to the trusted current Teams conversation/account;
requests from a different channel are rejected before adapter handoff.

The channel stages at most five attachments per turn. Additional files can be
requested with `teams_chat(action: "read-file")`. Original files are limited to
15 MiB, and inline image downloads to 5 MiB. Content extraction and transcoding
belong to host tools. A read leaves messages unread; use `mark-read` only on an
explicit request and verify the resulting horizon.

### Emoji reactions

Discover supported glyphs with `message(action: "emoji-list")`, then use
`message(action: "react", messageId: "<observed ID>", emoji: "👍")` in the same
Teams chat. Confirm the bot's reaction by readback, an unchanged repeated request,
and removal with `remove: true`, without changing another user's reaction.
An omitted ID may use the current inbound Teams message. Removal requires the
selected emoji. Dry-run validation performs no account/network I/O.

Reaction updates must not open another model turn. A lost mutation response may
be reconciled by readback; `ok: false, verified: false` is not a delivery receipt
and must not trigger an automatic second write.

### Typing and presence

Observe native typing during an addressed turn and its disappearance after
completion, silence or cancellation, allowing for Teams expiry. Correlate the UI
with start/stop logs and one normal reply. Untagged ambient traffic must not start
typing. The SDK refreshes every four seconds, has a ten-minute safety TTL and
stops its loop after two consecutive API failures. Account/destination checks run
on each control, including after async token preparation.

Both DM and group turns use routed dispatch with typing callbacks. The per-turn
`typingMode: instant` setting leaves persisted global preferences unchanged.
Incoming transient controls are excluded from history and durable ingress.

For presence, verify publication after authenticated registration, bot-only API
readback and a normal 60-second activity refresh. Observe the bot's status dot in
Teams. Disconnect/stop removes only this connector's endpoint. Manual overrides
or other clients may affect combined status; abrupt process loss relies on native
expiry. API availability alone does not establish requester-visible UI state.

### Owner native-tag enrollment

Configure `enrollmentOwnerId` only after explicitly verifying that Teams identity.
The host policy requires it to match the approved sender; DM allowlisting alone
is not proof of ownership. The bridge supplies the shared enrollment core and
projects this channel-local role into its decision, leaving global owners intact.

A qualifying event is a fresh original group `NewMessage` push from that identity
with the bot's native MRI mention. Replies, commands, forwards, edits, history
repair, plain names and join events do not qualify. Disabled channel/room policies
are respected. Ordinary unmentioned traffic causes no extra persistence/API calls.

In a genuinely unlisted room, first send ordinary owner text and verify no
admission. Then send the native tag. Verify one exact room entry with
`allowFrom: ['*']`, `requireMention: true` and the trigger's `activationId` /
`activatedAt`; confirm one ingress/model/reply without older replayed requests.
Have another member tag the bot to verify ordinary member access. Existing room,
DM, endpoint and replay settings must remain intact. Use real events; do not remove
an approved room or inject production events to manufacture this test.

## Receive-only CLI

Copy `config.example.json` to gitignored `local/scope.json` and fill the exact
approved group and expected bot MRI. Supply the absolute path to `src/account.mjs`
or a trusted module exporting `getSkypeToken()` with `{ token, expiresAt }`.

```sh
node src/cli.ts check --config local/scope.json
node src/cli.ts listen --config local/scope.json \
  --auth-module /ABSOLUTE/PATH/TO/REPOSITORY/src/account.mjs \
  --journal local/live.jsonl --duration 300
```

The CLI records selected-group text in a mode-0600 journal. Logs contain stage
names and selected message IDs, not raw frames or credentials. Exit 0 requires a
push event; exit 2 means the finite run ended without one; exit 1 indicates failure.
It sends no chat messages, marks nothing read and publishes no presence. The
messaging registration expires at its TTL after the connection closes.

Send ordinary text, a native bot mention and a reply, then edit an earlier message.
Verify distinct IDs, authors/times, mention MRI, reply target/preview and update
version. Registration alone is not incoming-delivery acceptance.

### Gap recovery and shutdown

For a controlled gap, add `--drop-after 30 --reconnect-delay 10`. Send a real
message during the reported gap and verify one recovered event without duplicate
keys. Production acceptance additionally requires one native ingress/reply.
Run across an actual token expiry boundary to verify long-running renewal.
Use an isolated endpoint/journal, not the production endpoint identity.

After shutdown, late HTTP completion must not restore connected status, schedule
renewal or start repair. An uncleanly killed journal leaves a `.lock`; check the
recorded PID and capture before removing only a stale lock. Reconcile a partial
journal tail rather than truncating it or resetting production replay state.

## Rollback

Deploy a reviewed source revision with the bridge script and reload only
`teams-personal`. Preserve the credential store, watermark, realtime state and
native ingress queue. Check loaded artifacts, connection health and absence of
duplicate replies after rollback. Source history is not permission to replay old
approval or delivery records.
