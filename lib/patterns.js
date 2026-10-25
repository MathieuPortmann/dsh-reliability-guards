// Text patterns of dsh-reliability-guards and the small pure helpers built on
// them. No I/O: every function maps text to a verdict.
//
// The patterns are bilingual on purpose (French and English): small local
// models answer in the language of the user, and the failures they make
// ("c'est fait" / "done", "je vais vérifier" / "let me check") look alike.
//
// \b, \w and \d only know ASCII in JavaScript, so accented letters count as
// non-word characters: "é10.1234/x" still starts a DOI, "été" ends a word at
// the "t". The patterns below rely on that, and the tests protect it.

import { SPELL_ALLOW, EXPLAIN_ALLOW } from './texts.js';

// --- Safe slicing ------------------------------------------------------------
// JavaScript counts UTF-16 units. These never leave half of a surrogate pair
// (an emoji) at the cut, so no lone surrogate reaches the logs or the model.

/** The last `n` UTF-16 units of `s`, without splitting an emoji. */
export function tail(s, n) {
  if (s.length <= n) return s;
  const r = s.slice(-n);
  const c = r.charCodeAt(0);
  return c >= 0xdc00 && c <= 0xdfff ? r.slice(1) : r;
}

/** The first `n` units of `s` followed by "…" when `s` is longer. */
export function clip(s, n) {
  if (s.length <= n) return s;
  const c = s.charCodeAt(n - 1);
  return `${s.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n)}…`;
}

// --- DOIs --------------------------------------------------------------------

