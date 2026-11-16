# Status

Stage: new-group text/context/native-quote acceptance and isolated reconnect
confirmed; registrar shutdown fix deployed, production repair/replay check passed.
Emoji-reaction actions implemented and tested, with live client add/remove proof;
deployment/shared-tool verification pending.

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
stays in gitignored local files. Runtime deployment/shared-tool proof is pending.

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
The later new-group acceptance above establishes text/context/model/reply behavior;
quoted-reply triggering and missed-message recovery need separate observations.

2026-11-16 15:25:46 Asia/Taipei: a bounded run with the existing bot account
completed WebSocket authentication, registrar acceptance and scoped history repair.
It ended after 45 seconds with zero push captures. This proves handshake and
registration, not incoming message delivery. No model turn was invoked by the CLI.

Accepted scope: independent private repository and staged commits/pushes. The owner
subsequently expanded the task to actual replacement and Gateway connection,
retaining the existing bot identity and approved group/DM scope. The subsequent
message 221 explicitly adds one new test group while retaining prior access. A
deployment bridge preserves the old entry for rollback. Groups are not auto-enrolled.

## Completion evidence

1. Confirmed: 27 offline protocol/validation/recovery/channel tests and syntax
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
   Pending: deployed shared-message-tool verification.

Live acceptance requires real Teams observations and is not proved by mocks.
For the next live check, deploy the reaction adapter and verify addition/removal
on one existing authorized test-group message, retaining the current replay state.
A controlled missed-message test still needs a coordinated real message during
the reported connection gap.
A run without a real message during its gap cannot prove recovery of missed
traffic. Do not expand chat scope, send test messages on the owner's behalf, or
reset replay state.
