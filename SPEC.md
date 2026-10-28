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

Answer checks (`lib/answer-checks.js` `checkAnswer`, `checkSources`), on the commands the answer gives:

| Code | Detected when | Reaction |
|---|---|---|
| codeWhileWaiting | the user asked to explain first / wait for their validation (French or English; the wait lasts until a go-ahead such as "je valide", "go ahead") and the answer has code blocks | nudge: words only |
| unknownCommand | a program starting a command of a shell block (or of an inline `` `cmd --option` ``) is not in the PATH folders, is not installed by the answer itself (apt, flatpak, pip…) and appears in no tool argument/result of the turn | nudge: check it or mark it "(untested)" |
| untestedCommand | only after a turn with tools: a name with `- _ . /` in a command (key, schema, path, option value) appears in no tool argument or full tool result of the conversation and is not an existing path; lines marked `# untested` / `# non testé` and install lines pass; the model's own writing (`*_propose`, `write`, `edit`, `step_done`…) is no evidence | nudge: check with a read-only command |
| shellMistake | `dconf read/write/reset` on a path ending with `/`, `dconf dump/list` on a path without it | nudge with the right form |
| sourcesDenied | the model read web pages (`web_read`, `web_search`, `web_fetch`) and the answer says it used no source, or has a "Sources" heading without any link | nudge with the URLs read |

- At most `maxNudgesPerTurn` (2) messages per turn for the rules, 2 more for the answer checks, at
  most one per code. All findings of one stop go back in ONE message (`groupedNudge`, summary
  `code1+code2 reliability check`), so the model rewrites its answer once. Messages are
  user-role notices with `source.kind = 'reliability-guard'` (durable, replayable).
- Before the answer (runtime context `reliability-guards:answer-rules`): the wait, the user's
  explicit demands (sentences with "check", "make sure", "only", "vérifie", "il faut"…), the
  Sources line when pages were read, dconf syntax when dconf is involved, and "names come from tool
  results". What can be said before costs no rewrite after.
- A failed shell call that only looks programs up (`which`, `type`, `command -v`, `compgen`…) is
  not a task step for `falseSuccess`.
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
No shell, no file writes, no dependency. File system: read-only looks (is a program in the PATH
folders, does a path named in an answer exist, would a write overwrite a file). Full tool results
are kept in memory only (last ~400k characters per conversation) for `untestedCommand`. Network: only OpenAlex/Crossref DOI existence checks, and
only when an answer contains a DOI absent from every tool result. Every guard has a Config switch;
removing the bundle removes everything (Cordis effects).

## Tests
`npm test` (Node >= 22.6): the pure rules on synthetic events, the answer checks, the /explain allow-list, the
kept-skills logic and a load test with a fake context (skipped when the `dsh` CLI is not installed).
