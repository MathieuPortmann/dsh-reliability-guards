// Answer checks of dsh-reliability-guards, run when a turn is about to close, next to the
// rules of ./rules.js. They look at the commands an answer gives the user:
//
//   codeWhileWaiting  the user asked to explain first and wait for their validation, and the
//                     answer still contains code blocks
//   unknownCommand    a program in a shell block of the answer is not installed and appears
//                     nowhere in the turn (invented tools presented as real)
//   untestedCommand   a name (key, schema, path, option value) in a command of the answer
//                     appears in no tool result of the conversation (completed from memory)
//   shellMistake      wrong dconf syntax (a key ending with "/", a folder without it)
//   sourcesDenied     web pages were read, but the answer says it used no source
//
// What can be known before the answer is written is also said while the model works
// (answerRules), and all findings go back in ONE message (groupedNudge): each message after the
// answer costs a whole rewrite.
//
// Pure: the file system is reached only through the `exists` / `pathExists` functions given by
// index.js, so the same checks run in tests without a computer to look at.

// --- The user's wait ----------------------------------------------------------
// "Explain your approach, wait for my validation" (French and English). The wait lasts from
// message to message: set by such a message, ended only by a go-ahead (answering the model's
// questions is not a validation).
const HOLD = [
  /\battends?\s+(?:ma|mon|la|le|que|mes)\b[^.\n]{0,40}\b(?:validation|confirmation|accord|feu vert|r[ée]ponse|retour|je\s+(?:valide|confirme))/i,
  /\bavant\s+toute\s+(?:autre\s+)?(?:action|modification)/i,
  /\bne\s+(?:g[ée]n[èe]re|fais|fai[st]|modifie|cr[ée]e|[ée]cris|lance|touche|change|fait)\s+(?:rien|aucune?\s+(?:action|modification|changement|fichier|script|configuration|commande)|pas\s+encore)/i,
  /\b(?:explique[rz]?|d[ée]cris|d[ée]crire|pr[ée]sente[rz]?)\s+(?:[\wéèêàç-]+\s+)?(?:la|ta|votre)\s+(?:d[ée]marche|m[ée]thode|strat[ée]gie)/i,
  /\bne\s+(?:g[ée]n[èe]re|fais|modifie|cr[ée]e|[ée]cris)\s+pas\s+(?:encore|de\s+fichier)/i,
  /\bwait\s+for\s+my\s+(?:approval|confirmation|validation|go\b|ok\b)/i,
  /\b(?:do\s*n[o']t|don'?t)\s+(?:do\s+anything|change\s+anything|generate\s+any|write\s+anything|act\b)/i,
  /\bbefore\s+any\s+(?:other\s+)?action/i,
  /\bonly\s+(?:explain|describe)\b/i,
  /\bsans\s+(?:le\s+|la\s+|les\s+|l'|rien\s+|y\s+)?(?:modifier|toucher|changer|[ée]crire|rien\s+(?:modifier|changer|toucher))\b/i,
  /\bwithout\s+(?:changing|modifying|touching|editing)\b/i,
];
const GO = /\b(?:je\s+valide|valid[ée]e?(?![\wÀ-ÿ])(?!\s*\?)|vas-y|go\b|c'est\s+bon|feu\s+vert|je\s+confirme|tu\s+peux\s+(?:y\s+aller|commencer|appliquer|le\s+faire|l'appliquer|proc[ée]der|[ée]crire|cr[ée]er)|applique-(?:le|la|les)\b|proc[èe]de\b|ok\s+pour|lance-(?:toi|le)\b|approved?\b|go\s+ahead|proceed\b)/i;

/** The message asks the model to wait for approval or to explain without acting. */
export const isHold = text => HOLD.some(r => r.test(String(text ?? '')));
/** The message gives the go-ahead that ends the wait. */
export const isGo = text => GO.test(String(text ?? ''));

/** Waiting state after one user message: set by a "wait" message, ended by a go-ahead. */
export function nextWaiting(waiting, userText) {
  if (isHold(userText)) return true;
  if (isGo(userText)) return false;
  return Boolean(waiting);
}

// --- Commands of the answer ---------------------------------------------------

/** Fenced code blocks of a Markdown text: [{ lang, body }]. */
export function codeBlocks(text) {
  return [...String(text ?? '').matchAll(/```([\w+-]*)[^\n]*\n([\s\S]*?)```/g)].map(m => ({ lang: m[1].toLowerCase(), body: m[2] }));
}

const SHELL_LANGS = new Set(['', 'bash', 'sh', 'shell', 'zsh', 'console', 'terminal', 'fish']);
const BUILTINS = new Set(('alias bg bind break builtin case cd command compgen complete continue declare dirs disown echo enable eval exec exit export false fc fg '
  + 'for function getopts hash help history if jobs kill let local logout mapfile popd printf pushd pwd read readarray readonly return select set shift shopt '
  + 'source suspend test then time times trap true type typeset ulimit umask unalias unset until wait while do done fi elif else esac in').split(' '));

/** Program names that start the commands of a shell code block. */
export function commandsOf(body) {
  const joined = String(body).replace(/\\\n/g, ' ');
  const names = [];
  for (let line of joined.split('\n')) {
    line = line.replace(/^\s*\$\s+/, ''); // "$ cmd" prompts
    if (/^\s*#/.test(line) || !line.trim()) continue;
    const unquoted = line.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, 'Q').replace(/#.*$/, '');
    for (let seg of unquoted.split(/\|\||&&|[|;]|\$\(|`/)) {
      seg = seg.trim().replace(/^(?:sudo|env|nohup|time|exec)\s+(?:-\S+\s+)*/, '').replace(/^(?:[A-Za-z_]\w*=\S*\s+)+/, '');
      // A program name is lower case and does not end with "-"; "x = …", "x(…)", "x: …" are code or text, not commands.
      const m = seg.match(/^([a-z][a-z0-9._+-]*[a-z0-9])(?=\s|$)(?!\s*[=(:.])/);
      if (m && !BUILTINS.has(m[1])) names.push(m[1]);
    }
  }
  return [...new Set(names)];
}

// Words that mark a command the model could not test; such a command is not reported.
const UNTESTED_MARK = '(?:untested|not tested|to check|non test[ée]|à vérifier|a verifier)';
const MARKED = new RegExp(`#.*${UNTESTED_MARK}`, 'i');
const MARKED_AFTER = new RegExp(`^[^\\n]{0,40}?${UNTESTED_MARK}`, 'i');

/** Inline `code` spans of a text that read as a shell command: a program (installed, ./x, x.sh)
 *  followed by at least one option, or a list of options written alone. */
export function inlineCommands(text, exists = () => false) {
  const out = [];
  for (const m of String(text ?? '').matchAll(/`([^`\n]{6,300})`/g)) {
    const span = m[1].trim().replace(/^\$\s+/, '').replace(/^sudo\s+/, '');
    // Options written alone (`-t green -c medium`): their values are checked like a command's.
    if (/^-{1,2}[a-zA-Z][\w-]*\s+\S+(?:\s+\S+)*\s+-{1,2}[a-zA-Z]/.test(span)) { out.push(`options ${span}`); continue; }
    const prog = /^(\S+)\s/.exec(span)?.[1];
    if (!prog || !/\s-{1,2}[a-zA-Z]/.test(span)) continue;
    if (MARKED_AFTER.test(text.slice(m.index + m[0].length))) continue;
    if (/^\.{0,2}\/|\.sh$/.test(prog) || (/^[a-z][a-z0-9._+-]*$/.test(prog) && exists(prog))) out.push(span);
  }
  return out;
}

/** Programs installed by the answer itself (apt, flatpak, snap, pip, cargo, npm…). */
export function installedBy(text) {
  const names = new Set();
  for (const m of String(text ?? '').matchAll(/\b(?:apt(?:-get)?|aptitude|nala|dnf|zypper|pacman\s+-S\w*|flatpak|snap|pipx?|pip3|cargo|npm|brew)\s+(?:install|add|i)\b([^\n`|;&]*)/g)) {
    for (const t of m[1].trim().split(/\s+/)) {
      if (!t || t.startsWith('-')) continue;
      names.add(t);
      names.add(t.split('.').at(-1)); // flatpak ids: ca.desrt.dconf-editor -> dconf-editor
    }
  }
  return names;
}

// The model's own writing (a proposal, a file it writes, its step notes) is no evidence: an
// invented command first put in a proposal was then "seen" there.
export const AUTHORED = /(?:^|_)(?:propose\w*|write|edit\w*|step_done|ask_user_question|todo\w*)$|^(?:write|edit|apply_patch)$/;
const seenOf = work => [work?.userText ?? '', ...(work?.calls ?? []).flatMap(c => [AUTHORED.test(c.name ?? '') ? '' : (c.args ?? ''), c.result?.text ?? ''])].join('\n');

const INSTALL = /^\s*(?:sudo\s+)?(?:apt|apt-get|nala|dnf|yum|pacman|yay|paru|zypper|flatpak|snap|pip3?|pipx|npm|pnpm|yarn|cargo|brew|gnome-extensions\s+install)\b.*\b(?:install|add|-S)\b/;

/** Identifier-like arguments of one command line (no options, values, URLs, variables). */
export function identifiersOf(line) {
  const words = [...String(line).replace(/\s#.*$/, '').matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3]);
  // A name the command creates (-n MyTheme, --name …) cannot have been seen before.
  return words.slice(1).filter((w, i, all) => !/^(?:-n|--name)$/.test(all[i - 1] ?? ''))
    .map(w => w.replace(/^['"]+|['"]+$/g, '').replace(/[,;)]+$/, ''))
    .filter(w => w.length >= 4 && !/\s/.test(w) && /[a-z]/i.test(w) && /[-_./]/.test(w))
    .filter(w => !/^-/.test(w) && !/[$<>{}*|=]/.test(w) && !/^[a-z]+:\/\//i.test(w) && !/^\d/.test(w));
}

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Names of the shell blocks that nothing in `seen` confirms. */
export function untestedNames(blocks, seen, pathExists = () => false) {
  const out = new Set();
  for (const b of blocks.filter(b => SHELL_LANGS.has(b.lang))) {
    for (const line of String(b.body).replace(/\\\n/g, ' ').split('\n')) {
      if (!line.trim() || /^\s*#/.test(line) || INSTALL.test(line) || MARKED.test(line)) continue;
      for (const seg of line.split(/\|\||&&|[|;]/)) {
        for (const id of identifiersOf(seg.trim().replace(/^\s*\$\s+/, '').replace(/^(?:sudo|env)\s+/, ''))) {
          const name = id.replace(/\/+$/, '');
          if (seen.includes(name) || ((name.startsWith('/') || name.startsWith('~')) && pathExists(name))) continue;
          // A settings path = a folder seen + a key seen (/org/…/overview/ + name="blur").
          const cut = name.lastIndexOf('/');
          if (name.startsWith('/') && cut > 0 && seen.includes(name.slice(0, cut + 1)) && new RegExp(`["'\\s]${esc(name.slice(cut + 1))}["'\\s]`).test(seen)) continue;
          out.add(id);
        }
      }
    }
  }
  return [...out];
}

/** Wrong dconf uses of the answer: ["what is wrong → what to write", …]. */
export function shellMistakes(blocks) {
  const issues = new Set();
  for (const b of blocks.filter(b => SHELL_LANGS.has(b.lang))) {
    for (const line of String(b.body).replace(/\\\n/g, ' ').split('\n')) {
      for (const m of line.matchAll(/\bdconf\s+(read|write|reset)((?:\s+-\w)*)\s+(\/\S*)/g)) {
        if (m[3].endsWith('/') && !(m[1] === 'reset' && /-f/.test(m[2]))) issues.add(`dconf ${m[1]} ${m[3]}: a dconf key never ends with "/" (dconf refuses it); for a whole folder use dconf dump ${m[3]} or dconf list ${m[3]}${m[1] === 'reset' ? ` (or dconf reset -f ${m[3]})` : ''}`);
      }
      for (const m of line.matchAll(/\bdconf\s+(dump|list)\s+(\/\S*)/g)) {
        if (!m[2].endsWith('/')) issues.add(`dconf ${m[1]} ${m[2]}: dconf ${m[1]} takes a folder ending with "/" (${m[2]}/); to read one key use dconf read ${m[2]}`);
      }
    }
  }
  return [...issues].slice(0, 6);
}

/**
 * Findings for the final answer of a turn ({ code, data, detail }, like the rules of ./rules.js).
 * work: the turn's bookkeeping (finalText, calls, userText); waiting: the user asked to wait;
 * exists(name): is this program installed?; seenText: what the conversation's tools really
 * returned (full results, kept by index.js); pathExists(path): is this file or folder there?
 * on: which checks are switched on (all by default).
 */
export function checkAnswer(work, { waiting = false, exists = () => true, seenText = '', pathExists = () => false, on = {} } = {}) {
  const enabled = code => on[code] !== false;
  const text = String(work?.finalText ?? '');
  const fenced = codeBlocks(text);
  if (fenced.length && waiting && enabled('codeWhileWaiting')) return [{ code: 'codeWhileWaiting', data: { blocks: fenced.length }, detail: `${fenced.length} code block(s) while the user waits` }];
  // Commands written inline count too (`install.sh -t green -c medium`).
  const inline = inlineCommands(text.replace(/```[\s\S]*?```/g, ''), exists);
  const blocks = inline.length ? [...fenced, { lang: 'bash', body: inline.join('\n') }] : fenced;
  if (!blocks.length) return [];
  const seen = seenOf(work);
  const installedHere = installedBy(text);
  const out = [];
  const names = enabled('unknownCommand') ? [...new Set(blocks.filter(b => SHELL_LANGS.has(b.lang)).flatMap(b => commandsOf(b.body))
    .filter(name => name !== 'options' && !/\.sh$/.test(name) && !exists(name) && !installedHere.has(name) && !seen.includes(name)))] : [];
  if (names.length) out.push({ code: 'unknownCommand', data: { names }, detail: names.join(', ') });
  const issues = enabled('shellMistake') ? shellMistakes(blocks) : [];
  if (issues.length) out.push({ code: 'shellMistake', data: { issues }, detail: issues.join(' | ') });
  // untestedCommand: only when the turn used tools (the model could have checked).
  if (!enabled('untestedCommand') || !(work?.calls ?? []).length) return out;
  const untested = untestedNames(blocks, `${seen}\n${seenText}`, pathExists).filter(n => !names.includes(n));
  if (untested.length) out.push({ code: 'untestedCommand', data: { names: untested.slice(0, 12) }, detail: untested.join(', ') });
  return out;
}

// --- sourcesDenied --------------------------------------------------------------
// "No external source was consulted" right after a web_search and a web_read: when the model
// read web pages in the turn, an answer that says it used no source, or whose "Sources"
// section has no link, is sent back once.

const WEB_TOOL = /^web_(?:read|search|fetch)$/;
// Pages the model chose to read; a search run automatically by the harness does not count.
const readByModel = c => WEB_TOOL.test(c?.name ?? '') && !String(c?.id ?? '').startsWith('auto-web-') && c.result && !c.result.isError;
const NO_SOURCE = /(?:aucune\s+source|pas\s+de\s+source|sans\s+source)[^.\n]{0,60}(?:consult|utilis|ext[ée]rieur|externe)|no\s+(?:external\s+)?sources?\s+(?:were\s+|was\s+)?(?:used|consulted)/i;

/** URLs read or found in this turn (web tool arguments and results). */
export function webUrlsOf(calls) {
  const urls = new Set();
  for (const c of calls ?? []) {
    if (!readByModel(c)) continue;
    for (const m of `${c.args ?? ''}\n${c.result.text ?? ''}`.matchAll(/https?:\/\/[^\s"')\]>]+/g)) urls.add(m[0]);
  }
  return [...urls];
}

/** The answer hides the web pages of the turn: says it used none, or a "Sources" section without links. */
export function checkSources(work) {
  const text = String(work?.finalText ?? '');
  if (!(work?.calls ?? []).some(readByModel)) return [];
  const at = text.search(/^#*\s*\**sources?\**\s*:?\s*$/im);
  if (!NO_SOURCE.test(text) && !(at >= 0 && !/https?:\/\//.test(text.slice(at)))) return [];
  const urls = webUrlsOf(work.calls).slice(0, 8);
  return [{ code: 'sourcesDenied', data: { urls }, detail: `${urls.length} page(s) read` }];
}

// --- Rules given BEFORE the answer is written -------------------------------------
// The user's explicit demands are listed back while the model works ("check the installed
// version explicitly" and the answer never gave that version).

const DEMAND = /\b(?:v[ée]rifi\w*|explicitement|avant de|n'oublie|assure[- ]toi|il faut|je veux|tu dois|doi[st]|doivent|cite\w*|donne\w*|indique\w*|pr[ée]cise\w*|sans |uniquement|seulement|en (?:fran[cç]ais|anglais)|au format|compare\w*|make sure|must|explicitly|before (?:you|giving|writing)|only|without|include|cite|give)\b/i;

/** Explicit demands of a user text: its sentences that ask for something precise (max 6). */
export function requirementsOf(text) {
  return String(text ?? '').split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(s => s.length >= 12 && DEMAND.test(s))
    .slice(0, 6).map(s => (s.length > 220 ? `${s.slice(0, 220)}…` : s));
}

/** The rules for the answer of this turn ('' = none). */
export function answerRules(work, { waiting = false } = {}) {
  if (!work) return '';
  const rules = [];
  if (waiting) rules.push('The user asked you to explain your approach and wait for their validation: your answer is in words only (each step, what it changes and why, then your questions), with no code block and no command.');
  const reqs = requirementsOf(work.userText);
  if (reqs.length) rules.push(`Your final answer must meet each explicit demand of the user (a value they ask you to check is checked with a tool and given in the answer):\n${reqs.map((r, i) => `   ${i + 1}. ${r}`).join('\n')}`);
  const urls = webUrlsOf(work.calls ?? []);
  if ((work.calls ?? []).some(readByModel)) rules.push(`You read web pages: end your answer with a "Sources" section, one line per page you used ("- Title: URL")${urls.length ? `; pages read: ${urls.slice(0, 8).join(' , ')}` : ''}.`);
  const all = `${work.userText ?? ''}\n${(work.calls ?? []).map(c => `${c.args ?? ''}\n${c.result?.text ?? ''}`).join('\n')}`;
  if (/\bdconf\b/.test(all)) rules.push('dconf: read / write / reset take a KEY (never ending with "/"); dump / list take a FOLDER ending with "/"; reset -f takes a folder.');
  if (!waiting && (work.calls ?? []).length) rules.push('Every key, schema, path, option or value in a command of your answer comes from a tool result of this conversation; one you could not check gets "# untested" at the end of its line (in a sentence: "(untested)").');
  return rules.length ? `Rules for your answer in this turn (write it right the first time; it is checked after):\n${rules.map(r => `- ${r}`).join('\n')}` : '';
}

// --- Messages to the model ----------------------------------------------------------

export function checkNudgeText(f) {
  if (f.code === 'codeWhileWaiting') {
    return 'The user asked you to explain your approach first, with no action, script or configuration, and to wait for their validation. '
      + 'Your answer contains code blocks. Rewrite your whole answer in words only: each step, what it would change and why, then your questions. '
      + 'No code blocks and no commands. Do not mention this reminder.';
  }
  if (f.code === 'unknownCommand') {
    return `These commands of your answer are not installed on this computer and appear in no tool result of this conversation: ${f.data.names.join(', ')}. `
      + 'Do not present them as real or as the user\'s setup. Check each one with a tool (its --help, its source, its documentation or a web search) or remove it; '
      + 'a step you could not check stays only with "(untested)" next to it. Rewrite your whole answer. Do not mention this reminder.';
  }
  if (f.code === 'untestedCommand') {
    return `These names in the commands of your answer appear in no tool result of this conversation: ${f.data.names.join(', ')}. `
      + 'They may be invented or completed from memory (a key, schema, path or value that does not exist). '
      + 'Check each one now with a read-only command (for example ls, cat, --help, gsettings list-keys, dconf read) or by re-reading the source file, and correct it. '
      + 'A command you cannot test keeps "# untested" at the end of its line (in a sentence: "(untested)" right after it). Then rewrite your whole answer. Do not mention this reminder.';
  }
  if (f.code === 'shellMistake') {
    return 'The harness checked these commands of your answer; they are wrong:\n'
      + f.data.issues.map(i => `- ${i}`).join('\n')
      + '\nCorrect each one (you may check it first with a read-only command), then rewrite your whole answer. Do not mention this reminder.';
  }
  if (f.code === 'sourcesDenied') {
    return `You read web pages in this turn, but your answer says you used no source or lists none. Pages read: ${f.data.urls.length ? f.data.urls.join(' , ') : '(see your web_search and web_read results)'}. `
      + 'Rewrite your whole answer and end it with a "Sources" section, one line per page you really used ("- Title: URL"). Do not mention this reminder.';
  }
  return '';
}

// --- One correction message for all findings --------------------------------------
const ONCE = /\s*(?:Then\s+)?(?:re)?write your (?:whole|final) answer[^.]*\.|\s*Do not mention this (?:reminder|check)\.|\s*Rewrite your whole answer[^.]*\./gi;
/** Several finding texts as one message: fix all, rewrite once. */
export function groupedNudge(texts) {
  if (texts.length === 1) return texts[0];
  return `The harness checked your answer and found ${texts.length} problems. Fix ALL of them, then write your whole answer again ONCE. Do not mention this check.\n\n`
    + texts.map((t, i) => `${i + 1}) ${t.replace(ONCE, '').trim()}`).join('\n\n');
}
