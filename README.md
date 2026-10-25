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

Restart the profile afterwards. Requires Node `^22.19.0 || >=24` and DSH `>=0.2.0-rc.2 <0.3.0` (see [Compatibility](#compatibility)).

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

## Compatibility

| Component | Supported |
|---|---|
| Node.js | `^22.19.0 \|\| >=24.0.0` (`engines.node`) |
| DSH | `>=0.2.0-rc.2 <0.3.0`; declared as `peerDependencies` on `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-skill`, the only DSH packages the plugin imports |
| Platform | Linux (tested); the plugin itself is pure JavaScript with no native addon |

Tested with DSH `0.2.0-rc.2` on Node 22.23 (see [Verification](#verification)).

## Permissions and external services

Everything the plugin can touch, and what happens when it fails:

| Capability | Where | Used for | If it fails |
|---|---|---|---|
| **Files (read only)** | `index.js` (`statSync`) | checks whether the target of `>` / `cp` / `mv` already exists, so only an overwrite asks for approval | treated as "does not exist": no approval card |
| **Files (write)** | none | the plugin writes nothing; its state lives in the DSH session log | n/a |
| **Network** | `lib/doi.js` (`fetch`) | existence check of a DOI that appears in an answer but in no tool result, against `api.openalex.org` then `api.crossref.org`; nothing else is sent | a network error or timeout (`doiTimeoutMs`) never counts as an invented DOI |
| **Commands** | `lib/spell.js` (`execFile`) | `enchant-2 -d <dict> -l` with the answer's words on stdin; only when the `frenchSpelling` guard is switched on (off by default); no shell is involved and the arguments are fixed | program or dictionary missing, timeout (5 s): the check is skipped |
| **Dynamic module loading** | `index.js` (`importFromDsh`) | loads `zod`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/schemastery`, `@deepseek-ai/dsh-skill` and, optionally, `undici` from the DSH installation that is running the plugin (a synchronous `require` of an ES module fails on Node 22). Nothing is downloaded and no code is evaluated from text (`eval` / `new Function` are not used) | `undici` is optional; the others are required and the plugin fails to load without them |
| **Process-wide HTTP dispatcher** | `index.js` | only when `llmBodyTimeoutMinutes > 0` (default 0 = untouched): raises the body timeout of the global `fetch` for slow local models | n/a (opt-in) |

The plugin also *blocks* actions: it asks for approval before destructive shell commands, refuses
backups into `/tmp`, and in `/explain` mode refuses every tool outside an allow-list. It adds no
tool of its own and runs no command on behalf of the model.

## Verification

Checked on a disposable profile (`DSH_HOME` pointing at a temporary folder, profile cloned with
`dsh <name> --from-default-profile web`, so the real profile is never touched):

```sh
npm pack
dsh plugin --profile t add file:$PWD/dsh-reliability-guards-0.1.0.tgz   # install
dsh --profile t --no-open --port 3095                                    # start: plugin loads, no error
dsh plugin --profile t remove dsh-reliability-guards                      # uninstall
```

`npm test` runs 33 standalone tests (rules, patterns, DOI extraction, spell check parsing, kept
skills, load test of the real module) with no DSH installation needed except the load test, which
skips when DSH is absent.

## Develop

```sh
npm test
```

See [SPEC.md](SPEC.md) for the rules.

## License

MIT
