# Status

## Independent account, messages and original files (2026-11-17)

The channel now owns auth/token renewal, text/reply send, same-chat reads/search,
reactions, verified bot-only edit/delete and original-file upload/download. Native
`message` adds read/edit/delete and `teams_chat` exposes scoped history, search,
files, read-file and explicit mark-read. The original encrypted credential data,
approved identities, group map, transport endpoint and replay fences are retained.
No third-party source was copied into this implementation. No npm package was added.

All 66 offline tests pass, including the host enrollment/typing integrations;
syntax checks pass. A bounded real client run authenticated the approved account,
read test-group history and a known bot message, sent one test text, verified its
edit and deletion, uploaded an original text file, downloaded the identical bytes
and removed the test message. The round-trip SHA-256 is
`687864ca5430d464990bb47c878e405da1d1b4022aa9aaa38383a315021c70d3`.
These are client/API checks, not post-deployment native-tool/model acceptance.
Production replacement and old runtime removal are still pending.

## Native online presence (2026-11-17)

The owner requested the bot's online status in Telegram topic 189, message 318.
The channel now publishes a separate native Available endpoint only while the
authenticated message transport is connected. It refreshes activity every 60
seconds, aborts on socket loss/stop, and deletes only its own random endpoint.
Transport disconnect notification happens before pending recovery drains.
Live config/token identity guards, bounded requests, retry-after/backoff, expired
endpoint recreation and shutdown cleanup are covered by offline tests. No forced
availability, account/room policy, credential scope, dependency or cron is added.
The receive-only CLI remains unchanged.

At 09:32 Asia/Taipei, a bounded run of the actual presence manager/API proved
Offline → Available → Offline → Available → Offline, including a successful
activity refresh. Two PUTs returned 201, one POST and two DELETEs returned 200;
self-presence readbacks returned status 20000. This isolated test used a shortened
1.5-second refresh interval, not the production 60-second interval. The existing
test-group history stayed at 13 messages/four bot replies; persisted config and
legacy watermark hashes were unchanged. Private proof remains gitignored.

All 54 offline tests pass with the host enrollment/typing integrations enabled,
with no skipped cases, and syntax checks pass. The feature was deployed from a
working tree based on `ede0ee1`; its source, tests and acceptance records are
included in this native-presence feature revision. The deployed bundle SHA-256 is
`4f54123af3c9c6e3d08331bd125bdba3fc130cf9f2674d10d466148114402358`.

Generation 4 loaded at 09:35:24 Asia/Taipei without a Gateway restart. The reload
receipt reports `ok: true`, `restartRequired: false`, and source digest
`f5f73b4ded9e37cb0e16f145d3fd532b1b300f260cf21e6dfb6cd44a9d494a9f`.
The selected entry remains the existing deployment bridge. Authentication and
registration completed at 09:35:26; presence publication succeeded at 09:35:26.626
and scoped recovery completed by 09:35:28. The production 60-second activity
refresh succeeded at 09:36:26.733. Channel status is running/connected/ready,
with no pending restart or last error. Do not repeat the successful reload.

Self-readback at 09:36:57 returned HTTP 200, status 20000 and
Available/Available. The existing test-group history still has 13 messages/four
bot replies, with no bot reply after reload. Config, manifest, legacy watermark,
messaging endpoint, bot identity and activation fences are unchanged, and the
published artifacts match the handoff hashes. This establishes production
publication/refresh and API-visible availability, not a fresh post-reload model
turn or requester-observed green-dot visibility. That UI check remains pending.
Other clients/manual availability can affect combined presence; hard process
kills depend on Teams expiry instead of graceful endpoint removal.

## Typing indicator (2026-11-17)

The owner requested native typing during processing in Telegram topic 189, message
308. The channel now supplies host SDK typing callbacks to both group and direct
turns, with four-second refresh, bounded failure handling and abort/idle cleanup.
Incoming transient controls cannot enter context or durable ingress. DM routing
retains its private sender guard and original per-channel-peer scope. The instant
presentation mode is per-turn only; no persisted config or allowlist is changed.
All 47 offline tests pass with both host enrollment and typing integrations
enabled, along with syntax checks. At 09:09 Asia/Taipei a bounded direct-handler
run in the existing test group received two HTTP 201 controls (initial + refresh).
Text history remained at 11 messages / three bot replies; persisted config and
legacy watermark digests were unchanged.

