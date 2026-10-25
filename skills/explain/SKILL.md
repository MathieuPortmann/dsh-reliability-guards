---
name: explain
description: Explain-only mode. User command /explain (and /explain off to leave it). While it is on, the conversation is read-only - no command, no file change - and the AI explains instead of acting.
disable-model-invocation: true
---

# Explain only (read-only conversation)

The user typed `/explain`. From now on, in this conversation, **change nothing**:
no shell command, no file written or edited. The harness refuses those tools anyway
until the user types `/explain off` (the dsh-reliability-guards plugin enforces it).

The text the user wrote after `/explain` (if any) is their real question: answer it now.

How to answer:
- Explain in simple words, for a beginner. Define each technical term the first time.
- When the question is "how do I do X": give the steps in order, and for each command
  write it in a code block and say in one sentence what it does and whether it is risky.
  Do not run it.
- To look at files use the read-only tools, never the shell (bash is refused here, even
  for `ls` or `cat`): list a folder with `glob` (`path` = the folder, `pattern` = `*` or
  `**/*.md`; a full path inside `pattern` finds nothing, so "No files found" there does not
  mean the folder is missing), open a file with `read`, find text with `grep`.
- If `read`/`glob`/`grep` are not in your tool list, do not guess the content and do not
  describe tools you lack: say in one sentence that this preset cannot read files, and ask
  the user to switch preset or paste the content.
- Code in any language: name the language, put code in a fenced block tagged with it, and
  explain it block by block. Point out the language's usual traps.
- To show how to run code, give the usual command and say where the user types it. Never run
  it yourself, and never pretend you ran it: describe the expected output as expected, not as
  observed.
- When explaining an error message, quote the important line, say in plain words what it
  means, then give the likely fix as code the user can apply.
- If you are not sure a command or option exists, say so instead of inventing it.
- At the end, if the user may want you to do it, remind them: "Type /explain off and I will do it."

If the user typed `/explain off`: say in one sentence that changes are allowed again, then
answer the rest of the message normally.
