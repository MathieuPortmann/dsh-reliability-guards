/**
 * Reliability guards — Host half.
 *
 * Catches the most damaging failures of small local models (false success,
 * actions announced but not done, invented DOIs, cut or garbled answers) and
 * lets the model correct itself before the user reads the answer:
 *
 *   1. At `agent/turn-stopping` (the turn is about to close), pure rules
 *      (lib/rules.js) compare the final answer with what the tools really
 *      returned. On a finding the model gets ONE steering message for that
 *      finding in this turn (source kind `reliability-guard`, a notice), so it
 *      rewrites its answer in the same turn. What is still wrong when the turn
 *      ends is shown under the answer (client.js) and stays in the session log,
 *      where the improvement center scan finds it.
 *   2. `tools/pre-execute`: an approval card before destructive shell commands
 *      and before overwriting an existing file; backups into /tmp are refused
 *      with the reason; with /explain on, every tool that changes something is
 *      refused (read-only conversation).
 *      The answer checks (lib/answer-checks.js) look at the commands the answer
 *      gives: code while the user waits, programs not installed, names no tool
 *      showed, wrong dconf syntax, web sources denied. All findings of one stop
 *      go back in ONE message, and what can be known before the answer is
 *      written (the user's demands, the wait, Sources) is said while the model
 *      works (a runtime context).
 *   3. User-invoked skills (/word, /science-writing...) survive the automatic
 *      summaries: their instructions are re-sent once a summary hid them.
 *
 * Constraints: no shell, no file writes. Files are only looked at: whether a
 * program is in the PATH folders, whether a path named in an answer exists,
 * whether a file would be overwritten. Network only for DOI existence
 * checks (OpenAlex, Crossref). The optional French spell check runs the local
 * `enchant-2` program (hunspell dictionaries, offline) without a shell; if it
 * is missing the check is skipped. Every registration is a Cordis effect, so
 * removing the bundle removes all of it.
 */
import { createRequire } from 'node:module';
import { accessSync, constants as fsConstants, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULTS, STATE_VERSION, SOURCE_KIND, MODIFYING_TOOLS, USER_TEXT,
  initState, applyEvent, detect, nudgeText, classifyCommand, fill, spellCandidates,
} from './lib/rules.js';
import { checkDoi } from './lib/doi.js';
import { misspelledFrench } from './lib/spell.js';
import { lostSkills, sessionEvents } from './lib/kept-skills.js';
import { checkAnswer, checkNudgeText, checkSources, answerRules, groupedNudge, AUTHORED } from './lib/answer-checks.js';

// Libraries shipped with dsh resolve from the dsh installation itself, imported
// asynchronously (a synchronous require() of an ES module dsh is still loading
// fails with ERR_INTERNAL_ASSERTION on Node 22).
const dshRequire = createRequire(realpathSync(process.argv[1]));
const importFromDsh = id => import(pathToFileURL(dshRequire.resolve(id)).href);
const { z } = await importFromDsh('zod');
const { createUserMessage } = await importFromDsh('@deepseek-ai/dsh-llm');
const SchemaModule = await importFromDsh('@deepseek-ai/schemastery');
const Schema = SchemaModule.default ?? SchemaModule;

// Optional (llmBodyTimeoutMinutes > 0): Node's fetch drops a response that sends nothing for
// 300 s (undici bodyTimeout, error "terminated"). Ollama buffers a whole tool call before
// sending it, so a large local model writing a long section slowly is cut and retried forever.
let undici;
try { undici = await importFromDsh('undici'); } catch { /* optional: raising the timeout is skipped */ }
const { isUserInvocable, renderSkillContent } = await importFromDsh('@deepseek-ai/dsh-skill');

export const name = 'reliability-guards';
export const inject = ['sessionProjections', 'systemPrompt', 'tools', 'skills'];

