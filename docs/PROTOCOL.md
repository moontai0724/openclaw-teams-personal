# Transport map and evidence

Observed 2026-11-16. Public deployed code was read as data. Subsequent bounded
account runs and the Gateway channel authenticated and registered successfully;
new-group text/update events and agent replies have also been observed. See
[status](STATUS.md) for acceptance evidence and remaining live tests.

## Selected wire path

1. Open the browser client's `/v4/c` WebSocket path. Receive Socket.IO 0.9
   `1::`, then send `user.authenticate` with the existing Skype token in-band.
2. Wait for `trouter.connected`; use its authenticated `surl` and `ttl` rather
   than assuming a stale allocation route. A redirected host must be validated.
3. Register one messaging worker endpoint, with its own stable PoC endpoint ID,
   `TeamsCDLWebWorker_2.7` and `productContext: TFL`. Register against the selected
   known registrar. This message-receive path does not register calling/presence
   apps. The production channel's separate presence endpoint is described below;
   the validation CLI remains receive-only.
4. Decode HTTP-like downstream requests carried in Socket.IO `3:::` frames.
   Match `/messaging`, then normalize `NewMessage`, `MessageUpdate` and
   `MessageRemoved`. Acknowledge after the filtered event is durably captured.
5. Renew before expiry; reconnect on socket closure, auth expiry, heartbeat
   silence, server redirect or `trouter.reconnect`. Treat `message_loss` as a
   reason for bounded history repair, not proof that re-registering restores data.

The deployed worker contains ChatService endpoint creation and `TrouterPush`
subscriptions, but its shipped default `enableSkipCNSEndpointCreation` is true.
This PoC therefore does not blindly create legacy ChatService endpoints or try
several write variants. If no message arrives after registration succeeds, inspect
the test account's actual route/settings before adding another registration step.

The receive loop is not a public HTTP webhook. Registrar routes notifications to
the existing outbound connection. No inbound port or Gateway plugin is required.

## History repair

Read only the explicitly selected group through
`/api/chatsvc/consumer/v1/users/ME/conversations/{id}/messages`.
Use a session start fence, overlap, pagination and durable event keys. Bound the
pages; report an incomplete gap instead of claiming losslessness. Never mark read.

## Sources and disagreements

- [Deployed Trouter module](https://tflteams.public.onecdn.static.microsoft/teams-modular-packages/hashed-assets/cmd-trouter-14c2944133b694b2.js):
  `/v4/c`, token-type headers, connected-route registration and recovery FSM.
- [Deployed CDL Worker](https://teams.live.com/v2/worker/precompiled-shared-worker-f46f6510b75335ae.js):
  worker template 2.7, TFL context, ChatService subscriptions and endpoint-skip flag.
- [purple-teams](https://github.com/EionRobb/purple-teams/blob/76d8b3a58886954feaec7c456750abd146121dd3/teams_trouter.c):
  older allocation/Socket.IO handshake; template and token choices are not copied.
- [teams-api](https://github.com/roshank8s/teams-api/blob/82535ed56c54282520eb09e06d22f55bfee1690e/teams_internal_api.py):
  corroborates direct v4c and connected-route registration, but uses different
  templates and multiple fallback registrations. Those are not combined here.
- [agent-messenger](https://github.com/agent-messenger/agent-messenger/blob/abc81f9873da06ab13503e5124c68fde036c0e9b/src/platforms/teams/trouter.ts):
  corroborates frame/ACK/encoding formats, but uses the legacy handshake and
  desktop ID-token flow. A successful unit test is not a live protocol claim.

This is independently written protocol code. Third-party sources are references,
not copied implementations; no third-party packages or GPL code are vendored.

## Channel typing controls

The deployed Teams Free worker
[`sendTypingIndicator` resolver](https://teams.live.com/v2/worker/precompiled-shared-worker-f46f6510b75335ae.js)
posts an empty `Application/Message` body with message type `Control/Typing`
through `postMessageToConversation`. The channel uses this exact control on the
existing conversation message endpoint; it does not send a text placeholder or
change presence. Refresh runs every four seconds through the host SDK. Stopping
means ending refresh and letting the transient control expire; no unverified
clear-typing write is introduced. Incoming typing/clear controls are filtered
before durable message ID validation and never enter history/model context.
The receive-only CLI remains receive-only.

## Channel presence (2026-11-17)

The same deployed worker constructs `publishEndpointPresence` as PUT
`v1/me/endpoints/`, `postActiveEndpoint` as POST `v1/me/reportmyactivity/`, and
`deleteEndpoint` as DELETE `v1/me/endpoints/{id}`. Its Teams Free default regional
base is `https://teams.live.com/ups/global/`; the installed Skype token authenticates
it with `X-Skypetoken` and `X-MS-Client-Consumer-Type: teams4life`. The channel
uses `deviceType: Web`, `activityReporting: Direct`, and Available/Available.
It never calls the account-wide `forceavailability` endpoint or subscribes to
other people's presence. Requests forbid redirects and verify live account policy
and token identity. Cleanup may remove its own endpoint after policy revocation,
but still verifies token identity. The random presence ID never replaces the
existing messaging endpoint, state or chat activation fences.

Transport registration starts presence; direct socket-disconnect notification
stops it before pending history/ingress work drains. A 60-second activity refresh
has bounded requests/backoff, honors retry-after and recreates a missing endpoint.
Auth refusal suspends this run until a new connection; errors do not kill chat.
Graceful stop removes the owned endpoint even after cancellation or an ambiguous
create response. A hard process kill relies on native expiry. Neither manual
overrides nor other logged-in clients are modified, so combined user presence
may differ from this endpoint's state.

Bounded live API readback established Offline → Available → Offline, including
activity refresh and a second publish/remove cycle. This is platform API evidence,
not requester-observed UI evidence. Microsoft's Graph `setPresence` explicitly
[does not support personal delegated accounts](https://learn.microsoft.com/en-us/graph/api/presence-setpresence?view=graph-rest-1.0);
the existing personal-account web protocol avoids adding Graph permissions/login.

## Independent account and original-file requests (2026-11-17)

The account layer performs Microsoft consumer refresh and Teams authz directly,
serializing refresh-token rotation and preserving the existing encrypted data
format. Chat mutations use the consumer conversation API; an ambiguous send is
reconciled by the reserved clientmessageid rather than resent. Edit/delete first
verify authorship and then read back the exact affected message.

The current Teams web worker constructs AMS object creation at POST v1/objects/
with a native object type, filename and permissions for the exact conversation,
then uploads bytes at PUT v1/objects/{id}/content/original. The channel uses
sharing/file and a RichText/Media_GenericFile File.1 URIObject with amsreferences.
Downloads use /views/original. Existing inline images use their ASM reference;
OneDrive references resolve via Graph and download without forwarding Graph
credentials to the signed download host. Redirects and unexpected hosts/scopes
are refused. No document-content conversion is part of transport.

Wire evidence: the deployed [Teams web entry](https://teams.live.com/v2/) and its
Microsoft-hosted worker request constructors, checked on 2026-11-17. Authenticated
client checks proved text send/edit/delete and a byte-identical original-file
round-trip in the already approved test room. Native agent-tool use still needs
post-replacement observation.
