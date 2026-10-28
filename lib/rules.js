// Reliability rules for dsh-reliability-guards.
//
// Pure: no I/O, no clocks, no randomness. The same functions run live (when a
// turn is about to close) and in the session projection (replay of a log), so
// both always reach the same verdict. The text patterns are in ./patterns.js,
// the texts and word lists in ./texts.js.
//
// Each rule answers one failure family seen with small local models:
//   falseSuccess       "done / it works" after a failed tool
//   actionWithoutTool  "I created / ran / checked" with no tool call
//   announcedOnly      an action announced, never done
//   deniedCapability   "I have no access" while the tool is available
//   unverifiedDoi      a DOI in the answer that no tool result contains
//   foreignScript      Chinese/Japanese/Korean characters nobody asked for
//   emoji              emojis in a conversation that has none
//   frenchSpelling     misspelled French words still there after the reminder
//   markupLeak         a tool call written as text
//   cutAnswer          an answer that stops mid-sentence
import {
  tail, doisOf, explainGesture, explainAllowed, isMetaTool, recovers, isFrench, looksCut, lastSentence,
  overwriteTargets, classifyParts, spellCandidatesOf, spellAllowSet, lowerWords,
  SUCCESS, ADMITS_FAILURE, DID_ACTION, ANNOUNCE, NOW_DOING, OFFER, DENIAL, CAPABILITY_TOOLS, MARKUP, EMOJI, EMOJI_SAMPLE, CJK, CJK_SAMPLE,
} from './patterns.js';
import { NUDGE, USER_TEXT as USER_TEXT_SOURCE } from './texts.js';
import { nextWaiting } from './answer-checks.js';

export { doisOf, explainGesture, looksCut, overwriteTargets, isFrench };

export const STATE_VERSION = 1;
export const SOURCE_KIND = 'reliability-guard';

export const DEFAULTS = Object.freeze({
  falseSuccess: true,
  actionWithoutTool: true,
  announcedOnly: true,
  deniedCapability: true,
  unverifiedDoi: true,
  cutAnswer: true,
  foreignScript: true,
  emoji: true,
  frenchSpelling: true,
  destructiveAsk: true,
  tmpBackupDeny: true,
  explainMode: true,
  maxNudgesPerTurn: 2,
  maxTurns: 30,
  maxEvidenceDois: 500,
});

/** Messages shown to the user, in English and French. */
export const USER_TEXT = USER_TEXT_SOURCE;

export function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(c => (c && typeof c.text === 'string' ? c.text : '')).join('\n');
}

/** A bash/pwsh result that failed: flagged as error, or a non-zero "[exit code: N]" footer. */
export function failedResult(r) {
  if (!r) return false;
  if (r.isError) return true;
  return /\[exit code: (?!0\])-?\d+\]/.test(r.text ?? '');
}

/**
 * Tools closed while /explain is on: every tool that is NOT in the allow list
 * (lib/texts.js). An object with `.test`, like a RegExp. The optional second
 * argument adds allowed tool names (the `explainAllow` setting).
 */
export const MODIFYING_TOOLS = Object.freeze({ test: (name, extraAllow) => !explainAllowed(name, extraAllow) });

export { explainAllowed };

export const initState = () => ({
  version: STATE_VERSION,
  explain: false,
  waiting: false, // the user asked to explain first and wait for a go-ahead (lib/answer-checks.js)
  tools: [], // tool names of the latest request (what the model really had)
  evidence: [], // DOIs read in tool results or written by the user (session-wide, bounded)
  work: null, // scratch data of the current turn
  turns: [], // last maxTurns turn records: { turn, findings: [{ code, action, detail }] }
});

// --- Session projection: per-turn work + session-wide evidence -------------
// Plain bookkeeping: fold one session-log event into the state. The text
// analysis it needs (DOIs, the /explain gesture) comes from ./patterns.js.

const tailN = (s, n) => (s.length > n ? s.slice(-n) : s);
const clipN = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

function newWork(turn) {
  return { turn, userText: '', calls: [], finalText: '', finalHasCalls: false, nudges: {}, nudgeCount: 0, verified: {}, misspelled: [] };
}

function addEvidence(list, dois, config) {
  const add = dois.filter(x => !list.includes(x));
  if (!add.length) return list;
  const next = [...list, ...add];
  return next.length > config.maxEvidenceDois ? next.slice(-config.maxEvidenceDois) : next;
}

