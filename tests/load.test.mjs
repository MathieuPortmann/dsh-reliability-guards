// Loads the Host half with a fake Cordis context and checks the guards end to end
// (projection fold -> turn-stopping steer, pre-execute decisions).
import assert from 'node:assert/strict';
import { realpathSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
// index.js imports its libraries from the dsh installation: skip when dsh is not installed.
let dshBin;
try { dshBin = realpathSync(execFileSync('which', ['dsh']).toString().trim()); } catch { /* dsh not installed */ }
if (!dshBin) { console.log('skipped: dsh CLI not found on PATH'); process.exit(0); }
process.argv[1] = dshBin;
const mod = await import('../index.js');
const { initState, applyEvent } = await import('../lib/rules.js');

const dir = mkdtempSync(join(tmpdir(), 'rg-'));
writeFileSync(join(dir, 'existing.md'), 'x');
let state = { ...initState(), cwd: dir };
const reg = { projections: [], contexts: [], listeners: {} };
const ctx = {
  sessionProjections: { register: d => { reg.projections.push(d); return () => {}; }, stateOf: () => state },
  systemPrompt: { context: c => { reg.contexts.push(c); return () => {}; } },
  tools: { register: () => () => {} },
  on: (name, fn) => { (reg.listeners[name] ??= []).push(fn); return () => {}; },
};
mod.apply(ctx, mod.Config({}));
assert.equal(mod.name, 'reliability-guards');
assert.equal(reg.projections[0].key, 'reliabilityGuards');
for (const ev of ['agent/turn-stopping', 'tools/pre-execute']) assert.ok(reg.listeners[ev], ev);

const ev = (type, data) => ({ type, time: 0, data });
const fold = events => { for (const e of events) state = applyEvent(state, e); };
fold([ev('turn/start', { turn: 1 }),
  ev('tool/call', { callId: 'a', name: 'bash', arguments: '{}' }),
  ev('tool/result', { message: { toolCallId: 'a', content: [{ type: 'text', text: 'No such file\n[exit code: 1]' }] } }),
  ev('assistant/message', { message: { content: [{ type: 'text', text: "C'est fait." }] } })]);

// turn-stopping: one steering message with the failure.
const steered = [];
const agent = { session: {}, steer: m => steered.push(m) };
await reg.listeners['agent/turn-stopping'][0]({ agent, turn: 1, signal: new AbortController().signal });
assert.equal(steered.length, 1);
assert.equal(steered[0].source.kind, 'reliability-guard');
assert.match(steered[0].content[0].text, /exit code: 1/);
// The steer is recorded in the log; the next stop boundary does not nudge the same code again.
fold([ev('user/message', { source: steered[0].source, content: steered[0].content })]);
await reg.listeners['agent/turn-stopping'][0]({ agent, turn: 1, signal: new AbortController().signal });
assert.equal(steered.length, 1, 'no second nudge for the same code');

// pre-execute decisions
const pre = reg.listeners['tools/pre-execute'][0];
const next = async () => ({ kind: 'accept' });
const d1 = await pre({ agent, name: 'bash', arguments: { command: 'rm -rf old/' } }, next);
assert.equal(d1.kind, 'ask'); assert.match(d1.displayReason.fr, /supprime/);
const d2 = await pre({ agent, name: 'bash', arguments: { command: 'cp notes.md /tmp/notes-backup.md' } }, next);
assert.equal(d2.kind, 'deny'); assert.match(d2.reason, /name\.bak-<date>/);
const d3 = await pre({ agent, name: 'write', arguments: { file_path: join(dir, 'existing.md'), content: 'y' } }, next);
assert.equal(d3.kind, 'ask');
const d4 = await pre({ agent, name: 'write', arguments: { file_path: join(dir, 'new.md'), content: 'y' } }, next);
assert.equal(d4.kind, 'accept');
const d5 = await pre({ agent, name: 'bash', arguments: { command: 'ls -la' } }, next);
assert.equal(d5.kind, 'accept');
fold([ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '/explain why?' }] })]);
const d6 = await pre({ agent, name: 'bash', arguments: { command: 'ls' } }, next);
assert.equal(d6.kind, 'deny'); assert.match(d6.reason, /Explain mode/);
const d7 = await pre({ agent, name: 'read', arguments: { file_path: 'x' } }, next);
assert.equal(d7.kind, 'accept');

// Answer checks: the wait is said before the answer, findings go back in one grouped message.
fold([ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '/explain off' }] }),
  ev('turn/start', { turn: 2 }),
  ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'Explain your approach and wait for my approval.' }] })]);
const rules = reg.contexts.find(c => c.name === 'reliability-guards:answer-rules');
assert.match(rules.text({ agent }), /no code block/);
fold([ev('assistant/message', { message: { content: [{ type: 'text', text: 'Step 1:\n```bash\nzz-invented-tool --apply\n```' }] } })]);
await reg.listeners['agent/turn-stopping'][0]({ agent, turn: 2, signal: new AbortController().signal });
assert.equal(steered.length, 2);
assert.equal(steered[1].source.summary, 'codeWhileWaiting reliability check');
fold([ev('user/message', { source: steered[1].source, content: steered[1].content }),
  ev('turn/end', {}),
  ev('turn/start', { turn: 3 }),
  ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'Go ahead.' }] }),
  ev('tool/call', { callId: 'b', name: 'web_read', arguments: '{"url":"https://example.org/page"}' }),
  ev('tool/result', { message: { toolCallId: 'b', content: [{ type: 'text', text: 'Page text' }] } }),
  ev('assistant/message', { message: { content: [{ type: 'text', text: 'Run:\n```bash\nzz-invented-tool --apply\n```\nNo external sources were used.' }] } })]);
assert.equal(state.waiting, false);
await reg.listeners['agent/turn-stopping'][0]({ agent, turn: 3, signal: new AbortController().signal });
assert.equal(steered.length, 3);
assert.equal(steered[2].source.summary, 'unknownCommand+sourcesDenied reliability check');
assert.match(steered[2].content[0].text, /found 2 problems[\s\S]*zz-invented-tool[\s\S]*example\.org/);
fold([ev('user/message', { source: steered[2].source, content: steered[2].content })]);
assert.equal(state.work.nudges.unknownCommand && state.work.nudges.sourcesDenied, true);
console.log('load test ok');
