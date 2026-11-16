# Status

Stage: channel replacement deployed and connected; real-message acceptance pending.

2026-11-16 15:41:48 Asia/Taipei: OpenClaw applied the `teams-personal`
replacement without a Gateway restart (runtime generation 3). The deployed source
is commit `7497e9b`; the previous polling entry remains available for rollback.
At 15:41:49-15:41:51 the new runtime authenticated, registered its route and
completed scoped history repair, including server-reported message-loss recovery.
The subsequent Gateway channel snapshot reports `running: true`,
`connected: true`, `lifecycle: ready`, and `lastError: null`.

No new scoped push event has been observed since replacement. Earlier inbound
timestamps in channel status belong to the former connector and are not proof
of new delivery. Real group message, mention/reply, edit and controlled-reconnect
acceptance remain open; do not claim model/reply end-to-end acceptance yet.

2026-11-16 15:25:46 Asia/Taipei: a bounded run with the existing bot account
completed WebSocket authentication, registrar acceptance and scoped history repair.
It ended after 45 seconds with zero push captures. This proves handshake and
registration, not incoming message delivery. No model turn was invoked by the CLI.

Accepted scope: independent private repository and staged commits/pushes. The owner
subsequently expanded the task to actual replacement and Gateway connection,
retaining the existing bot identity and approved group/DM scope. A deployment
bridge preserves the old entry for rollback. New groups are not auto-enrolled.

## Completion evidence

1. Confirmed: 24 offline protocol/validation/recovery/channel tests and syntax
   checks pass.
2. Confirmed: a bounded live run and the replacement Gateway runtime both reach
   authenticated and registered state.
3. Pending: a new group message arrives as a Trouter event without periodic
   history reads, enters native ingress when addressed, and receives one reply
   confirmed by platform readback.
4. Pending: untagged text, native mention and reply metadata survive normalization;
   an actual edit refreshes context without starting an extra turn.
5. Pending: a controlled reconnect recovers missed messages without duplicate
   delivery.

Items 3-5 require real Teams observations and are not proved by mocks. Next,
the owner sends/edits test text in the already approved Teams group, then mentions
the bot. After the owner reports that test here, inspect scoped runtime event IDs,
native ingress/session outcomes and platform reply readback. Do not expand chat
scope, send test messages on the owner's behalf, or reset replay state.
