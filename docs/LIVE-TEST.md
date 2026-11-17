# Live acceptance and recovery

The bot identity and approved DM remain unchanged. Groups are an exact allowlist;
a verified enrollment owner may authorize one additional group with an original
native tag. Account-wide push facts are checked before rejecting an unknown
group, but nonqualifying chats are dropped before caching or model dispatch.
No discovery history is fetched for unapproved rooms. Real captures stay out of Git.

## Receive-only CLI

Copy `config.example.json` into private, gitignored `local/scope.json`, fill the
exact test group and bot MRI, then validate it. Supply the absolute path to the
existing approved auth module; do not copy its store or pass a token as an argument.

```sh
node src/cli.ts check --config local/scope.json
node src/cli.ts listen --config local/scope.json \
  --auth-module /ABSOLUTE/PATH/TO/EXISTING/auth.js \
  --journal local/live.jsonl --duration 300
```

Logs contain stage names and selected message IDs, not raw frames or credentials.
The journal contains selected-group text and is mode 0600. Exit 0 requires a push
event; exit 2 means the bounded run ended without push proof. Exit 1 is a failure.
No chat messages are sent by this CLI. Registration and shutdown do not mark read.
The PoC registration expires at its bounded TTL after the connection closes.

Send ordinary text, a native bot mention, and a reply. Edit an earlier message.
Verify distinct message IDs, author/time, native mention MRI, reply target/preview,
and a new update version. Do not infer success from `registered` alone.

For a controlled gap, add `--drop-after 30 --reconnect-delay 10`, send text during
the reported gap, and confirm one repair event with no duplicate on reconnect.
Repeat across token refresh before claiming long-running token lifecycle coverage.

An uncleanly killed journal leaves a `.lock`; check its recorded PID and inspect
the capture before removing only the stale lock. A partial journal tail fails
closed and must be reconciled, not truncated blindly. Do not reset production
watermarks or the native ingress queue to resolve replay problems.

## Channel deployment bridge

The independent channel implementation lives in `plugin/`. The bridge retains
the installed SDK wiring, approved local policy and existing MIT upstream auth /
outbound client. This is not yet a standalone npm-distributed plugin package.

```sh
node scripts/deploy-bridge.mjs --target /ABSOLUTE/EXISTING/plugin/index.mjs --dry-run
node scripts/deploy-bridge.mjs --target /ABSOLUTE/EXISTING/plugin/index.mjs \
  --esbuild /ABSOLUTE/EXISTING/esbuild/bin/esbuild
```

The host's already installed esbuild bundles this repository into `realtime.mjs`
beside the bridge; runtime never imports a mutable checkout by absolute path.
No bundler package is installed by this script.

Reload `teams-personal` through OpenClaw's `plugins` tool with
`action: reloadAndResume`. Do not wait for a CLI reload while the active turn holds
the plugin lease. The deployment script updates the bridge, bundle and additive
channel-config schema; it does not write the host config or enable enrollment. Exact room
entries and the verified enrollment identity require owner authorization.

