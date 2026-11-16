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
identity or watermark. Do not load this experiment in Gateway.
