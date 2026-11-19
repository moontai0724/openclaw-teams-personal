# Verification status

Evidence checkpoints are dated below (Asia/Taipei).
These are observed checks and attributed reports, not a continuously refreshed
health report. See [LIVE-TEST.md](LIVE-TEST.md) for
procedures and [README.md](../README.md) for current capabilities.

## Source updates and activation status

### Outbound Markdown formatting (2026-11-19)

All 89 host-enabled tests and syntax checks passed. Offline checks cover
formatted text and captions, escaped HTML, HTTP(S) links, mentions outside
code, and preservation of quoted-reply and attachment metadata. A bridge built
in an isolated directory imported successfully with the installed OpenClaw SDK.
This update has not been deployed or verified in a Teams client.

### Native inline images

The source routes JPEG/PNG/GIF/WebP through `pish/image` uploads and AMSImage
HTML, with an optional caption in one message. Explicit document mode and other
media retain original File.1 transfer. Host media access checks and image metadata
validation precede upload; scope and cancellation are rechecked before writes.
Image-only/caption serialization, native upload routing, explicit originals,
lost-response reconciliation, invalid metadata/size, failed uploads and scope
revocation are covered by offline tests. All 86 host-enabled tests and syntax
checks passed. The requester reported a successful image test at 16:41
Asia/Taipei on 2026-11-17. This confirms the reported observation, not the
specific loaded generation or rendering across every Teams client.

The bridge and bundle were published to the selected integration on 2026-11-17
at 16:25 Asia/Taipei. The turn-releasing reload failed during drain: three retained
plugin work items did not settle within its 60-second budget, and replacement
was not committed. Reconciliation confirmed Gateway generation 2 and the Teams
channel ready/running/connected without an error. The selected bundle matches the
isolated build (`b0c039603fdead17d85d053596410f3563e18f4c11d7ef8b3cd6eb68eb325fc8`).
Account policy, watermark, endpoint and activation fences match the pre-reload
baseline. These are published-file checks, not evidence that images are loaded.
No Gateway restart, forced cleanup or unsolicited test send was performed.

### Additional DM allowlists

The source supports exact additional conversation/sender pairs in `dms`, with
per-chat routing/session isolation, activation fences and live revocation checks.
The deployment manifest includes the optional map and rejects wildcard peers.
The complete source passes 82 host-enabled offline tests and syntax checks.
Tests cover wrong-pair rejection, pre-activation history/push filtering, checkpoint
preservation, private quote isolation, queued-reply revocation and
unchanged global owner/group-enrollment authority.

This source update has not been deployed or activated. No new real DM entry or
notification was created. Native multi-DM acceptance requires a separately
approved deployment, admission and fresh real peer message; see
[LIVE-TEST.md](LIVE-TEST.md#private-chat-allowlist). The checkpoint below describes
the loaded implementation, not this source update.

### Owner one-turn access and explicit group management

Unlisted owner mentions admit only the exact current request/reply, without room
persistence or history recovery. Only the agent's explicit current-group tool can
persist an allowlist entry, with trusted owner/account/route and invocation checks
at discovery, asynchronous handoffs and locked-draft publication. Group policy is
read dynamically at queue, turn, typing, media and send time. Persisted new room
fences start at approval rather than replaying the triggering owner request.

All 82 host-enabled offline tests and syntax checks passed. Tests include ordinary
owner mention without config mutation, blocked member/untagged traffic, per-turn
reply/media/typing scope, owner revocation before delivery, management-tool
wrong-context/extra-argument rejection, draft revocation, delayed publication,
timeout, cancellation, idempotence and the real shared enrollment core. The
explicit management operation waits for published activation. These source changes are not yet loaded; fresh platform events remain required.

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
SDK case; standalone runs also skip the enrollment-core tool case unless their
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
- An ordinary owner native mention in a genuinely unlisted room: one reply and
  no allowlist write; another member stays blocked. Then an explicit owner
  enrollment request must invoke the management tool, publish one exact entry
  and permit a fresh member mention, including under unrelated active work.
- A real message sent during a controlled connection gap, recovered once with
  one reply; long-running token refresh across an actual expiry boundary.
- Client-side sending in the approved DM remains unresolved. API reply/readback
  alone does not establish bidirectional DM UI acceptance.

Direct API tests, offline checks and successful registration establish only their
respective paths. Pending items require real scoped Teams events or requester UI
observations. Preserve credentials and replay state during verification.
