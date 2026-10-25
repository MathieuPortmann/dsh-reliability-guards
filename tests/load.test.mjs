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
const reg = { projections: [], listeners: {} };
const ctx = {
  sessionProjections: { register: d => { reg.projections.push(d); return () => {}; }, stateOf: () => state },
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
console.log('load test ok');