export function applyEvent(state, event, config = DEFAULTS) {
  const d = event?.data ?? {};
  const w = state.work;
  switch (event?.type) {
    case 'turn/start':
      return { ...state, work: newWork(d.turn ?? null) };
    case 'request/header': {
      const tools = (d.header?.tools ?? []).map(t => String(t?.name ?? '')).filter(Boolean);
      return tools.length ? { ...state, tools } : state;
    }
    case 'user/message': {
      const kind = d.source?.kind;
      const text = textOf(d.content);
      if (kind === 'user') {
        const g = explainGesture(text);
        const evidence = addEvidence(state.evidence, doisOf(text), config);
        const next = { ...state, evidence, explain: g === undefined ? state.explain : g, waiting: nextWaiting(state.waiting, text) };
        if (w) next.work = { ...w, userText: tailN(`${w.userText}\n${text}`, 4000) };
        return next;
      }
      if (kind === 'web-toggle' && String(d.source?.summary ?? '').startsWith('automatic web search')) {
        // A search run by the harness itself (web switch on): its results are
        // evidence (DOIs read) and count as a successful read in this turn.
        const evidence = addEvidence(state.evidence, doisOf(text), config);
        if (!w) return { ...state, evidence };
        const call = { id: `auto-web-${w.calls.length}`, name: 'web_search', args: '(automatic search by the harness)', result: { isError: false, text: tailN(text, 800) } };
        return { ...state, evidence, work: { ...w, calls: [...w.calls, call].slice(-60) } };
      }
      if (kind === SOURCE_KIND && w) {
        // Our own reminder, durable in the log: remember it and the verdicts it carries.
        const code = d.source?.summary?.split(' ')[0] ?? 'unknown';
        const verified = { ...w.verified };
        for (const m of text.matchAll(/NOT FOUND: (\S+)/g)) verified[m[1].toLowerCase()] = 'notFound';
        const spelled = /^MISSPELLED: (.+)$/m.exec(text);
        const misspelled = spelled ? spelled[1].split(', ').map(x => x.trim()).filter(Boolean) : (w.misspelled ?? []);
        // One message may carry several findings: "a+b reliability check".
        const nudges = { ...w.nudges };
        for (const c of code.split('+')) nudges[c] = true;
        return { ...state, work: { ...w, nudges, nudgeCount: w.nudgeCount + 1, verified, misspelled } };
      }
      return state;
    }
    case 'assistant/message': {
      if (!w) return state;
      const m = d.message ?? {};
      const text = textOf((m.content ?? []).filter(c => c?.type === 'text'));
      const hasCalls = (m.content ?? []).some(c => c?.type === 'toolCall' || c?.type === 'tool_call' || c?.type === 'tool-call');
      // The answer of a turn is the text of its last message; a continuation after a cutAnswer reminder is appended.
      const finalText = w.nudges.cutAnswer && w.finalText && text ? `${w.finalText}${text}` : (text || w.finalText);
      return { ...state, work: { ...w, finalText: tailN(finalText, 12000), finalHasCalls: hasCalls } };
    }
    case 'tool/call': {
      if (!w || !d.callId) return state;
      const call = { id: d.callId, name: String(d.name ?? 'unknown'), args: clipN(String(d.arguments ?? ''), 600), result: null };
      return { ...state, work: { ...w, calls: [...w.calls, call].slice(-60) } };
    }
    case 'tool/result': {
      const m = d.message ?? {};
      const callId = m.toolCallId ?? m.source?.callId;
      const text = textOf(m.content);
      const evidence = addEvidence(state.evidence, doisOf(text), config);
      if (!w || !callId) return evidence === state.evidence ? state : { ...state, evidence };
      const calls = w.calls.map(c => (c.id === callId ? { ...c, result: { isError: m.isError === true, text: tailN(text, 800) } } : c));
      return { ...state, evidence, work: { ...w, calls } };
    }
    case 'turn/end': {
      if (!w) return state;
      const findings = detect(w, state, config).map(f => ({ code: f.code, action: w.nudges[f.code] ? 'warned' : 'detected', detail: f.detail }));
      const nudged = Object.keys(w.nudges).filter(c => !findings.some(f => f.code === c)).map(code => ({ code, action: 'corrected', detail: '' }));
      const record = { turn: w.turn, findings: [...nudged, ...findings] };
      const turns = record.findings.length ? [...state.turns.filter(t => t.turn !== w.turn), record].slice(-config.maxTurns) : state.turns;
      return { ...state, turns, work: null };
    }
    default:
      return state;
  }
}

