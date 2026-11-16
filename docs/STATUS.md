# Status

Stage: protocol framing and message normalization pass offline tests. No live
account operations have run. Transport and capture CLI are still in development.

Accepted scope: a separate private repository and staged commits/pushes for a
single-group, receive-only transport PoC. Group testing waits for the owner to
provide a dedicated group; existing production routing is not changed.

## Completion evidence

1. Offline protocol/validation/recovery tests pass.
2. A bounded live run reaches authenticated and registered state.
3. A new group message arrives as a Trouter event without periodic history reads.
4. Untagged text, native mention and reply metadata survive normalization.
5. A controlled reconnect recovers missed messages without duplicate delivery.

Items 2–5 require real Teams observations and are not proved by mocks.
