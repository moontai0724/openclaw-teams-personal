# Development

Use Node.js 24+, native ESM, erasable TypeScript and built-in APIs. Keep transport,
message validation and persistence separate. Propose dependencies before adding
them. The current checks run tests and syntax validation; they do not run a
TypeScript compiler.

```sh
npm test
npm run check
```

Inspect the full diff before committing one reviewable change with Conventional
Commits. Update usage, protocol and acceptance documents with the relevant change.
Keep documentation focused on current behavior, implementation rationale and
reproducible checks. Use synthetic identities in examples and fixtures; private
conversation references, account incidents and raw captures belong outside Git.
Record verification results in `docs/STATUS.md` and procedures in `docs/LIVE-TEST.md`.

## Test boundaries

Network/account operations must not run during imports or offline tests. Live
runs select an exact approved group and expected account, have a finite duration,
and write filtered events to gitignored `local/`. Keep credentials, real account/
message IDs and machine-specific paths out of commits. Preserve the live
connector's endpoint identity and replay state.

The deployment bridge injects the host's shared `enrollOwnerGroup` core.
Set `TEAMS_ENROLLMENT_CORE` to that module's absolute path when running `npm test`
to include the two host-core adapter/receiver integration cases. Without it those
two cases are explicitly skipped. The module is executable code; use a trusted file.

Set `TEAMS_TYPING_SDK` to the installed host SDK `channel-outbound.js` absolute
path to exercise typing keepalive/cleanup and the circuit breaker with mocked
timers. This case is explicitly skipped without the host SDK. Typing sender and
channel tests use built-in APIs and remain enabled.

## Deployment contract

The bridge bundles source into the host integration and declares `teams_chat` in
`contracts.tools`. Keep that declaration aligned with registered tool names so
the host can accept tool registration. Deployment targets, configuration changes
and plugin reloads require the operator's authorization. Follow
[deployment and recovery](docs/LIVE-TEST.md#channel-deployment) and verify live
acceptance separately from offline checks.