export const Config = Schema.object({
  falseSuccess: Schema.boolean().default(DEFAULTS.falseSuccess),
  actionWithoutTool: Schema.boolean().default(DEFAULTS.actionWithoutTool),
  announcedOnly: Schema.boolean().default(DEFAULTS.announcedOnly),
  deniedCapability: Schema.boolean().default(DEFAULTS.deniedCapability),
  unverifiedDoi: Schema.boolean().default(DEFAULTS.unverifiedDoi),
  cutAnswer: Schema.boolean().default(DEFAULTS.cutAnswer),
  foreignScript: Schema.boolean().default(DEFAULTS.foreignScript),
  emoji: Schema.boolean().default(false).description('Ask the model to rewrite answers that contain emojis the user did not write.'),
  frenchSpelling: Schema.boolean().default(false).description('Offline French spell check of answers (needs the enchant-2 program and a French hunspell dictionary).'),
  spellAllow: Schema.array(String).default([]).description('Extra words the French spell check must accept (lower case).'),
  explainAllow: Schema.array(String).default([]).description('Extra tool names that stay available in /explain read-only mode.'),
  llmBodyTimeoutMinutes: Schema.number().min(0).default(0).description('Raise the HTTP body timeout for slow local models (0 keeps the Node default of 5 minutes).'),
  codeWhileWaiting: Schema.boolean().default(true).description('The user asked to explain first and wait for their validation: an answer with code blocks is sent back.'),
  unknownCommand: Schema.boolean().default(true).description('A program in a shell block of the answer that is not installed and appears in no tool result is sent back.'),
  untestedCommand: Schema.boolean().default(true).description('Names (keys, schemas, paths, option values) in the commands of an answer must appear in a tool result, or be marked "# untested".'),
  shellMistake: Schema.boolean().default(true).description('Wrong dconf syntax in the answer (a key ending with "/", a folder without it) is sent back.'),
  sourcesDenied: Schema.boolean().default(true).description('After web pages were read, an answer that says it used no source is sent back.'),
  answerRules: Schema.boolean().default(true).description('While the model works, tell it the rules its answer will be checked against (the user\'s explicit demands, the wait, Sources).'),
  destructiveAsk: Schema.boolean().default(DEFAULTS.destructiveAsk),
  tmpBackupDeny: Schema.boolean().default(DEFAULTS.tmpBackupDeny),
  explainMode: Schema.boolean().default(DEFAULTS.explainMode),
  keepInvokedSkills: Schema.boolean().default(true).description('Re-send the instructions of a skill the user invoked (/science-writing, /word...) once an automatic summary hid them.'),
  maxNudgesPerTurn: Schema.number().min(0).max(5).step(1).default(DEFAULTS.maxNudgesPerTurn),
  doiTimeoutMs: Schema.number().min(1000).default(15_000),
});

const KEY = 'reliabilityGuards';

