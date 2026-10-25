# dsh-reliability-guards

Guardrails for small local models in [DeepSeek Harness](https://github.com/deepseek-ai) (DSH).
Small models (7-35B on Ollama or similar) tend to claim success after a failed command, say they
checked something without calling a tool, invent DOIs, or cut an answer in the middle. This plugin
catches those cases **before the user reads the answer** and lets the model correct itself.

> **Maintenance:** best-effort. Issues may go unanswered; forks are welcome.

## What it does

When the turn is about to close, plain deterministic rules compare the final answer with what the
tools really returned. On a finding the model receives **one** steering notice in the same turn
(at most 2 per turn, one per code) and rewrites its answer. What is still wrong at the end stays
visible under the answer.

| Code | Detected when |
|---|---|
| `falseSuccess` | the answer claims success, but a tool call failed (error, or shell `[exit code: N]`) and was never made up for |
| `actionWithoutTool` | "I checked / I ran ..." with zero tool calls in the turn |
| `announcedOnly` | an action is announced ("let me check:") and nothing is called |
| `deniedCapability` | "I can't access ..." while a fitting tool is in the request |
| `unverifiedDoi` | a DOI in the answer appears in no tool result; the harness checks OpenAlex then Crossref and only an unknown DOI triggers the notice (a network error never counts as invented) |
| `foreignScript` | CJK characters the user did not write |
| `markupLeak` | a tool call written as text (`<tool_call>`, `<function=...>`, `</think>`) |
| `cutAnswer` | the answer ends mid-sentence or with an unclosed code block |
| `emoji` (off by default) | emojis the user did not write |
| `frenchSpelling` (off by default) | misspelled words, checked offline with `enchant-2` |

Rules are bilingual (English and French phrasing).

**Before a tool runs**
- Approval card for destructive shell commands (`rm`, `mv`, `git reset --hard`, `git push --force`,
  `dd`, `>` onto an existing file, `cp` onto an existing file, ...) and for `write` over an existing
  file. Creating new files never asks.
- Backups into `/tmp` are refused with the reason (the folder is emptied between commands).
- `/explain` read-only mode: only an allow-list of tools (reads, searches, proposals) runs;
  everything else is refused, including tools added later. Type `/explain off` to leave it.
  Install the skill: `cp -r skills/explain ~/.dsh/skills/` (or into your `$DSH_HOME/skills`).

**Skills survive summaries**: when an automatic summary hides the instructions of a skill the user
invoked (`/word`, ...), they are re-sent.

The Web UI shows, under each turn with a finding, what was seen and whether the model corrected it.
English and French UI.

## Install

```sh
dsh plugin --profile web add dsh-reliability-guards
# or straight from GitHub:
dsh plugin --profile web add github:MathieuPortmann/dsh-reliability-guards
```

Restart the profile afterwards. Requires Node >= 22.6 and DSH 0.2.x.

## Configuration

Row `reliability-guards` in your profile's `cordis.patch.yml`. Every guard has an on/off switch:
`falseSuccess`, `actionWithoutTool`, `announcedOnly`, `deniedCapability`, `unverifiedDoi`,
`cutAnswer`, `foreignScript`, `emoji`, `frenchSpelling`, `destructiveAsk`, `tmpBackupDeny`,
`explainMode`, `keepInvokedSkills`.

| Key | Default | Meaning |
|---|---|---|
| `maxNudgesPerTurn` | 2 | steering notices per turn |
| `doiTimeoutMs` | 15000 | timeout of each DOI existence check |
| `spellAllow` | `[]` | extra words the spell check accepts |
| `explainAllow` | `[]` | extra tools allowed in `/explain` |
| `llmBodyTimeoutMinutes` | 0 | raise the HTTP body timeout for slow local models (0 = Node default, 5 min) |

## Permissions and external services

- No shell, no file writes.
- Network: only DOI existence checks against `api.openalex.org` and `api.crossref.org`, and only when
  an answer contains a DOI that no tool returned.
- `frenchSpelling` runs the local `enchant-2` program (package `enchant-2` plus `hunspell-fr`); if it
  is missing the check is skipped.
- `llmBodyTimeoutMinutes` replaces the process-wide HTTP dispatcher while the plugin is loaded.

## Develop

```sh
npm test
```

See [SPEC.md](SPEC.md) for the rules.

## License

MIT