// --- Detection over one turn -------------------------------------------------

// A shell call that only looks programs up (which, type, command -v, compgen…) is a question,
// not a step of the task: `type web_read` failing with exit 1 is no failure to report.
const PROBE = /^(?:which|type|whereis|hash|compgen|command\s+-[vV]|echo|printf|true|false)\b/;
export function isProbe(command) {
  const segs = String(command ?? '').replace(/\d?>&?\s*\S+/g, ' ').split(/\|\||&&|[|;\n]/).map(x => x.trim()).filter(Boolean);
  return segs.length > 0 && segs.every(x => PROBE.test(x));
}
const commandOf = args => { try { return JSON.parse(args).command; } catch { return /"command"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(String(args ?? ''))?.[1]; } };
const isFailedProbe = c => (c.name === 'bash' || c.name === 'pwsh') && failedResult(c.result) && isProbe(commandOf(c.args));

// Settings missing from a partial config keep their default.
const withDefaults = config => (config === DEFAULTS || config == null ? DEFAULTS : { ...DEFAULTS, ...config });

/**
 * Findings for one turn, in priority order: [{ code, detail, data }].
 * `work` is the projection's scratch data of the turn; `state` gives the tools
 * of the request and the DOIs already read. DOI findings carry the candidate
 * list: the live hook checks them over the network, a replay does not.
 */
export function detect(work, state, config = DEFAULTS) {
  config = withDefaults(config);
  const out = [];
  const a = work.finalText ?? '';
  if (!a.trim() || work.finalHasCalls) return out;
  const calls = (work.calls ?? []).filter(c => !isFailedProbe(c));

  // Success claimed while a tool failure was never followed by a success.
  // An answer that also reports the failure is honest.
  if (config.falseSuccess && SUCCESS.test(a) && !ADMITS_FAILURE.test(a)) {
    const unresolved = [];
    calls.forEach((c, i) => {
      if (isMetaTool(c.name) || !failedResult(c.result)) return;
      // A mistyped call (unknown tool, invalid arguments) is fixed by any later successful step.
      const slip = /unknown tool|invalid arguments|invalid_args/i.test(c.result.text ?? '');
      const recovered = calls.slice(i + 1).some(n => n.result && !failedResult(n.result) && (slip || recovers(c.name, n.name)));
      if (!recovered) unresolved.push(c);
    });
    if (unresolved.length) {
      const c = unresolved.at(-1);
      out.push({ code: 'falseSuccess', detail: c.name, data: { tool: c.name, error: tail((c.result?.text ?? '').trim(), 300) } });
    }
  }

  // "I did X" with no tool call at all in this turn.
  if (config.actionWithoutTool && calls.length === 0) {
    const m = DID_ACTION.exec(a);
    if (m) out.push({ code: 'actionWithoutTool', detail: m[0], data: { excerpt: m[0] } });
  }

  // An action announced at the end of the answer and never done.
  const end = tail(a.trimEnd(), 260);
  const announces = ANNOUNCE.test(end) || NOW_DOING.test(end);
  const stopsOnColon = (end.endsWith(':') && (announces || a.trim().length < 300)) || (end.endsWith('…') && announces);
  // The very last sentence announces an action (not an offer or a question): nothing will follow it.
  const last = lastSentence(a.trimEnd());
  const endsOnPromise = ANNOUNCE.test(last) && !OFFER.test(last);
  if (config.announcedOnly && ((calls.length === 0 && ANNOUNCE.test(end)) || stopsOnColon || endsOnPromise)) {
    const m = ANNOUNCE.exec(end) ?? NOW_DOING.exec(end) ?? [tail(end.split('\n').at(-1), 80)];
    out.push({ code: 'announcedOnly', detail: m[0], data: { excerpt: m[0] } });
  }

  // Denial of a capability whose tool is in the request, with no attempt this turn.
  if (config.deniedCapability && calls.length === 0) {
    const m = DENIAL.exec(a);
    const rank = t => (/web|wos|doi|openalex/.test(t) ? 0 : /zotero|logseq|notes/.test(t) ? 1 : 2);
    const available = (state.tools ?? []).filter(t => CAPABILITY_TOOLS.test(t)).sort((x, y) => rank(x) - rank(y));
    if (m && available.length) out.push({ code: 'deniedCapability', detail: m[0], data: { excerpt: m[0], tools: available.slice(0, 12) } });
  }

  // DOIs that no tool result (and no user message) contains.
  if (config.unverifiedDoi) {
    const evidence = new Set(state.evidence ?? []);
    const unknown = doisOf(a).filter(x => !evidence.has(x));
    if (unknown.length) out.push({ code: 'unverifiedDoi', detail: unknown.join(' '), data: { dois: unknown.slice(0, 8), notFound: unknown.filter(x => work.verified?.[x] === 'notFound') } });
  }

  // Chinese/Japanese/Korean characters the user did not use.
  if (config.foreignScript && CJK.test(a) && !CJK.test(work.userText ?? '')) {
    const sample = CJK_SAMPLE.exec(a)?.[0] ?? '';
    out.push({ code: 'foreignScript', detail: sample, data: { sample } });
  }

  // Emojis in the answer while the user wrote none.
  if (config.emoji && EMOJI.test(a) && !EMOJI.test(work.userText ?? '')) {
    const sample = (EMOJI_SAMPLE.exec(a)?.[0] ?? '').trim();
    out.push({ code: 'emoji', detail: sample, data: { sample } });
  }

  // Words the live spell check reported (recorded in the reminder) still in the answer.
  if (config.frenchSpelling && work.misspelled?.length) {
    const words = lowerWords(a);
    const left = work.misspelled.filter(x => words.has(x.toLowerCase()));
    if (left.length) out.push({ code: 'frenchSpelling', detail: left.slice(0, 10).join(', '), data: { words: left } });
  }

  // A tool call or reasoning written as text instead of being executed; else an answer cut short
  // (also "I will check:" followed by nothing).
  if (config.cutAnswer) {
    const leak = MARKUP.exec(a);
    if (leak) out.push({ code: 'markupLeak', detail: leak[0], data: { sample: leak[0] } });
    else if (looksCut(a)) out.push({ code: 'cutAnswer', detail: tail(a.trimEnd(), 80), data: { tail: tail(a.trimEnd(), 120) } });
  }
  return out;
}