// A DOI may contain parentheses: 10.1016/0304-3762(82)90187-0
const DOI = /\b10\.\d{4,9}\/[^\s"'<>\]]+/gi;

/** DOIs in a text: lower case, no duplicates, in order of appearance. */
export function doisOf(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(DOI)) {
    let x = m[0].replace(/[.,;:!?»”`*]+$/u, '');
    // A closing parenthesis without its opening one belongs to the sentence.
    while (x.endsWith(')') && (x.match(/\(/g) ?? []).length < (x.match(/\)/g) ?? []).length) x = x.slice(0, -1).replace(/[.,;:!?]+$/u, '');
    const d = x.toLowerCase();
    if (!/\/[a-z0-9]/i.test(d)) continue; // a bare prefix like "10.1038/" is not a DOI
    if (!out.includes(d)) out.push(d);
  }
  return out;
}

// --- The /explain gesture ----------------------------------------------------

// A whitespace-bounded "/explain", optionally followed by off | stop | fin.
const GESTURE = /(^|\s)\/explain(?:\s+(off|stop|fin))?(?=\s|$)/i;

/** true = turn explain mode on, false = off, undefined = no gesture. */
export function explainGesture(text) {
  const m = GESTURE.exec(String(text ?? ''));
  return m ? !m[2] : undefined;
}

// --- /explain tool allow list --------------------------------------------------

const DEFAULT_ALLOWED = new Set(EXPLAIN_ALLOW);

/** "mcp__notes__logseq_search" -> "logseq_search". */
export function baseName(name) {
  const n = String(name);
  if (!n.startsWith('mcp__')) return n;
  const rest = n.slice(5);
  const i = rest.indexOf('__');
  return i < 0 ? n : rest.slice(i + 2);
}

/** May tool `name` run while /explain is on? `extra` adds allowed names. */
export function explainAllowed(name, extra) {
  const n = baseName(name);
  return DEFAULT_ALLOWED.has(n) || (Array.isArray(extra) && extra.some(x => baseName(x) === n));
}

// --- Detection patterns, one per failure family ---------------------------------

const alt = (list, flags) => new RegExp(list.join('|'), flags);

// A claim of success.
export const SUCCESS = alt([
  "c'est fait", 'c’est fait', "c'est bon", 'termin[ée]', 'avec succ[èe]s', 'fonctionne (maintenant|bien|correctement|parfaitement)',
  '(a|ont) (bien )?[ée]t[ée] (cr[ée]{2}|copi[ée]|sauvegard[ée]|install[ée]|supprim[ée]|modifi[ée]|d[ée]plac[ée]|mis[e]? [àa] jour|enregistr[ée]|ajout[ée])',
  'est (maintenant )?(cr[ée]{2}|copi[ée]|sauvegard[ée]|install[ée]|en place|op[ée]rationnel)',
  "j'ai (bien )?(cr[ée]{2}|copi[ée]|sauvegard[ée]|install[ée]|supprim[ée]|modifi[ée]|d[ée]plac[ée]|ajout[ée]|corrig[ée]|enregistr[ée])",
  '✅', '^\\s*(all )?done[.!]?\\s*$', '\\b(all )?done[.!](\\s|$)', 'successfully', 'has been (created|copied|saved|installed|deleted|updated|moved|added|fixed)',
  'i (have )?(created|copied|saved|installed|deleted|updated|moved|added|fixed)', 'now works', 'is working',
], 'i');

// Tool names below (zotero_*, logseq_*, openalex_*, doi_verify, wos_search...) are those of the
// note-taking and bibliography tools of companion DSH plugins; a name that is not installed never matches.
// Tools about the conversation itself: their errors are not a failed task.
const META_TOOLS = /^(exit_plan_mode|enter_plan_mode|ask_user_question|todo_write|skill|runtime_health|present\w*)$/;
const SHELL = /^(bash|pwsh)$/;
const WRITES = /^(write|edit|str_replace_editor|apply_patch)$/;
const READS = /^(read|read_image|glob|grep|ls|web_search|web_fetch|web_read|doi_verify|wos_search|openalex_\w+|zotero_\w+|logseq_(search|show|list|query|read)\w*|mcp__\w+__(zotero|logseq)_(search|show|list|query|item|read)\w*|mcp__web__\w+)$/;
const family = n => String(n).replace(/^mcp__[a-z0-9-]+__/, '').split('_')[0];

export const isMetaTool = name => META_TOOLS.test(name);

/** Did a later successful call `next` make up for the failed call `failed`? */
export function recovers(failed, next) {
  if (failed === next || SHELL.test(next)) return true; // retried, or done another way in the shell
  if (WRITES.test(failed) && WRITES.test(next)) return true; // write failed, edit worked (or the reverse)
  if (READS.test(failed)) return true; // a failed lookup followed by any successful step
  return family(failed) === family(next); // same tool family (logseq_*, zotero_*)
}

// An answer that also reports a failure is honest, even if it mentions what worked.
export const ADMITS_FAILURE = /([ée]chou|erreur|n['’]existe pas|introuvable|impossible|n['’]a pas (pu|march|fonctionn)|pas r[ée]ussi|failed|error|not found|could not|couldn['’]t|did not work|didn['’]t work)/i;

// "I created / I ran ..." (the action is claimed in the past tense).
export const DID_ACTION = alt([
  "j'ai (bien )?(cr[ée]{2}|copi[ée]|sauvegard[ée]|install[ée]|supprim[ée]|modifi[ée]|d[ée]plac[ée]|ajout[ée]|ex[ée]cut[ée]|lanc[ée]|test[ée]|v[ée]rifi[ée]|lu|ouvert|cherch[ée]|consult[ée]|enregistr[ée])",
  'i (have )?(created|copied|saved|installed|deleted|modified|moved|added|ran|executed|tested|checked|verified|read|opened|searched)',
], 'i');

// "Let me check ..." (the action is announced for later).
export const ANNOUNCE = alt([
  "\\bje vais (maintenant |d['’]abord |tout de suite )?(copier|cr[ée]er|lancer|ex[ée]cuter|v[ée]rifier|chercher|rechercher|lire|les lire|ouvrir|regarder|consulter|modifier|supprimer|installer|faire|effectuer|proc[ée]der|tester|sauvegarder|ajouter|[ée]crire|r[ée]cup[ée]rer|analyser|examiner|utiliser|essayer|interroger|appeler|lister|extraire|t[ée]l[ée]charger|parcourir)",
  '\\b(laissez|laisse)[- ]moi\\b', '\\bcommen[çc]ons\\b', '\\b(v[ée]rifions|essayons|regardons|cherchons|lan[çc]ons|proc[ée]dons)\\b',
  '\\blet me\\b', "\\bi['’]ll (now )?(check|look|search|run|create|copy|read|open|try|start)", '\\bi will (now )?(check|look|search|run|create|copy|read|open|try|start)',
], 'i');

// "I am reading each version:" is an action in progress that the answer never shows.
export const NOW_DOING = /\b(je (lis|cherche|recherche|v[ée]rifie|regarde|consulte|lance|r[ée]cup[èe]re|ouvre|analyse|examine)|i am (reading|checking|searching|looking|running|opening))\b/i;

// An offer or a question is not a promise: "si vous voulez", "do you want"...
export const OFFER = /\?|\bsi (vous|tu|oui)\b|\bif so\b|voulez|souhaitez|veux-tu|\bif you\b|would you|do you want/i;

// "I have no access", "as an AI ...": a claimed lack of capability.
export const DENIAL = alt([
  "je n['’]ai pas (d['’])?acc[èe]s", 'je ne (peux|suis pas en mesure de) (pas )?(acc[ée]der|lire|ouvrir|ex[ée]cuter|lancer|naviguer|consulter|modifier|cr[ée]er|[ée]crire|chercher|rechercher)',
  "en tant qu['’](ia|intelligence artificielle|assistant|mod[èe]le)", "je n['’]ai pas la (possibilit[ée]|capacit[ée])",
  "i (don['’]t|do not) have access", 'i can(not|[’\']t) (access|browse|read|open|run|execute|search|create|write|modify)', 'as an ai',
  'non (impl[ée]mentable|support[ée]) (par|dans) (la plateforme|dsh)', 'la plateforme ne (permet|supporte) pas',
], 'i');

// Tools a denial may be about: if one of them is in the request, the denial is wrong.
export const CAPABILITY_TOOLS = /^(bash|read|write|edit|glob|grep|web_search|web_fetch|web_read|openalex_\w+|zotero_\w+|logseq_\w+|mcp__notes__\w+|mcp__web__\w+|doi_verify|wos_search)$/;

// A tool call or the model's reasoning written as text instead of being executed.
// The code-fence branch is written "(whitespace + language)?, whitespace holding a newline" instead of
// the naive \s*(shell|bash)?\s*\n\s*: both accept the same text, but the naive form is quadratic on
// a long run of blanks (seconds on a 12,000-character answer).
export const MARKUP = /<\/?(tool_call|function(=[\w-]+)?|parameter(=[\w-]+)?|think|invoke)\b[^>]*>|<end>|```(?:\s*(?:shell|bash))?[^\S\n]*\n\s*mcp__\w+/i;

// Pictographic emojis (faces, symbols, check boxes, stars...). Plain marks that
// belong in tables stay allowed: U+2713-2718 (check and cross marks) and the
// arrows U+2794-27BF.
export const EMOJI = /(?![✓-✘➔-➿])[\u{1F000}-\u{1FAFF}☀-➿⬀-⯿\u{1F1E6}-\u{1F1FF}]/u;
export const EMOJI_SAMPLE = new RegExp(`.{0,20}${EMOJI.source}.{0,20}`, 'u');

// Chinese, Japanese and Korean characters, and full-width punctuation.
export const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯！-｠　-〿]/u;
export const CJK_SAMPLE = new RegExp(`.{0,20}${CJK.source}+.{0,20}`, 'u');

// --- French detection and spell-check candidates ------------------------------

const FR_WORDS = /\b(le|la|les|des|est|et|une|pour|dans|que|qui|avec|pas|sur|du|au|aux|cette|sont|vous|tu|nous|mais|ou|il|elle)\b/gi;
const EN_WORDS = /\b(the|and|is|of|to|in|for|with|that|this|are|you|it|be|not|on|as|or)\b/gi;

/** French answer? Common French words against English ones. */
export function isFrench(text) {
  const t = String(text ?? '');
  const fr = (t.match(FR_WORDS) ?? []).length;
  return fr >= 8 && fr > 1.5 * (t.match(EN_WORDS) ?? []).length;
}

const DEFAULT_SPELL_ALLOW = new Set(SPELL_ALLOW.split(/\s+/).filter(Boolean));

/** The default spell allow list plus `extra` words (lower-cased). */
export function spellAllowSet(extra) {
  if (!Array.isArray(extra) || !extra.length) return DEFAULT_SPELL_ALLOW;
  return new Set([...DEFAULT_SPELL_ALLOW, ...extra.map(w => String(w).toLowerCase())]);
}

const NON_LETTERS = /[^\p{L}]+/u;
// URLs, paths, e-mail addresses and DOIs. The e-mail branch is quadratic on a long token without '@',
// so it is left out when the text has no '@' at all (same result).
const URLS_PATHS = /https?:\/\/\S+|(~|\.{0,2})\/[\w./~-]+|\S+@\S+|\b10\.\d{4,9}\/\S+/g;
const URLS_PATHS_NO_AT = /https?:\/\/\S+|(~|\.{0,2})\/[\w./~-]+|\b10\.\d{4,9}\/\S+/g;
// A "Sources" heading: what follows quotes page titles, not the model's French.
const SOURCES_HEAD = /^[#*_\s]*(sources|références|references)[*_\s]*(?::[*_\s]*)?$/i;

/**
 * Words of a French answer worth a spell check: prose only (no code, URLs,
 * paths or links), lower-case words of 4+ letters (a capital means a name),
 * not written by the user and not read in a tool result.
 * @param {string} finalText the answer
 * @param {string} knownText what the user wrote and the tools returned
 * @param {Set<string>} allow words to accept
 */
export function spellCandidatesOf(finalText, knownText, allow) {
  let a = String(finalText ?? '').normalize('NFC'); // decomposed accents would split words
  if (!isFrench(a)) return [];
  const known = new Set(String(knownText ?? '').normalize('NFC').toLowerCase().split(NON_LETTERS).filter(Boolean));
  // Page titles are quoted as found (often English): skip the Sources section
  // (checked line by line, which keeps a long blank run cheap) and every line with a link;
  // lines end at \n only, so a stray \r does not shorten the skipped line.
  let offset = 0;
  for (const line of a.split('\n')) {
    if (SOURCES_HEAD.test(line)) { a = a.slice(0, offset); break; }
    offset += line.length + 1;
  }
  const text = a.replace(/(?<=^|\n)[^\n]*https?:\/\/[^\n]*(?=\n|$)/g, ' ')
    .replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ').replace(/\[\[[^\]]*\]\]|\]\([^)]*\)/g, ' ');
  const prose = text.replace(text.includes('@') ? URLS_PATHS : URLS_PATHS_NO_AT, ' ');
  const out = new Set();
  for (const chunk of prose.split(/\s+/)) {
    // File names, commands, identifiers, numbers: not prose.
    if (/[\/\\_=<>{}|@#$%^&*+~]|\w\.\w|\d/.test(chunk)) continue;
    // Elisions: l'article, qu'il -> article, il; aujourd'hui is kept whole.
    for (const tok of chunk.replace(/[’]/g, "'").replace(/\b(aujourd)'(hui)\b/gi, '$1$2').split(NON_LETTERS)) {
      if (tok.length < 4 || !/^\p{Ll}+$/u.test(tok) || known.has(tok) || allow.has(tok)) continue;
      out.add(tok);
      if (out.size >= 400) return [...out];
    }
  }
  return [...out];
}

/** Words of `text`, lower case (is a misspelled word still there?). */
export const lowerWords = text => new Set(text.toLowerCase().split(NON_LETTERS));

// --- Cut answers --------------------------------------------------------------

/** Answer that stops mid-sentence: long enough, unclosed code block, or ends on ':' / a word / a comma. */
export function looksCut(text) {
  const t = String(text ?? '').trimEnd();
  if (t.length < 200) return false;
  if (((t.match(/```/g) ?? []).length % 2) === 1) return true;
  const last = t.split('\n').at(-1).trim();
  if (/^(\||[-*+]\s|\d+[.)]\s|#{1,6}\s|>)/.test(last)) return false; // table row, list item, heading, quote
  if (/^([-*_])\1{2,}$/.test(last)) return false; // horizontal rule
  if (/https?:\/\/\S+$/.test(last)) return false;
  if (/\b10\.\d{4,9}\/\S+$/.test(last)) return false;
  return /[:,;(«“\-–]$/.test(last) || (/\p{L}$/u.test(last) && !/[.!?…)»"”'`*_\]]$/.test(last) && last.split(/\s+/).length > 3);
}

/** The last sentence of an answer: the text after the last ". ", "! ", "? " or "… ". */
export const lastSentence = text => text.split(/(?<=[.!?…])\s+/).at(-1) ?? '';

// --- Shell commands -------------------------------------------------------------

const DESTRUCTIVE = [
  [/(^|[;&|(]\s*|\bsudo\s+|\bxargs\s+)(rm|rmdir|shred|unlink)\b/, 'delete'],
  [/\bfind\b[^;&|]*\s-(delete|exec\s+rm)\b/, 'delete', /-delete|-exec/],
  [/(^|[;&|(]\s*|\bsudo\s+)mv\s/, 'move'],
  [/\bgit\s+(reset\s+--hard|clean\s+-\w*f|checkout\s+--\s|checkout\s+\.|restore\s|push\s+(-f|--force)|branch\s+-D|stash\s+drop)/, 'git'],
  [/(^|[;&|(]\s*)(dd|mkfs(\.\w+)?|truncate|wipefs)\s/, 'disk'],
];

/** Paths a command redirects into with '>' (not '>>', not 2>, not /dev/...). */
export function overwriteTargets(cmd) {
  const out = [];
  for (const m of String(cmd).matchAll(/(?<![>&\d])>(?!>|&)\s*("[^"]+"|'[^']+'|[^\s;&|<>]+)/g)) {
    const p = m[1].replace(/^["']|["']$/g, '');
    if (p !== '/dev/null' && !p.startsWith('/dev/')) out.push(p);
  }
  return out;
}

/** Last argument of a cp command (its destination). */
function cpTarget(cmd) {
  const m = /(^|[;&|(]\s*|\bsudo\s+)cp\s+([^;&|]+)/.exec(cmd);
  if (!m) return null;
  const args = m[2].trim().split(/\s+/).filter(x => !x.startsWith('-'));
  return args.length >= 2 ? args.at(-1).replace(/^["']|["']$/g, '') : null;
}

const BACKUP_TO_TMP = /\b(cp|mv|tar|rsync|zip|7z)\b[^;&|]*\s\/tmp\//;
const BACKUP_WORD = /\b(backup|sauvegard|\.bak|bak\b|copie)/i;

/**
 * Sort a shell command without looking at the disk. Returns null (harmless),
 * { kind: 'tmpBackup' }, { kind: 'destructive', why, detail } or
 * { kind: 'check', detail, paths }: harmful only if one of `paths` is an
 * existing file.
 */
export function classifyParts(cmd) {
  // The substring tests are cheap necessary conditions: they keep the patterns off most long commands.
  if (cmd.includes('/tmp/') && BACKUP_TO_TMP.test(cmd) && BACKUP_WORD.test(cmd)) return { kind: 'tmpBackup' };
  const detail = clip(cmd.trim(), 300);
  for (const [re, why, needs] of DESTRUCTIVE) if ((!needs || needs.test(cmd)) && re.test(cmd)) return { kind: 'destructive', why, detail };
  const target = cpTarget(cmd);
  const paths = [...(target === null ? [] : [target]), ...overwriteTargets(cmd)];
  return paths.length ? { kind: 'check', detail, paths } : null;
}