// The order of findings is their priority: one steering message per turn-stopping.
const NUDGED = ['falseSuccess', 'actionWithoutTool', 'announcedOnly', 'deniedCapability', 'unverifiedDoi', 'foreignScript', 'markupLeak', 'cutAnswer', 'emoji'];

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, emoji: false, frenchSpelling: false, ...rawConfig };
  if (config.llmBodyTimeoutMinutes > 0 && undici) {
    const ms = config.llmBodyTimeoutMinutes * 60 * 1000;
    undici.setGlobalDispatcher(new undici.Agent({ bodyTimeout: ms, headersTimeout: ms }));
  }

  // --- 1. Session projection ------------------------------------------------
  ctx.sessionProjections.register({
    key: KEY,
    stateVersion: STATE_VERSION,
    stateSchema: z.object({ version: z.literal(STATE_VERSION) }).passthrough(),
    init: header => ({ ...initState(), cwd: typeof header?.cwd === 'string' ? header.cwd : null }),
    apply: (state, event) => applyEvent(state, event, config),
    wire: { viewSchema: z.any(), view: state => ({ explain: state.explain, turns: state.turns }) },
  });
  const stateOf = session => {
    try { return ctx.sessionProjections.stateOf(session, KEY) ?? initState(); } catch { return initState(); }
  };

  // Is a program installed (the PATH folders plus the usual system and user ones)? Cached per name.
  const binDirs = [...new Set([...String(process.env.PATH ?? '').split(delimiter), '/usr/sbin', '/sbin', '/snap/bin', '/var/lib/flatpak/exports/bin',
    join(homedir(), '.local', 'bin'), join(homedir(), '.cargo', 'bin')].filter(Boolean))];
  const known = new Map();
  const installed = name => {
    if (!known.has(name)) known.set(name, binDirs.some(dir => { try { accessSync(join(dir, name), fsConstants.X_OK); return true; } catch { return false; } }));
    return known.get(name);
  };
  const pathExists = p => { try { statSync(String(p).replace(/^~(?=\/|$)/, homedir())); return true; } catch { return false; } };

  // What each conversation really saw: tool arguments and FULL tool results (the projection
  // keeps only 800 characters of each). In memory only, the last ~400k characters per conversation.
  const seen = new Map();
  const SEEN_MAX = 400_000;
  const remember = (session, text) => {
    const id = session?.id; if (!id || !text) return;
    const all = `${seen.get(id) ?? ''}\n${text}`;
    seen.set(id, all.length > SEEN_MAX ? all.slice(-SEEN_MAX) : all);
  };
  ctx.on('tools/post-execute', async (exec, result, next) => {
    try {
      const text = Array.isArray(result?.content) ? result.content.map(c => (typeof c?.text === 'string' ? c.text : '')).join('\n') : String(result?.content ?? '');
      remember(exec.agent?.session, `${AUTHORED.test(exec.name ?? '') ? '' : JSON.stringify(exec.arguments ?? {})}\n${text}`);
    } catch { /* never block a tool */ }
    return next();
  });

  // --- 2. Correct before the turn closes -----------------------------------
  // What can be known before the answer is written is said while the model works:
  // every check after the answer costs a whole rewrite.
  ctx.systemPrompt.context({
    name: 'reliability-guards:answer-rules',
    order: 119,
    text: ({ agent } = {}) => {
      if (!agent?.session || config.answerRules === false) return '';
      try { const state = stateOf(agent.session); return answerRules(state.work, { waiting: state.waiting === true && config.codeWhileWaiting !== false }); } catch { return ''; }
    },
  });

  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    const state = stateOf(agent.session);
    const w = state.work;
    if (!w) return;
    // All findings go back in ONE message, so the model rewrites its answer once.
    const texts = [];
    const codes = [];
    const findings = w.nudgeCount < config.maxNudgesPerTurn ? detect(w, state, config).filter(f => NUDGED.includes(f.code) && !w.nudges[f.code]) : [];
    for (const f of findings) {
      if (f.code === 'unverifiedDoi') {
        // The harness checks existence; a network failure is never reported as an invention.
        const verdicts = await Promise.all(f.data.dois.map(async d => [d, await checkDoi(d, signal, config.doiTimeoutMs)]));
        if (!verdicts.some(([, v]) => v === 'notFound')) continue; // real but unread DOIs: warning only
        f.data.lines = verdicts.map(([d, v]) => (v === 'notFound' ? `NOT FOUND: ${d}` : v === 'found' ? `exists (not read by you): ${d}` : `not checked (network): ${d}`));
      }
      const text = nudgeText(f);
      if (text) { texts.push(text); codes.push(f.code); }
    }
    // The answer checks have their own room of 2 more messages per turn.
    if (w.nudgeCount < config.maxNudgesPerTurn + 2) {
      const extra = [
        ...checkAnswer(w, { waiting: state.waiting === true, exists: installed, seenText: seen.get(agent.session?.id) ?? '', pathExists, on: config }),
        ...(config.sourcesDenied === false ? [] : checkSources(w)),
      ].filter(f => !w.nudges[f.code]);
      for (const f of extra) { texts.push(checkNudgeText(f)); codes.push(f.code); }
    }
    if (texts.length) {
      signal.throwIfAborted();
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: groupedNudge(texts) }],
        source: { kind: SOURCE_KIND, form: 'notice', summary: `${codes.join('+')} reliability check` },
      }));
      return;
    }
    // Last, once per turn: the offline French spell check (its words travel in the nudge, so the
    // projection and the improvement center replay see the same verdict without re-running it).
    if (config.frenchSpelling && !w.nudges.frenchSpelling && !findings.length && w.nudgeCount < config.maxNudgesPerTurn) {
      const words = await misspelledFrench(spellCandidates(w, config), signal, config.spellAllow);
      if (!words.length) return;
      signal.throwIfAborted();
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: nudgeText({ code: 'frenchSpelling', data: { words: words.slice(0, 15) } }) }],
        source: { kind: SOURCE_KIND, form: 'notice', summary: 'frenchSpelling reliability check' },
      }));
    }
  });

  // --- 3. Before a tool runs -----------------------------------------------
  const expand = (p, base) => {
    const x = String(p ?? '').replace(/^~(?=\/|$)/, homedir());
    return isAbsolute(x) ? x : resolve(base ?? homedir(), x);
  };
  const isFileIn = base => p => { try { return statSync(expand(p, base)).isFile(); } catch { return false; } };

  const created = new Map(); // session id -> files that conversation created with write (in memory only)
  ctx.on('tools/pre-execute', async (exec, next) => {
    const agent = exec.agent;
    const state = agent ? stateOf(agent.session) : initState();
    const args = exec.arguments ?? {};
    const base = args.workdir ?? state.cwd ?? undefined;

    if (config.explainMode && state.explain && MODIFYING_TOOLS.test(exec.name) && !config.explainAllow.includes(exec.name)) {
      const shell = exec.name === 'bash' || exec.name === 'pwsh';
      return { kind: 'deny', reason: 'Explain mode is on (the user typed /explain): this conversation is read-only. Do not change anything; explain what you would do and why, step by step. The user can type /explain off to allow changes again.'
        + (shell ? ' The shell is closed here, even for ls or cat: list a folder with glob (path "<folder>", pattern "*"; a full path inside pattern finds nothing), open a file with read, search text with grep, then retry with that tool.' : '') };
    }

    if (exec.name === 'bash' || exec.name === 'pwsh') {
      const verdict = classifyCommand(args.command, isFileIn(base));
      if (verdict?.kind === 'tmpBackup' && config.tmpBackupDeny) {
        return { kind: 'deny', reason: 'Refused: /tmp is emptied after each command in this harness, so a backup there disappears. Put backups next to the file as name.bak-<date>, or in a backups folder in your home directory, and retry.' };
      }
      if (verdict?.kind === 'destructive' && config.destructiveAsk) {
        const vars = l => ({ why: USER_TEXT[l].why[verdict.why], detail: verdict.detail });
        return { kind: 'ask', reason: `Destructive command (${verdict.why}): ${verdict.detail}`, displayReason: { en: fill(USER_TEXT.en.destructive, vars('en')), fr: fill(USER_TEXT.fr.destructive, vars('fr')) } };
      }
    }

    if (exec.name === 'write' && config.destructiveAsk) {
      const p = args.file_path ?? args.path;
      if (p && /^\/tmp\//.test(expand(p, base)) && /(backup|sauvegard|\.bak)/i.test(String(p)) && config.tmpBackupDeny) {
        return { kind: 'deny', reason: 'Refused: /tmp is emptied after each command in this harness. Put backups next to the file as name.bak-<date>, or in a backups folder in your home directory, and retry.' };
      }
      const sid = agent?.session?.id;
      if (p && isFileIn(base)(p)) {
        const path = expand(p, base);
        // A file this same conversation created is its own draft: rewriting it needs no approval
        // (a plan step cannot ask, and small models often rewrite the file they just made).
        if (sid && created.get(sid)?.has(path)) return next();
        return { kind: 'ask', reason: `Overwrite the existing file ${path}`, displayReason: { en: fill(USER_TEXT.en.overwriteFile, { path }), fr: fill(USER_TEXT.fr.overwriteFile, { path }) } };
      }
      if (p && sid) {
        if (!created.has(sid)) created.set(sid, new Set());
        created.get(sid).add(expand(p, base));
      }
    }
    return next();
  });

  // --- 4. Skills the user invoked survive the automatic summaries -----------
  // (lib/kept-skills.js) The instructions of /science-writing, /word... are
  // re-sent, exactly as dsh-tool-skill sent them, once a summary hid them.
  const userSkill = async (name, agent, signal) => {
    try {
      const skill = await ctx.skills.get(name, { cwd: agent.session.header.cwd, signal, scope: agent });
      return skill && isUserInvocable(skill) ? skill : undefined;
    } catch { return undefined; }
  };
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next();
    if (decision.kind === 'reject' || config.keepInvokedSkills === false) return decision;
    let names;
    try { names = lostSkills(sessionEvents(agent.session), new Set(agent.session.surface.nodes), decision.messages); } catch { return decision; }
    const again = [];
    for (const name of names) {
      const skill = await userSkill(name, agent, signal);
      if (skill) again.push(createUserMessage({ content: [{ type: 'text', text: renderSkillContent(skill) }], source: { kind: 'skill-invocation', name, form: 'instructions' } }));
    }
    return again.length ? { ...decision, messages: [...decision.messages, ...again] } : decision;
  });
  // A model that still calls `skill` for one of them gets the instructions, not a refusal.
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next();
    if (config.keepInvokedSkills === false || exec.name !== 'skill' || !result?.isError || !exec.agent) return downstream;
    const name = exec.arguments?.name;
    const skill = typeof name === 'string' ? await userSkill(name, exec.agent, exec.signal) : undefined;
    if (!skill) return downstream;
    return { ...downstream, kind: 'accept', content: [{ type: 'text', text: `The user invoked this skill; its instructions follow. Follow them and do not call the skill tool for it again.\n\n${renderSkillContent(skill)}` }] };
  });
}