Commit `03b7c4c` loaded at 09:12:42 Asia/Taipei without a Gateway restart. The
reload receipt reports `ok: true`, `restartRequired: false`, runtime generation 3
and source digest
`e98547b8a851b7fa90e11e17d0edb6e2b691ff03c31008f82a00ef4ab5a78a52`.
The selected entry remains the existing deployment bridge. Authentication and
registration completed by 09:12:44, followed by scoped recovery by 09:12:46.
Channel status is running/connected/ready with `restartPending: false` and
`lastError: null`. The retained-work warning resolved before successful replacement;
do not repeat the reload.

Readback at 09:14:17 confirms the same 11 test-group messages and three original
bot replies, with zero bot replies after reload. Config, manifest, legacy
watermark, endpoint, bot identity and activation fences match the pre-typing
snapshot; published bridge and bundle hashes match the deployment handoff.
This verifies loaded runtime health and existing-traffic recovery without duplicate
replies. Production model/UI typing acceptance still requires a fresh addressed
Teams turn and requester observation of the native indicator and its expiry.

## Previous deployed checkpoint

Stage: new-group text/context/native-quote acceptance and isolated reconnect
confirmed; registrar shutdown fix deployed, production repair/replay check passed.
Emoji reactions are accepted by the owner (Telegram topic 189, message 254).
Owner native-tag enrollment commit `e1e3337` is deployed and loaded. Generation 7
applied at 18:46:03 Asia/Taipei without a Gateway restart (source digest
`cb80d093ffc38fd0682be977aff055c254416afc6eb07d27340e22d2b915fb3e`).
Channel-local config activation was accepted at 18:50:37 after a deferred drain;
authentication, registration and scoped recovery completed by 18:50:40. The
subsequent channel snapshot is running/connected/ready, with no pending restart
or last error. No additional manual reload is needed.

The new adapter reuses the host shared core, adds exact dynamic room policy and
first-tag activation recovery, and does not grant global ownership. Forty tests
pass with the host core supplied, plus syntax checks. The separate existing
shared enrollment/LINE-history suite passes all 19 cases. Enrollment has not yet
been exercised by a real owner tag in an unlisted Teams group.

Post-activation checks at 18:52:50 confirm the two exact existing rooms, all-member
mention gating, original DM/account fields, endpoint/activation fences and legacy
watermark are preserved. An exact comparison with the pre-patch config backup
shows no changes outside the three authorized Teams fields. Platform readback
contains the same 11 test-group messages and three original bot replies, with
zero bot replies after config activation. This proves existing-traffic recovery
without duplicate replies, not new-room enrollment.

The owner supplied a screenshot during this task; its existing request/reply pair
matched the approved DM's platform readback, establishing the Teams identity for
this scoped enrollment role. Private message content and account IDs stay out of
this repository. The screenshot also led to a one-time DM repair: bot-side
relationshipState.inQuarantine was true despite earlier API replies. A direct
member-property write returned 200 but did not resolve the quarantine. Following
the shipped web client's one-to-one acceptance path, the owner was added to the
single TflContacts entry; readback then returned inQuarantine=false. This changed
no organization-wide policy. The requested single test DM was sent with a
platform receipt, but the owner reported that sending still failed. At the
owner's request the DM was then marked read; the exact read horizon was verified.
A legacy conversation-status write was rejected with HTTP 400 and made no change;
those empty fields are not proof of a fault in this modern thread. The owner
explicitly confirmed the Teams identity and deferred this still-unresolved
client-side sending issue. Do not describe the DM repair as end-to-end success.

2026-11-16 18:13:19 Asia/Taipei: runtime generation 6 loaded commit `d4bfd05`
without a Gateway restart. The selected deployment bridge is unchanged; the
reload receipt reports `ok: true`, `restartRequired: false`, and source digest
`88c9d9228863cfe057195504a6c66367f180486879edc8d28d1900be786c011b`.
Authentication and registration completed at 18:13:20, followed by scoped history
and message-loss repair by 18:13:22. Channel status reports running/connected,
`lifecycle: ready`, `restartPending: false`, and `lastError: null`.

Readback at 18:15:50 confirms nine scoped test-group messages, the same three
original bot replies and zero replies after reload. Endpoint, identity, approved
policy, activation baselines and the legacy watermark match the pre-reload
snapshot. The selected test message has no bot thumbs-up remaining from the
earlier add/remove test. The host rejected the shared `message react` call from
Telegram before adapter handoff because delegated actions require the exact
current Teams conversation/account. No reaction was sent by that call. Do not
bypass this boundary. At that checkpoint the shared-tool check was still pending;
the owner subsequently accepted reaction behavior in message 254.

2026-11-16 18:04:45-18:04:50 Asia/Taipei: a fresh native reply without any mention
arrived over the production Trouter connection and opened exactly one new group
turn. Platform readback confirms the native quote targets an existing bot message,
the incoming message has no mentions, and one new bot reply exists. The session
now contains three requests and three replies. This establishes both fresh
post-generation-5 receipt/model/reply and native quoted-reply triggering.