The host policy supplies `GROUP` (the original group's legacy cursor identity),
`GROUPS` (the exact approved group IDs) and optional `groupLabel(id)`. Without
`GROUPS`, the original single-group scope remains. Absent a configured `groups`
map, these IDs remain the compatibility default.
Once present, `channels.teams-personal.groups` is authoritative, including disabled
entries. The runtime wraps `groupAdmitted` and `targetAllowed` around that exact
map; no wildcard destinations are admitted. Each group
uses its own route, session, context window and outbound destination.

The old `watermark.json` is retained as a migration fence. The new endpoint and
repair checkpoints live separately in `realtime-state.json`; native ingress owns
durable turn deduplication. Group recent context is ephemeral (100 messages max;
50 entries / 20,000 text characters per turn). Edits refresh that context without
opening a new agent turn; they do not rewrite an already running turn.
Explicitly adding a group initializes only its activation fence and checkpoint.
Existing DM/group cursors and the endpoint identity are preserved. Pre-activation
history supplies context but cannot open a turn. Persisted checkpoints for
disabled/revoked groups are retained but never read as authorization. Malformed state scope still fails closed; do not delete state
or reset old cursors to bypass that check.

Acceptance after reload: verify runtime generation, authenticated registration,
a real scoped incoming event, native ingress/model turn, one platform reply and
reply readback. Test untagged context + mention, quoted reply, edit, and reconnect.
Ordinary unmentioned messages and edits must not cause an extra reply. The DM
sender guard and separate DM/group sessions must remain in force.

## Emoji reactions

Use `message(action: "emoji-list")` to discover the installed client's supported
glyphs and keys. In the approved Teams conversation, use
`message(action: "react", messageId: "<observed ID>", emoji: "👍")`.
Delegated actions require the exact current Teams conversation and account;
targeting Teams from a Telegram turn is rejected before adapter handoff. Start
the shared-tool acceptance with a real addressed request in that Teams group.
The same action with `remove: true` removes only that selected bot reaction.
An omitted ID may use the current inbound Teams message, never one from another
conversation/provider. Removal requires an explicit emoji; empty input does not
clear every reaction. Dry-run validates the request without account/network I/O.

Acceptance must establish one added bot reaction by platform readback, no duplicate
on a repeated request, and removal without changing another user's reaction.
Verify that reaction updates do not open a new model turn or produce a text reply.
The action reads before writing and verifies its own identity after writing;
`ok: false, verified: false` is not a delivery receipt. A lost mutation response
may be reconciled by readback, but must not trigger an automatic second write.
Account, destination and host handoff checks also run during token preparation.

This action capability does not enable new groups, background reactions, or
receipt-only acknowledgement of arbitrary unmentioned messages.

On session shutdown, late HTTP completion must not restore connected status,
schedule renewal or start recovery. Reconnect tests must use their own endpoint
and journal. Keep connection/repair success separate from actual missed-message
recovery: exit 2 with zero push events is incomplete, even if reconnect succeeded.
To exercise history deduplication without sending chat messages, reuse an isolated
journal whose activation fence includes existing authorized test messages; verify
that repair on the second connection adds no duplicate event keys. This does not
replace a real message sent during the gap or the native production queue check.

Rollback: run the bridge script with the same target and `--restore`, then reload
the plugin. Preserve both state files and the existing native queue. Do not
uninstall the old upstream client or delete credentials during migration.

## Owner native-tag enrollment

Deployment checkpoint (2026-11-16): generation 7 loaded at 18:46:03 Asia/Taipei;
the verified channel-local identity and two-room config were activated by native
deferred application at 18:50:37. Authentication/registration/recovery succeeded
and the channel reports ready with no error. Existing traffic was not replied to
again. The remaining acceptance below requires a genuinely unlisted group and a
real owner tag; do not reload or remove an approved room just to create a test.

The host provides the existing shared enrollment core through the deployment
bridge. Teams projects `enrollmentOwnerId` into that core's owner decision only;
it never writes global `commands.ownerAllowFrom` or grants management authority.
The configured ID must equal the host's explicitly verified approved sender; a
DM allowlist entry alone is not proof of ownership. Missing identity fails closed.

A qualifying event is a fresh `NewMessage` push in a group, authored by that exact
identity, containing the bot's native MRI mention metadata. Names/plain text,
join events, replies, commands, forwards, edits, deletion events and history repair
do not enroll. Existing/disabled rooms and a disabled channel/group policy are
not overwritten. Normal unmentioned events do no extra persistence or API calls.

The native config mutation persists exactly one room with `allowFrom: ['*']`,
`requireMention: true`, and its triggering `activationId`/`activatedAt`. Existing
rooms, DM policy, endpoint, watermarks and global owners remain unchanged. The
trigger fence is published with admission so a config-triggered restart can
recover the first tag, while native ingress owns durable deduplication. Text and
reaction sends, queued delivery and history acceptance recheck live room policy.

For live acceptance, invite the bot to a genuinely unlisted group, send ordinary
owner text (it must not enroll), then send an original native bot tag. Verify one
new exact config entry, one ingress/model/reply and no older replayed requests.
Have another member tag the bot to verify ordinary member access. Do not inject
synthetic production events or remove an existing room merely to manufacture a
test. A user-accepted emoji test does not establish this enrollment behavior.

## Typing indicator

For an addressed turn in an already approved Teams group or DM, watch for the
native typing indicator during reasoning/tool work and its disappearance after
completion, silence or cancellation (allow for Teams expiry). Untagged ambient
traffic must not start typing or a model turn. Confirm normal reply routing and
unchanged history; typing controls are ephemeral and excluded from durable ingress.
The adapter uses the host SDK lifecycle, a four-second refresh and ten-minute SDK
safety TTL. A queued follow-up retains its callbacks; abort/idle/error cleanup
cancels in-flight requests. Two consecutive typing API failures stop the SDK loop
without failing the text reply. Live account and destination checks run on every
refresh, including after async token preparation.

The DM convenience SDK does not expose typing; the DM now uses the same routed
dispatcher as groups, preserving its original envelope, private sender guard and
per-channel-peer session scope. `typingMode: instant` is applied only to the
current Teams turn config object, never persisted as a global preference.

2026-11-17 09:09 Asia/Taipei: a bounded direct-handler run in the existing approved
test group received HTTP 201 for the initial control and its four-second refresh.
Cleanup stopped the loop. Readback retained the same 11 text messages and three
bot replies; persisted config and legacy watermark digests were unchanged.
This is direct API/SDK evidence, not the production model lifecycle or the
requester's visible Teams UI. Those still require a fresh addressed Teams turn.
