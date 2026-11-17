# Protocol reference

The implementation follows the Teams Personal web protocol. Wire observations
were checked on 2026-11-16 and 2026-11-17. These internal endpoints may change;
[STATUS.md](STATUS.md) records the paths actually exercised.

## Transport and registration

1. Open the browser client's `/v4/c` WebSocket path. Receive Socket.IO 0.9 `1::`,
   then send `user.authenticate` with the Skype token in-band.
2. Wait for `trouter.connected`; use its authenticated `surl` and `ttl`. Validate
   redirected hosts before connecting.
3. Register one messaging worker endpoint with its own stable ID,
   `TeamsCDLWebWorker_2.7` and `productContext: TFL`, against the selected registrar.
4. Decode HTTP-like downstream requests carried in Socket.IO `3:::` frames.
   Match `/messaging`, normalize `NewMessage`, `MessageUpdate` and `MessageRemoved`,
   and acknowledge after filtered handling completes.
5. Renew before expiry. Reconnect on closure, auth expiry, heartbeat silence,
   redirect or `trouter.reconnect`. A `message_loss` signal starts bounded history
   repair.

The worker's `enableSkipCNSEndpointCreation` setting enables this direct
registration path. Notifications travel on the outbound WebSocket connection;
receipt needs no inbound HTTP listener.

### History recovery

Read admitted conversations through
`/api/chatsvc/consumer/v1/users/ME/conversations/{id}/messages`.
Use activation fences, overlap, pagination and durable event keys. Bound recovery
to five pages per chat and report unresolved gaps. History reads leave the read
horizon unchanged; explicit `mark-read` is a separate chat action.

## Authentication and messages

The account layer performs Microsoft consumer token refresh and Teams authz,
serializes refresh-token rotation and atomically writes the encrypted store.
Chat mutations use the consumer conversation API. An ambiguous send is reconciled
by its reserved `clientmessageid` before retrying. Edit/delete verifies bot
authorship and reads back the affected message. Reaction actions use the bot's
selected emoji key and verify its own resulting reaction.

## Original files

The web worker creates AMS objects with POST `v1/objects/`, a native object type,
filename and permissions for the exact conversation. Bytes upload with PUT
`v1/objects/{id}/content/original`. The channel uses `sharing/file` and a
`RichText/Media_GenericFile` File.1 URIObject with `amsreferences`.
Downloads use `/views/original`. Inline images use their ASM reference; OneDrive
references resolve via Graph. Graph credentials are not forwarded to a signed
download host. Unexpected hosts, redirects and scope changes are rejected.
Document-content conversion is outside transport.

## Typing controls

The worker's `sendTypingIndicator` resolver posts an empty `Application/Message`
body with message type `Control/Typing` through `postMessageToConversation`.
The channel sends this control to the conversation message endpoint and refreshes
every four seconds through the host SDK. Stopping ends refresh and lets the
control expire. Incoming typing/clear controls are filtered before durable
message-ID validation and excluded from history/model context.

## Presence

The worker's `publishEndpointPresence` sends PUT `v1/me/endpoints/`,
`postActiveEndpoint` sends POST `v1/me/reportmyactivity/`, and `deleteEndpoint`
sends DELETE `v1/me/endpoints/{id}`. The Teams Free regional base is
`https://teams.live.com/ups/global/`, authenticated with `X-Skypetoken` and
`X-MS-Client-Consumer-Type: teams4life`. Publication uses `deviceType: Web`,
`activityReporting: Direct` and Available/Available.

Messaging registration starts presence. Direct socket-disconnect notification
stops it before pending history/ingress work drains. A separate random presence
ID isolates cleanup from the messaging endpoint and other clients. Cleanup
rechecks token identity even when chat policy has been revoked.

Activity refresh runs every 60 seconds with bounded requests/backoff,
`retry-after` handling and recreation of missing endpoints. Auth refusal suspends
the presence run until a new connection. Graceful stop removes its endpoint,
including after cancellation or an ambiguous creation response. Abrupt process
loss relies on native expiry. Manual overrides and other clients can affect
combined status; presence errors are contained within this feature.

## Implementation references

- [Microsoft-hosted Trouter module](https://tflteams.public.onecdn.static.microsoft/teams-modular-packages/hashed-assets/cmd-trouter-14c2944133b694b2.js):
  `/v4/c`, token-type headers, connected-route registration and recovery state machine.
- [Microsoft-hosted CDL worker](https://teams.live.com/v2/worker/precompiled-shared-worker-f46f6510b75335ae.js):
  worker template 2.7, TFL context, message/file/typing/presence request constructors
  and endpoint-creation settings.
- [Teams web entry](https://teams.live.com/v2/): deployed client entry point.
