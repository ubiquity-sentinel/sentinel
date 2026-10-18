# Model output retention

Generation 81 does not stop an implementation or native review session because
of cumulative streamed output. The existing 30-minute session deadline remains.
New implementation requests use `Number.MAX_SAFE_INTEGER` for the R80-compatible
`maxOutputChars` field. Historical R80 output-limit receipts retain their
original meaning. No state, plan, cell, receipt or host stdout schema changes
here.

The app-server transport incrementally parses each JSON frame. It validates
every byte of discarded output, including escapes, number grammar, separators
and container structure. UTF-8 decoding stays strict. It retains at most 64 Ki
characters of output strings across a frame; known output containers retain at
most 64 Ki raw characters each, then become `null`. Neither a truncated string
nor a discarded container is complete result evidence.

The closed output slots are relative to notification `params`:

- `delta` on item delta notifications;
- `item.text` on agent messages and plans;
- `item.aggregatedOutput` on commands;
- `item.summary` and `item.content` on reasoning or MCP output;
- `item.result`, `item.output` and `item.error.message` on MCP output, with
  `item.result` also supported for generated images;
- `item.changes[].diff` on file changes, retaining each path and kind exactly;
- `item.contentItems` on dynamic tool results;
- `item.revisedPrompt` on generated images;
- `item.review` on review-mode output;
- MCP progress `message`, notification `error.message`, and terminal
  `turn.error.message`.

Method and item type authorization is checked after parsing the entire frame, so
property order cannot change which slots may be projected. Tool arguments,
approvals, IDs, commands, paths, routing and terminal status are not output
slots. Their existing protocol integrity limits remain: 4 Mi retained control
characters and a 128-container nesting depth. Raw JSON escape characters and
primitive nodes count toward the retained bound; arrays of tiny values cannot
bypass it. Parser paths are a closed vocabulary, not repeated copies of
untrusted property names. Unknown notifications may discard oversized,
non-evidentiary `params` after fully validating them; known identity and
terminal methods cannot use that fallback.

Only the trusted transport creates `outputVolume` metadata. It carries the
original parameter character count and closed paths that lost output.
Producer-supplied metadata is ignored. This envelope is in-memory/private IPC,
not a new durable contract. Implementation accounting uses the original count;
truncated command output cannot create a repeated-failure digest, and truncated
items cannot certify complete output. Native review cannot accept a truncated
final result.

Notification and server-request consumers may be asynchronous. The transport
awaits them before reading more output. A full pre-consumer queue pauses reads,
without killing the child; stderr continuously drains into a bounded tail. The
implementation startup adapter installs its consumer before `turn/start`,
reserves terminal/routing evidence, and reports any bounded retention loss
through a trusted getter. Such loss makes the final result unavailable after
settlement; it does not interrupt the session or manufacture a terminal.
