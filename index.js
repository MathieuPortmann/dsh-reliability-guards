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
 *   3. User-invoked skills (/word, /science-writing...) survive the automatic
 *      summaries: their instructions are re-sent once a summary hid them.
 *
 * Constraints: no shell, no file writes, network only for DOI existence
 * checks (OpenAlex, Crossref). The optional French spell check runs the local
 * `enchant-2` program (hunspell dictionaries, offline) without a shell; if it
 * is missing the check is skipped. Every registration is a Cordis effect, so
 * removing the bundle removes all of it.
 */
import { createRequire } from 'node:module';
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULTS, STATE_VERSION, SOURCE_KIND, MODIFYING_TOOLS, USER_TEXT,
  initState, applyEvent, detect, nudgeText, classifyCommand, fill, spellCandidates,
} from './lib/rules.js';
import { checkDoi } from './lib/doi.js';
import { misspelledFrench } from './lib/spell.js';
import { lostSkills, sessionEvents } from './lib/kept-skills.js';

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
export const inject = ['sessionProjections', 'tools', 'skills'];

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

  // --- 2. Correct before the turn closes -----------------------------------
  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    const state = stateOf(agent.session);
    const w = state.work;
    if (!w || w.nudgeCount >= config.maxNudgesPerTurn) return;
    const findings = detect(w, state, config).filter(f => NUDGED.includes(f.code) && !w.nudges[f.code]);
    for (const f of findings) {
      if (f.code === 'unverifiedDoi') {
        // The harness checks existence; a network failure is never reported as an invention.
        const verdicts = await Promise.all(f.data.dois.map(async d => [d, await checkDoi(d, signal, config.doiTimeoutMs)]));
        if (!verdicts.some(([, v]) => v === 'notFound')) continue; // real but unread DOIs: warning only
        f.data.lines = verdicts.map(([d, v]) => (v === 'notFound' ? `NOT FOUND: ${d}` : v === 'found' ? `exists (not read by you): ${d}` : `not checked (network): ${d}`));
      }
      const text = nudgeText(f);
      if (!text) continue;
      signal.throwIfAborted();
      agent.steer(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: SOURCE_KIND, form: 'notice', summary: `${f.code} reliability check` },
      }));
      return; // one finding at a time; the next stop boundary looks again
    }
    // Last, once per turn: the offline French spell check (its words travel in the nudge, so the
    // projection and the improvement center replay see the same verdict without re-running it).
    if (config.frenchSpelling && !w.nudges.frenchSpelling && !findings.length) {
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