The owner next requested Teams emoji reactions in Telegram topic 189. The new
channel actions reuse the installed client's reaction API and emoji catalogue,
without changing approved chats or adding dependencies. They validate account,
destination and message ID, preserve host handoff checks through asynchronous
credential preparation, verify the bot credential on each client request, and
read back only the bot's own selected reaction. Unknown write outcomes are read
back without automatically repeating the mutation. Eight new offline tests pass
(35 total). At 18:11 Asia/Taipei, a bounded direct action run against the approved
test group's existing native reply verified a bot thumbs-up, a repeated request
with `changed: false`, and removal with readback. The original three-request/
three-reply session remained unchanged. These checks establish the real upstream
API and action handler, not yet deployed shared-tool execution. Private proof
stays in gitignored local files. Generation 6 deployment is confirmed above;
the owner subsequently confirmed reaction behavior in message 254.

2026-11-16 17:54:54 Asia/Taipei: runtime generation 5 loaded commit `ba379d4`
without a Gateway restart, using the same deployment bridge. Reload receipt:
`ok: true`, `restartRequired: false`, source digest
`d074c8ff1d512fafd0171e4b5f32c6b3e453c75637acf22c6fb38390a9d6d6ca`.
The account authenticated and registered at 17:54:55. Initial scoped repair and
server-reported message-loss repair completed by 17:54:57. The subsequent channel
snapshot reports `running: true`, `connected: true`, `lifecycle: ready`,
`restartPending: false`, and `lastError: null`.

Read-only checks after repair confirm that the endpoint, bot identity, approved
chat scope, activation baselines and policy digest match the pre-reload snapshot.
The new group's native ingress still has exactly the two original completed
request rows, with unchanged completion times and no pending/failed rows. Its
session still contains two requests and two replies. Platform readback at
17:56:58 confirms six scoped messages, including exactly the two original bot
replies and zero replies after reload. This establishes production repair of
existing test traffic without duplicate dispatch/reply. No new scoped push was
observed at that initial check; this does not establish recovery of a new message
sent during a connection gap. The 18:04 native reply above establishes the later
fresh post-reload model/reply turn.

2026-11-16 17:46-17:47 Asia/Taipei: the owner accepted the new group's current
behavior in Telegram topic 189, messages 226 and 228, and requested continuation.
Runtime logs show two ordinary messages, their update events, two addressed
requests and two bot replies. The native group session contains exactly those two
requests and replies; scoped platform readback confirms both bot reply IDs and the
updated versions of the ordinary messages. No extra turns were started for the
untagged messages or edits. The agent used the current edited content; the context
cache intentionally replaces earlier versions, so an edit-before/after audit trail
is not provided. Real message capture data is not committed.

The deployed reliability patch prevents a late successful registrar response from
reporting connected or scheduling renewal after the session has stopped. A new
test reproduces the race by aborting during response cleanup; it failed before
the fix. All 27 tests and syntax checks pass; generation 5 loaded this patch.

2026-11-16 17:50-17:52 Asia/Taipei: two bounded receive-only runs used fresh
isolated endpoints, without interrupting the production channel or invoking the
model. Both completed a forced disconnect, reauthenticated, registered again and
completed history repair. The second run included the new group's existing test
traffic: four unique non-bot message keys were recovered initially; repair after
reconnect added zero duplicate keys. Both runs ended cleanly at their deadline.
No new message arrived during either run (exit 2), so this establishes connection
recovery and isolated history deduplication, not missed-live-message recovery or
production queue deduplication.

2026-11-16: the owner authorized adding the newly joined test group in Telegram
topic 189, message 221. This is one explicit allowlist addition, not automatic
group enrollment. The channel now supports per-group routing, history and outbound
guards; state migration adds only the new activation fence while preserving the
existing DM/group cursors and endpoint.
At that stage, 26 offline tests and syntax checks passed, including two-group
ingress/reply isolation, legacy/existing-state migration, and rejection of
pre-activation turns.

2026-11-16 17:40:01 Asia/Taipei: runtime generation 4 applied commit `2ac642a`
without a Gateway restart. The selected entry remains the deployment bridge at
`/home/openclaw/.openclaw/workspace/integrations/teams-personal/plugin/index.mjs`;
the reload receipt reports source digest
`d3249e44b5dd3b0781f3a401d229e57e1c7ac3a89b83fedf696ed0710421e120`.
At 17:40:02 the runtime authenticated and registered; scoped history repair,
including server-reported message-loss recovery, completed by 17:40:04.
The channel snapshot confirms `running: true`, `connected: true`,
`lifecycle: ready`, `restartPending: false`, and `lastError: null`.
The deployed policy contains both approved groups, and persisted realtime state
contains the existing DM/group plus the new group's activation fence and repair
checkpoint. No new scoped push had been observed at that initial check; the
17:43-17:45 events and subsequent acceptance above establish later receipt.

