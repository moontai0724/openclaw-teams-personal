# Live acceptance and recovery

The bot identity and approved DM remain unchanged. Groups are an exact allowlist;
a verified enrollment owner may authorize one additional group with an original
native tag. Account-wide push facts are checked before rejecting an unknown
group, but nonqualifying chats are dropped before caching or model dispatch.
No discovery history is fetched for unapproved rooms. Real captures stay out of Git.

## Receive-only CLI

Copy `config.example.json` into private, gitignored `local/scope.json`, fill the
exact test group and bot MRI, then validate it. Supply the absolute path to the
repository's `src/account.mjs` module; do not copy its store or pass a token as an argument.

```sh
node src/cli.ts check --config local/scope.json
node src/cli.ts listen --config local/scope.json \
  --auth-module /ABSOLUTE/PATH/TO/REPOSITORY/src/account.mjs \
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
the host SDK wiring and approved local policy; authentication, chat/file requests
and reaction keys are bundled from this repository. This is not yet a standalone npm-distributed plugin package.

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

## Native online presence

The production channel, not the CLI, publishes an independent presence endpoint
after authenticated messaging registration. Refresh runs every 60 seconds, with
owned-endpoint removal on disconnect/stop. It does not force account-wide status
or change manual overrides, calling endpoints, account/room scope or schedules.

The bounded 2026-11-17 09:32 Asia/Taipei manager/API check passed publish, refresh,
disconnect cleanup, reconnect and stop, with self-readback transitions Offline →
Available → Offline → Available → Offline. A 1.5-second test-only refresh shortened
that check. Config/watermark hashes and the 13-message/four-bot-reply test history
were unchanged. This isolated check does not establish the requester's UI.

Production checkpoint: generation 4 loaded at 09:35:24 Asia/Taipei without a
Gateway restart (`restartRequired: false`, source digest
`f5f73b4ded9e37cb0e16f145d3fd532b1b300f260cf21e6dfb6cd44a9d494a9f`).
Authentication/registration and initial presence publication succeeded at
09:35:26; scoped recovery completed by 09:35:28. The production 60-second refresh
succeeded at 09:36:26.733. At 09:36:57, self-readback returned HTTP 200/status
20000 and Available/Available. The channel is running/connected/ready with no
pending restart or last error. Artifact hashes match; config, manifest, legacy
watermark, messaging endpoint, bot identity and activation fences are unchanged.
Test-group history retains 13 messages/four bot replies and no reply after reload.
Deployment used a presence working tree based on `ede0ee1`; the matching source
and tests are included in this native-presence feature revision. Do not repeat
this successful reload.

For future replacements, verify successful authenticated registration and the
`Teams presence available` log, then read back only the bot's own presence and
observe a production activity refresh. Retain before/after message IDs and
config/watermark/activation fences; never reset state to test this feature. Ask
the requester to check the bot's native status dot. A successful API readback
does not prove the requester's UI refreshed. Manual status/other clients can
override the combined result. Abrupt process loss relies on native expiry, and
cleanup failures are reported rather than described as guaranteed offline.

Acceptance after reload: verify runtime generation, authenticated registration,
a real scoped incoming event, native ingress/model turn, one platform reply and
reply readback. Test untagged context + mention, quoted reply, edit, and reconnect.
Ordinary unmentioned messages and edits must not cause an extra reply. The DM
sender guard and separate DM/group sessions must remain in force.

## Emoji reactions

Use `message(action: "emoji-list")` to discover the independent client's supported
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

Rollback: deploy a reviewed independent source revision with the same bridge
script and reload only `teams-personal`. The former polling `--restore` path is
retired. Preserve credential data, watermark, transport state and native ingress;
never reset replay state or replay old approval/delivery records.

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
This establishes direct API/SDK acceptance, not the production model lifecycle
or the requester's visible Teams UI.

2026-11-17 09:12:42 Asia/Taipei: commit `03b7c4c` loaded without a Gateway restart,
using the existing bridge (runtime generation 3, `restartRequired: false`, source
digest `e98547b8a851b7fa90e11e17d0edb6e2b691ff03c31008f82a00ef4ab5a78a52`).
Authentication/registration completed by 09:12:44 and scoped recovery by 09:12:46.
Channel status reports running/connected/ready, no pending restart and no last
error. The retained-work warning required no second reload.
At 09:14:17, readback confirmed the same 11 messages / three original bot replies,
zero bot replies after reload, unchanged config/manifest/watermark and unchanged
endpoint, bot identity and activation fences. Deployed bundle and bridge hashes
match the handoff. No new text or typing control was sent by this readback.

Requester action still required: in an already approved Teams group, send a fresh
native bot tag asking for a reply that takes a few seconds. Observe whether the
native typing indicator appears while processing and disappears after completion
(allow for Teams expiry). Correlate that real turn with typing start/stop logs,
one normal reply and scoped platform readback. Do not fabricate an incoming event
or replay the earlier direct API probe to substitute for production acceptance.


## Independent client and original-file acceptance

Before replacement, run offline gates and a bounded direct client check in the
existing approved test room. Use only newly created bot messages for edit/delete.
Read back message IDs and download the sent original to compare bytes; an upload
receipt alone does not prove the delivered file. Keep captures in gitignored local/.
The 2026-11-17 direct run passed auth, history, send, edit, delete and byte-identical
file round-trip; both newly created test messages were removed.

Production checkpoint: `ea404a9` loaded as generation 6 at 10:38:46 Asia/Taipei,
without a Gateway restart. Manifest tool capability consent was accepted;
authentication/registration/presence and scoped recovery succeeded. The 10:40
fresh addressed turn produced exactly one native model reply with typing start/
stop, confirmed by platform readback. Existing requests were not replayed.
The vendor directory and polling backup are now in a private gitignored retirement
archive, not the active integration; credential and replay state remain in place.
67 host offline tests and syntax checks pass. These observations do not establish
native file return or `teams_chat` invocation by a real addressed turn.

For future replacement, verify current generation, selected entry, authentication,
registration and repair. Confirm the active bridge/bundle has no vendor imports.
Retire the old runtime directory only after those checks; preserve a private
rollback copy until native acceptance is complete. Send a fresh tag and original
file in an approved Teams room, then ask the agent to return that original file.
Check its actual downloaded bytes/filename, one model reply and correct destination.
Test native read/edit/delete, reaction and typing separately. Do not manufacture
an incoming user event or bypass the host's same-conversation action boundary.
The requester's UI and native-tool acceptance remain distinct from direct API tests.