export function fill(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

/** The reminder sent to the model for a finding ("" for an unknown code). */
export function nudgeText(f) {
  const code = f?.code;
  if (typeof code !== 'string' || !Object.hasOwn(NUDGE, code)) return '';
  const data = f.data ?? {};
  const list = (k, sep) => (Array.isArray(data[k]) ? data[k].map(String).join(sep) : '');
  return fill(NUDGE[code], {
    tool: String(data.tool),
    error: typeof data.error === 'string' && data.error ? data.error : '(error)',
    excerpt: String(data.excerpt),
    tools: list('tools', ', '),
    lines: list('lines', '\n'),
    sample: String(data.sample),
    words: list('words', ', '),
    tail: String(data.tail),
  });
}

/**
 * Words of the turn's answer worth a spell check (see patterns.js). The
 * optional second argument adds accepted words: an array, or the config
 * object with its `spellAllow` list.
 */
export function spellCandidates(work, extraAllow) {
  const extra = Array.isArray(extraAllow) ? extraAllow : extraAllow?.spellAllow;
  const known = `${work?.userText ?? ''}\n${(work?.calls ?? []).map(c => `${c.args ?? ''} ${c.result?.text ?? ''}`).join('\n')}`;
  return spellCandidatesOf(work?.finalText, known, spellAllowSet(extra));
}

/**
 * Classify a shell command. `isFile(path)` tells whether a path is an existing
 * regular file. Returns null, { kind: 'destructive', why, detail } or { kind: 'tmpBackup' }.
 */
export function classifyCommand(cmd, isFile = () => false) {
  const v = classifyParts(String(cmd ?? ''));
  if (v?.kind !== 'check') return v;
  return v.paths.some(p => isFile(p)) ? { kind: 'destructive', why: 'overwrite', detail: v.detail } : null;
}
