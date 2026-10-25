// Unit tests of lib/kept-skills.js: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lostSkills, sessionEvents, MAX_KEPT_SKILLS } from '../lib/kept-skills.js';

const skill = (seq, name) => ({ seq, type: 'user/message', data: { source: { kind: 'skill-invocation', name, form: 'instructions' } } });
const user = seq => ({ seq, type: 'user/message', data: { source: { kind: 'user' } } });

test('a skill hidden by a summary is lost; a visible one is not', () => {
  const events = [user(10), skill(14, 'science-writing'), skill(15, 'word'), { seq: 60, type: 'compaction/end', data: {} }];
  assert.deepEqual(lostSkills(events, new Set([60])), ['word', 'science-writing']);
  assert.deepEqual(lostSkills(events, new Set([14, 15, 60])), []);
});
test('re-sent once: the new injection is visible, so nothing is lost any more', () => {
  const events = [skill(14, 'word'), skill(61, 'word')];
  assert.deepEqual(lostSkills(events, new Set([61])), []);
});
test('not twice in the same step, and at most the most recent ones', () => {
  const pending = [{ source: { kind: 'skill-invocation', name: 'word' } }];
  assert.deepEqual(lostSkills([skill(1, 'word')], new Set(), pending), []);
  const many = Array.from({ length: 6 }, (_, i) => skill(i, `s${i}`));
  assert.deepEqual(lostSkills(many, new Set()), ['s5', 's4', 's3', 's2'].slice(0, MAX_KEPT_SKILLS));
});
test('other messages and malformed events are ignored', () => {
  assert.deepEqual(lostSkills([user(1), null, { type: 'user/message' }, { seq: 3, type: 'user/message', data: { source: { kind: 'skill-invocation', name: 'x', form: 'catalog' } } }], new Set()), []);
});
test('sessionEvents reads a live session oldest first', () => {
  const evs = [skill(0, 'a'), skill(1, 'b')];
  assert.deepEqual(sessionEvents({ seq: 2, eventAt: i => evs[i] }), evs);
});
