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
| Media | Inline JPEG/PNG/GIF/WebP images, original-file upload/download and explicit document mode through host media storage |
| Typing | Native controls refreshed every four seconds during addressed turns |
| Presence | Available endpoint while connected, with a 60-second activity refresh |
| Group access | Verified owner mentions allow one current request; explicit owner requests use a current-group allowlist tool |

Only authorized chats reach context and ingress. Group turns require a native
mention, a verified reply to the bot or a command. Untagged messages supply recent
context; edits update that context without starting another turn. Each chat has
its own route, session and reply destination. Group history is bounded to 100
cached messages and 50 entries / 20,000 text characters per prompted window.

Room policy uses an exact allowlist and an explicitly verified channel-local
`enrollmentOwnerId`. In an unlisted room, a fresh native mention by that owner
admits only the current request and its reply. It creates no room entry, history
cache or ongoing member access. Other senders and disabled rooms remain blocked.

Only when the owner explicitly asks to add the current group does the agent call
`teams_group_access(action: "allow-current-group")`. The tool rechecks trusted
sender/current-group context and live owner policy at the final write. It adds
that exact room with all-member access and mention gating, starting at approval
time. Other rooms, DMs and global owners are unchanged. Quoted/file content and
ordinary mentions are not instructions to enroll.

## Private-chat allowlist

The host policy supplies the primary DM/sender pair. Additional one-to-one chats
are explicit entries in `channels.teams-personal.dms`, keyed by their exact
`19:uni01_…@thread.v2` conversation ID. Each entry has one `allowFrom` sender MRI,
an `activatedAt` Unix-millisecond timestamp, and optional `enabled` boolean.

Both conversation and sender must match. Each DM has isolated routing, session
history and reply destination. Activation fences prevent earlier messages from
opening turns. Revocation is checked during receipt, queued dispatch, typing,
media handling and reply delivery. DM permission grants neither global ownership
nor group-management permission. See [configuration and acceptance](docs/LIVE-TEST.md#private-chat-allowlist).

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

`teams_chat` is available in the current trusted, allowlisted Teams conversation. Its actions
are `read`, `search`, `files`, `read-file` and `mark-read`. Search scans bounded
chat history. Reading leaves the read horizon unchanged; marking read is explicit.
Cross-chat search and account/group administration are outside this interface.

Incoming attachments enter host media storage after chat admission. Up to five
files are staged per turn; additional attachments can be downloaded explicitly
with `teams_chat`. Outbound media uses host access checks. JPEG, PNG, GIF and WebP
are sent as native inline images, alone or with a caption in the same message.
Use `message(action: "send", media: "…", asDocument: true)` to send an image as
an original File.1 attachment; `forceDocument: true` is equivalent. Other formats,
audio and video use file attachments. Limits are 15 MiB per original file and
5 MiB per inline image in either direction. The channel uploads bytes unchanged;
Teams may generate image display views. Document extraction, OCR and transcoding
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
