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
   known registrar. Do not register calling/presence apps or publish user activity.
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
