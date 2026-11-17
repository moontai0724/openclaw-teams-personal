# Verification status

Runtime evidence cutoff: 2026-11-17, 12:42 Asia/Taipei. These are observed checkpoints,
not a continuously refreshed health report. See [LIVE-TEST.md](LIVE-TEST.md) for
procedures and [README.md](../README.md) for current capabilities.

## Source updates: not deployed

### Additional DM allowlists

The source supports exact additional conversation/sender pairs in `dms`, with
per-chat routing/session isolation, activation fences and live revocation checks.
The deployment manifest includes the optional map and rejects wildcard peers.
The complete source passes 78 host-enabled offline tests and syntax checks.
Tests cover wrong-pair rejection, pre-activation history/push filtering, checkpoint
preservation, private quote isolation, queued-reply revocation and
unchanged global owner/group-enrollment authority.

This source update has not been deployed or activated. No new real DM entry or
notification was created. Native multi-DM acceptance requires a separately
approved deployment, admission and fresh real peer message; see
[LIVE-TEST.md](LIVE-TEST.md#private-chat-allowlist). The checkpoint below describes
the loaded implementation, not this source update.

### First native-tag activation

Group policy changes use the host's published dynamic-read reload declaration.
Other channel changes retain a channel-scoped restart. The enrollment adapter
waits up to five seconds for the exact saved activation fence to appear in the
published runtime policy before admitting the first tag. Abort, owner revocation,
disabled rooms, superseded fences and publication timeout fail closed; saved
fences remain available for connection recovery.

An isolated run against the installed Gateway reload planner confirmed that
room-only changes request neither plugin replacement nor channel/Gateway restart.
Delayed immutable-snapshot tests admit the first owner tag and a member's tag
without reconnecting; old requests remain fenced. These source changes are not
loaded. Immediate first-tag acceptance still needs a fresh unlisted-room test
after an approved deployment.

## Deployed implementation

| Item | Verified result |
| --- | --- |
| Implementation | `ea404a9` |
| Loaded | 2026-11-17 12:40:31 Asia/Taipei, generation 7, without a Gateway restart |
| Tool contract | `contracts.tools: ["teams_chat"]` accepted; scoped factory discovery passed without account I/O |
| Transport | Authenticated and registered by 12:40:33; scoped recovery complete by 12:40:37 |
| Presence | Initial publication and the normal 60-second refresh succeeded |
| Native text | A fresh addressed request at 10:40 reached ingress/model and produced one reply verified by platform readback |
| Replay | Existing requests were not dispatched or replied to again |
| State | Existing account, endpoint and replay baselines were preserved; the newly enrolled room retained its exact activation fence |
| Group enrollment | A real owner tag persisted one room. After recovery, owner/member tags reached one model turn and one platform reply, confirmed by readback at 12:42 |

Runtime source digest:
`5bc9b483cca20c464d538c9f728c3f4f4c76702d2195513b6cdfbb0b30b99a97`.
Bundle SHA-256:
`5a8f6239391d1b5c8cb49fab8e770eea1a9be353060e29fcd04359071ec82284`.
The loaded files remain unchanged from the preceding implementation checkpoint.
Room admission was persisted by the verified owner tag; no additional DM entry
or peer notification was created.

## Offline and direct API checks

The deployment checkpoint passed all 67 offline tests, including host enrollment
and typing integrations, plus syntax checks. Portable runs skip the real-host
SDK case; standalone runs also skip the two enrollment-core cases unless their
host module is supplied. Test setup is described in [CONTRIBUTING.md](../CONTRIBUTING.md).

| Capability | Observed evidence |
| --- | --- |
| Account/client | Auth renewal, history and known-message reads passed in a bounded direct run |
| Text mutations | Newly created bot text was sent, edited, read back and deleted |
| Original files | Upload/download returned byte-identical contents; test messages were removed |
| Reactions | Direct add, unchanged repeat and selected-emoji removal passed bot-own readback |
| Typing | Initial and refreshed controls returned HTTP 201; start/stop surrounded the deployed 10:40 turn |
| Presence | Publish, activity refresh, disconnect/reconnect and stop passed API readback; production returned Available/Available |
| Group context | Real untagged text and edits updated context without extra turns; native quoted replies opened one turn |
| Recovery | Isolated reconnect/authentication/registration/repair completed without duplicate event keys; production reload preserved completed ingress and replies |

Original-file round-trip SHA-256:
`687864ca5430d464990bb47c878e405da1d1b4022aa9aaa38383a315021c70d3`.

## Pending live acceptance

- A fresh addressed Teams attachment request using `teams_chat`, followed by
  native original-file return and downloaded-byte/filename verification.
- Model-driven native read/edit/delete tool use in the trusted Teams chat.
- Requester-observed typing during processing and expiry after completion,
  and visibility of the native presence dot.
- Immediate first-tag activation in a genuinely unlisted room with the source
  fix loaded, including while an unrelated long agent turn is active. Recovery
  of the original owner/member tags and one routed reply has been verified.
- A real message sent during a controlled connection gap, recovered once with
  one reply; long-running token refresh across an actual expiry boundary.
- Client-side sending in the approved DM remains unresolved. API reply/readback
  alone does not establish bidirectional DM UI acceptance.

Direct API tests, offline checks and successful registration establish only their
respective paths. Pending items require real scoped Teams events or requester UI
observations. Preserve credentials and replay state during verification.
