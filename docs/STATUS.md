# Verification status

Evidence cutoff: 2026-11-17, 10:40 Asia/Taipei. These are observed checkpoints,
not a continuously refreshed health report. See [LIVE-TEST.md](LIVE-TEST.md) for
procedures and [README.md](../README.md) for current capabilities.

## Deployed implementation

| Item | Verified result |
| --- | --- |
| Implementation | `ea404a9` |
| Loaded | 2026-11-17 10:38:46 Asia/Taipei, generation 6, without a Gateway restart |
| Tool contract | `contracts.tools: ["teams_chat"]` accepted; scoped factory discovery passed without account I/O |
| Transport | Authenticated, registered and scoped recovery complete by 10:38:50 |
| Presence | Initial publication and the normal 60-second refresh succeeded |
| Native text | A fresh addressed request at 10:40 reached ingress/model and produced one reply verified by platform readback |
| Replay | Existing requests were not dispatched or replied to again |
| State | Account identity, room policy, endpoint, watermark and activation fences matched the private baseline |

Runtime source digest:
`bb9ab22e350fbac978f9509605f34e33e904c277ef6fddce6dd7f9cb4eaf938c`.
Bundle SHA-256:
`5a8f6239391d1b5c8cb49fab8e770eea1a9be353060e29fcd04359071ec82284`.
Host tool-capability acceptance metadata was the intentional configuration delta.

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
- Enrollment by a verified owner's native tag in a genuinely unlisted room,
  followed by another member's tag and one correctly routed reply.
- A real message sent during a controlled connection gap, recovered once with
  one reply; long-running token refresh across an actual expiry boundary.
- Client-side sending in the approved DM remains unresolved. API reply/readback
  alone does not establish bidirectional DM UI acceptance.

Direct API tests, offline checks and successful registration establish only their
respective paths. Pending items require real scoped Teams events or requester UI
observations. Preserve credentials and replay state during verification.
