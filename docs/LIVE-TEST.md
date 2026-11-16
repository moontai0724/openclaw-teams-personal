# Live acceptance and recovery

Only the existing bot identity and explicitly approved DM/groups are authorized.
Account-wide notifications may arrive at Trouter, but other chats must be dropped
before caching, persistence or model dispatch. Real captures stay out of Git.

## Receive-only CLI

Copy `config.example.json` into private, gitignored `local/scope.json`, fill the
exact test group and bot MRI, then validate it. Supply the absolute path to the
existing approved auth module; do not copy its store or pass a token as an argument.

```sh
node src/cli.ts check --config local/scope.json
node src/cli.ts listen --config local/scope.json \
  --auth-module /ABSOLUTE/PATH/TO/EXISTING/auth.js \
  --journal local/live.jsonl --duration 300
```

Logs contain stage names and selected message IDs, not raw frames or credentials.
The journal contains selected-group text and is mode 0600. Exit 0 requires a push
event; exit 2 means the bounded run ended without push proof. Exit 1 is a failure.
No chat messages are sent by this CLI. Registration and shutdown do not mark read.
The PoC registration expires at its bounded TTL after the connection closes.

Send ordinary text, a native bot mention, and a reply. Edit an earlier message.
Verify distinct message IDs, author/time, native mention MRI, reply target/preview,
and a new update version. Do not infer success from `registered` alone.

For a controlled gap, add `--drop-after 30 --reconnect-delay 10`, send text during
the reported gap, and confirm one repair event with no duplicate on reconnect.
Repeat across token refresh before claiming long-running token lifecycle coverage.

An uncleanly killed journal leaves a `.lock`; check its recorded PID and inspect
the capture before removing only the stale lock. A partial journal tail fails
closed and must be reconciled, not truncated blindly. Do not reset production
watermarks or the native ingress queue to resolve replay problems.

## Channel deployment bridge

The independent channel implementation lives in `plugin/`. The bridge retains
the installed SDK wiring, approved local policy and existing MIT upstream auth /
outbound client. This is not yet a standalone npm-distributed plugin package.

```sh
node scripts/deploy-bridge.mjs --target /ABSOLUTE/EXISTING/plugin/index.mjs --dry-run
node scripts/deploy-bridge.mjs --target /ABSOLUTE/EXISTING/plugin/index.mjs \
  --esbuild /ABSOLUTE/EXISTING/esbuild/bin/esbuild
```

The host's already installed esbuild bundles this repository into `realtime.mjs`
beside the bridge; runtime never imports a mutable checkout by absolute path.
No bundler package is installed by this script.

Reload `teams-personal` through OpenClaw's `plugins` tool with
`action: reloadAndResume`. Do not wait for a CLI reload while the active turn holds
the plugin lease. The deployment script does not change channel ID, host allowlist
or global config. Any host allowlist change requires separate owner authorization.

The host policy supplies `GROUP` (the original group's legacy cursor identity),
`GROUPS` (the exact approved group IDs) and optional `groupLabel(id)`. Without
`GROUPS`, the original single-group scope remains. Keep `groupAdmitted` and
`targetAllowed` restricted to that same list; do not use a wildcard. Each group
uses its own route, session, context window and outbound destination.

The old `watermark.json` is retained as a migration fence. The new endpoint and
repair checkpoints live separately in `realtime-state.json`; native ingress owns
durable turn deduplication. Group recent context is ephemeral (100 messages max;
50 entries / 20,000 text characters per turn). Edits refresh that context without
opening a new agent turn; they do not rewrite an already running turn.
Explicitly adding a group initializes only its activation fence and checkpoint.
Existing DM/group cursors and the endpoint identity are preserved. Pre-activation
history supplies context but cannot open a turn. Unexpected persisted chat scope
fails closed; do not delete state or reset old cursors to bypass that check.

Acceptance after reload: verify runtime generation, authenticated registration,
a real scoped incoming event, native ingress/model turn, one platform reply and
reply readback. Test untagged context + mention, quoted reply, edit, and reconnect.
Ordinary unmentioned messages and edits must not cause an extra reply. The DM
sender guard and separate DM/group sessions must remain in force.

## Emoji reactions

Use `message(action: "emoji-list")` to discover the installed client's supported
glyphs and keys. In the approved Teams conversation, use
`message(action: "react", messageId: "<observed ID>", emoji: "👍")`.
The same action with `remove: true` removes only that selected bot reaction.
An omitted ID may use the current inbound Teams message, never one from another
conversation/provider. Removal requires an explicit emoji; empty input does not
clear every reaction. Dry-run validates the request without account/network I/O.

Acceptance must establish one added bot reaction by platform readback, no duplicate
on a repeated request, and removal without changing another user's reaction.
Verify that reaction updates do not open a new model turn or produce a text reply.
The action reads before writing and verifies its own identity after writing;
`ok: false, verified: false` is not a delivery receipt. A lost mutation response
may be reconciled by readback, but must not trigger an automatic second write.
Account, destination and host handoff checks also run during token preparation.

This action capability does not enable new groups, background reactions, or
receipt-only acknowledgement of arbitrary unmentioned messages.

On session shutdown, late HTTP completion must not restore connected status,
schedule renewal or start recovery. Reconnect tests must use their own endpoint
and journal. Keep connection/repair success separate from actual missed-message
recovery: exit 2 with zero push events is incomplete, even if reconnect succeeded.
To exercise history deduplication without sending chat messages, reuse an isolated
journal whose activation fence includes existing authorized test messages; verify
that repair on the second connection adds no duplicate event keys. This does not
replace a real message sent during the gap or the native production queue check.

Rollback: run the bridge script with the same target and `--restore`, then reload
the plugin. Preserve both state files and the existing native queue. Do not
uninstall the old upstream client or delete credentials during migration.
