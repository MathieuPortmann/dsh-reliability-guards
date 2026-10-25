# dsh-reliability-guards — specification

Guardrails for small local models. Pure deterministic rules (no model judge) run when a turn is
about to close, on the session projection, so the same verdict is reached live and on replay.

## What it does
| Code | Failure (note 01) | Detected when (lib/rules.js `detect`) | Reaction |
|---|---|---|---|
| falseSuccess | C1 | final answer claims success; a failed tool call (isError, or bash `[exit code: N≠0]`) was never made up for by a later successful step; the answer does not admit the failure | 1 steering nudge in the same turn, then warning under the answer |
| actionWithoutTool | C3 | "j'ai vérifié / I ran …" with zero tool calls in the turn | same |
| deniedCapability | C2 | "je n'ai pas accès / I can't …" with zero calls while a fitting tool is in the request | same |
| unverifiedDoi | B3 | DOI in the answer found in no tool result and no user message | harness checks OpenAlex then Crossref; nudge only for NOT FOUND; otherwise warning |
| foreignScript | E5 | CJK characters the user did not write | nudge |
| markupLeak | D3/E4 | `<tool_call>`, `<function=…>`, `</think>`, ```` ```shell mcp__… ```` in the answer | nudge (call the tool for real or rewrite) |
| cutAnswer | E1/D4 | ≥200 chars ending on ':' ',' a word, or an unclosed code block | nudge (do the announced action, or continue) |

- At most `maxNudgesPerTurn` (2) nudges per turn, at most one per code; nudges are
  user-role notices with `source.kind = 'reliability-guard'` (durable, replayable).
- `turn/end` records per turn: `corrected` (nudged, gone), `warned` (nudged, still there),
  `detected` (not nudged: e.g. a real but unread DOI). The client shows them under the answer.

## Before a tool runs (`tools/pre-execute`)
- Approval card (`ask`) for destructive shell commands: rm/rmdir/shred/unlink, find -delete,
  mv, git reset --hard / clean -f / checkout -- / restore / push --force / branch -D / stash drop,
  dd/mkfs/truncate/wipefs, `>` onto an existing file, cp onto an existing file; and for `write`
  over an existing file. Creating new files never asks.
- Refused with the reason: backups into /tmp (bash cp/mv/tar/rsync/zip to /tmp with a backup word,
  or `write` of a backup file under /tmp).
- `/explain` (projection flag from the user's own messages; `/explain off` clears it): only the
  tools of the built-in allow list run (reads, searches, *_propose); every
  other tool is refused, including subagents, workflows, plans and tools added later.

## Skills the user invoked
`lib/kept-skills.js`: `dsh-tool-skill` injects a user-invoked skill once. An automatic summary then
hides that message, and since such skills refuse model invocation the `skill` tool cannot bring them
back. At `agent/pre-step` the instructions of the (at most 4) lost skills are re-sent; a failed
`skill` call for one of them returns the instructions instead of a refusal.

## Constraints
No shell, no file writes, no dependency. Network: only OpenAlex/Crossref DOI existence checks, and
only when an answer contains a DOI absent from every tool result. Every guard has a Config switch;
removing the bundle removes everything (Cordis effects).

## Tests
`npm test` (Node >= 22.6): the pure rules on synthetic events, the /explain allow-list, the
kept-skills logic and a load test with a fake context (skipped when the `dsh` CLI is not installed).
