# Development

Use Node.js 24+, native ESM, erasable TypeScript and built-in APIs. Keep transport,
message validation and persistence separate. No external runtime/dev dependencies
are currently required. Propose dependencies before adding them.

Run `npm test` and `npm run check` before each meaningful commit. Inspect the full
diff, commit one reviewable change with Conventional Commits, then push to the
private remote. Do not commit tokens, auth caches, real message captures or machine-
specific paths; local configuration and captures belong in gitignored `local/`.

Network/account operations must never run during imports or tests. Live runs must
select an exact group and expected account, have a finite duration, and write only
filtered events to a private local file. Do not use the live connector's endpoint
identity or reset its watermark. Gateway deployment uses the explicit bridge and
must follow the authorized replacement scope and rollback procedure.

The deployment bridge injects the host's existing shared `enrollOwnerGroup` core.
Set `TEAMS_ENROLLMENT_CORE` to that module's absolute path when running `npm test`
to include the two host-core adapter/receiver integration cases. Without it those
two cases are explicitly skipped; no substitute enrollment core is bundled.
The module is read as code, not a credential source. Never point it at an untrusted file.

Set `TEAMS_TYPING_SDK` to the installed host SDK `channel-outbound.js` absolute
path to exercise the real typing keepalive/cleanup and circuit breaker with mocked
timers. This integration case is explicitly skipped without the host SDK; no SDK
package is installed. Typing sender/channel tests remain dependency-free.

The deployment script declares `teams_chat` in the host manifest `contracts.tools`.
Keep that declaration aligned with registered tool names; otherwise the host
rejects tool registration even while the channel connects successfully.
