# Teams Personal channel for OpenClaw

A Teams Personal channel with realtime messaging, account authentication,
original-file transfer and current-chat tools. It connects to Teams over Trouter
WebSocket and uses the OpenClaw SDK for routing, media storage and durable ingress.

## Requirements

- Node.js 24 or newer, with native ESM and erasable TypeScript support.
- An OpenClaw host with the channel SDK, media services and shared group-enrollment core.
- An existing esbuild executable for deployment bundling.

The source uses built-in Node APIs and requires no npm dependency installation.
See [development](CONTRIBUTING.md) for checks and host integration tests, and
[deployment and acceptance](docs/LIVE-TEST.md) for host setup.

## Channel capabilities

| Area | Behavior |
| --- | --- |
| Account | Device-code sign-in, serialized token refresh and encrypted credential storage |
| Receive | Trouter events with bounded history recovery on connection or a reported gap |
| Context | Separate DM/group sessions, bounded recent history, native mentions and quoted replies |
| Messages | Send/reply, same-chat reads, explicit bot-owned edit/delete |
| Reactions | Emoji discovery, addition and selected-emoji removal with bot-own readback |
| Files | Original upload/download, including images, through host media storage |
| Typing | Native controls refreshed every four seconds during addressed turns |
| Presence | Available endpoint while connected, with a 60-second activity refresh |
| Group enrollment | A verified owner's fresh native bot mention can admit one exact new room |

Only authorized chats reach context and ingress. Group turns require a native
mention, a verified reply to the bot or a command. Untagged messages supply recent
context; edits update that context without starting another turn. Each chat has
its own route, session and reply destination. Group history is bounded to 100
cached messages and 50 entries / 20,000 text characters per prompted window.

Room policy uses an exact allowlist. Enrollment requires an explicitly verified
channel-local owner identity; it is disabled until configured. A qualifying tag
admits that room for all members with mention/reply gating. Disabled entries stay
disabled, and ordinary chat access grants no administrative authority.

## Private-chat allowlist

The host policy supplies the primary DM/sender pair. Additional one-to-one chats
are explicit entries in `channels.teams-personal.dms`, keyed by their exact
`19:uni01_…@thread.v2` conversation ID. Each entry has one `allowFrom` sender MRI,
an `activatedAt` Unix-millisecond timestamp, and optional `enabled` boolean.

Both conversation and sender must match. Each DM has isolated routing, session
history and reply destination. Activation fences prevent earlier messages from
opening turns. Revocation is checked during receipt, queued dispatch, typing,
media handling and reply delivery. DM permission grants neither global ownership
nor owner-tag group enrollment. See [configuration and acceptance](docs/LIVE-TEST.md#private-chat-allowlist).

## Account setup

Run account operations in a private operator terminal. Sign-in writes the encrypted
credential store only after checking the approved account identity. Keep device
codes, account IDs and tokens out of public output and Git.

```sh
node src/account-cli.mjs status
node src/account-cli.mjs login <approved-account-MRI>
```

Token refresh and encrypted storage are implemented in `src/account.mjs`.
The default store is `~/.teams-personal-mcp/tokens.enc` on Unix and
`%APPDATA%/teams-personal-mcp/tokens.enc` on Windows. Its encryption key depends on
the host name and OS user name; copying the file alone is not a portable login.

## Tools and original files

The host `message` tool supports send/read, explicit bot-owned edit/delete,
`react` and `emoji-list`. Message mutations require the trusted conversation and
account; unverified outcomes require readback before retrying.

`teams_chat` is available in the current trusted Teams conversation. Its actions
are `read`, `search`, `files`, `read-file` and `mark-read`. Search scans bounded
chat history. Reading leaves the read horizon unchanged; marking read is explicit.
Cross-chat search and account/group administration are outside this interface.

Incoming attachments enter host media storage after chat admission. Up to five
files are staged per turn; additional attachments can be downloaded explicitly
with `teams_chat`. Outbound originals use host media access checks and native
File.1 uploads, with a caption and file in the same message. Limits are 15 MiB per
original file and 5 MiB for inline image downloads. Audio/video travel as files.
The channel transfers bytes unchanged; document extraction, OCR and transcoding
belong to host content tools.

Typing stops refreshing on completion, silence, errors or cancellation, then
expires in Teams. Presence uses a separate random endpoint and removes that
endpoint on disconnect/stop. Manual availability and other clients can affect
combined status; abrupt process loss relies on native expiry. Typing/presence
errors are contained so messaging can continue.

## Receive-only validation CLI

The CLI tests transport for one explicitly selected group. It records text,
author/time, native mentions and reply metadata without invoking a model, sending
chat messages, marking read or publishing presence. It uses an auth-provider
module, such as `src/account.mjs`, to obtain short-lived credentials in memory.

For a credential-free synthetic replay:

```sh
node src/cli.ts replay --config test/fixtures/scope.json \
  --input test/fixtures/events.jsonl --journal local/synthetic.jsonl
```

For a bounded live run, see [CLI acceptance](docs/LIVE-TEST.md#receive-only-cli).
Protocol details are in [PROTOCOL.md](docs/PROTOCOL.md); observed results and open
acceptance items are in [STATUS.md](docs/STATUS.md).