2026-11-16 15:41:48 Asia/Taipei: OpenClaw applied the `teams-personal`
replacement without a Gateway restart (runtime generation 3). The deployed source
is commit `7497e9b`; the previous polling entry remains available for rollback.
At 15:41:49-15:41:51 the new runtime authenticated, registered its route and
completed scoped history repair, including server-reported message-loss recovery.
The subsequent Gateway channel snapshot reports `running: true`,
`connected: true`, `lifecycle: ready`, and `lastError: null`.

No scoped group push had been observed at the initial deployment check. This
historical snapshot does not establish the current live acceptance result.
The later new-group acceptance above establishes text/context/model/reply behavior,
and native quoted-reply triggering passed at 18:04. Missed-message recovery still
needs a real new message during a connection gap.

2026-11-16 15:25:46 Asia/Taipei: a bounded run with the existing bot account
completed WebSocket authentication, registrar acceptance and scoped history repair.
It ended after 45 seconds with zero push captures. This proves handshake and
registration, not incoming message delivery. No model turn was invoked by the CLI.

Accepted scope: independent private repository and staged commits/pushes. The owner
subsequently expanded the task to actual replacement and Gateway connection,
retaining the existing bot identity and approved group/DM scope. The subsequent
message 221 explicitly adds one new test group while retaining prior access. A
deployment bridge preserves the old entry for rollback. Owner-tag enrollment
was subsequently authorized in message 254; its current status is recorded above.

## Completion evidence

1. Confirmed: 66 offline protocol/validation/recovery/channel/action/account/client/media tests and syntax
   checks pass.
2. Confirmed: a bounded live run and the replacement Gateway runtime both reach
   authenticated and registered state.
3. Confirmed: two new-group requests arrive as Trouter events, enter native
   ingress and each receive one reply confirmed by scoped platform readback.
4. Confirmed: actual edits refresh the current context without an extra turn.
   Native quoted-reply triggering also passed at 18:04;
   retaining superseded text is not part of the current implementation.
5. Confirmed: isolated real reconnect/authentication/registration/repair and four
   historical event keys without duplication. Production reload repair also
   preserves the two completed native request rows and two original platform
   replies without duplicate dispatch/reply. Pending: a real new message sent
   during a connection gap and its single recovered reply.
6. Confirmed: the registrar shutdown race regression passes and the fix is loaded
   in production generation 5. Fresh post-reload incoming/model/reply and native
   quoted-reply triggering passed at 18:04. Long-running token refresh remains
   a separate live acceptance item.
7. Confirmed in a direct handler run: real emoji reaction addition, idempotent
   repeated request and selected-emoji removal, each checked by readback.
   Generation 6 is loaded and connected. The owner accepted reaction behavior
   in Telegram message 254; no separate additional tool-log audit was performed.

Live acceptance requires real Teams observations and is not proved by mocks.
Typing UI acceptance requires a fresh native tag in an already approved Teams
group and requester observation during processing and after completion. Owner-tag
enrollment separately requires a genuinely unlisted group, followed by another
member's tag. See the exact procedures in LIVE-TEST.md.
A controlled missed-message test still needs a coordinated real message during
the reported connection gap.
A run without a real message during its gap cannot prove recovery of missed
traffic. Do not expand chat scope, send test messages on the owner's behalf, or
reset replay state.


Deployment history: the initial setup attempt declined the old loaded schema
and wrote nothing. After generation 7 loaded the new schema, the authorized
three-field config patch was persisted. Its first application hit the 60-second
retained-work drain limit; native deferred application later succeeded at
18:50:37. The resulting role is channel-local only. User confirmation of identity
preceded activation; global owners, login, transport endpoint and replay state
were not changed.

## Original-file scope

Attachments are now transferred as original files; the channel does not parse
Office/PDF contents. Incoming references include OneDrive files, inline images
and ASM File.1 objects. Native media storage/read policies remain authoritative.
Uploads use the original view and do not optimize pictures. The direct API
round-trip passed byte comparison; a new real Teams attachment must still verify
native ingress/model handoff and same-conversation tool use after replacement.
Audio/video are supported only as original files, not specialized voice/video
messages. Account-wide search and group administration are not exposed.
