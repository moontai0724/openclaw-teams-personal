# Teams Personal receive-only PoC

Independent transport experiment for a future OpenClaw channel plugin.
This repository is not loaded by Gateway and does not change the live connector.

## Stage-one boundary

- One explicitly selected group, text messages only.
- Trouter connection, authentication, notification registration and recovery.
- Preserve message identity, author, time, native mentions and reply metadata.
- No model invocation, sending, marking read, presence publication or group management.
- No new login or credential store. An explicit external auth-provider module supplies
  the existing bot account's short-lived token in memory.

## Runtime

Node.js 24 or newer. No dependency installation or build is required; Node executes
erasable TypeScript directly. This stage has runtime tests and syntax checks, not a
TypeScript compiler gate. The compiler/tooling choice is deferred to plugin packaging.

```sh
node --version
npm test
npm run check
```

Live account validation is pending a dedicated test group. Synthetic fixtures and
local tests never establish successful Teams registration or message delivery.
