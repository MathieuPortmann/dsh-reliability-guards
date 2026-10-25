// Unit tests of the pure rules: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initState, applyEvent, detect, classifyCommand, explainGesture, looksCut, doisOf, failedResult, overwriteTargets, MODIFYING_TOOLS } from '../lib/rules.js';

const ev = (type, data) => ({ type, time: 0, data });
const user = text => ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text }] });
const assistant = text => ev('assistant/message', { message: { content: [{ type: 'text', text }] } });
const call = (id, name, args = '{}') => ev('tool/call', { callId: id, name, arguments: args });
const result = (id, text, isError = false) => ev('tool/result', { message: { toolCallId: id, content: [{ type: 'text', text }], isError } });
const header = tools => ev('request/header', { header: { tools: tools.map(name => ({ name })) } });

function run(events) {
  let s = initState();
  for (const e of [ev('turn/start', { turn: 1 }), ...events]) s = applyEvent(s, e);
  return s;
}
const codes = s => detect(s.work, s).map(f => f.code);

test('falseSuccess: bash exit code 1 then "c\'est fait"', () => {
  const s = run([user('copie le fichier'), call('a', 'bash'), result('a', 'cp: impossible\n[exit code: 1]'), assistant("C'est fait, le fichier a été copié dans sauvegarde/.")]);
  assert.deepEqual(codes(s), ['falseSuccess']);
});
test('falseSuccess: recovered by a later successful call of the same tool', () => {
  const s = run([call('a', 'bash'), result('a', 'x\n[exit code: 1]'), call('b', 'bash'), result('b', 'ok\n[exit code: 0]'), assistant("C'est fait, le fichier a été copié.")]);
  assert.deepEqual(codes(s), []);
});
test('falseSuccess: an honest answer that reports the failure is not flagged', () => {
  const s = run([call('a', 'bash'), result('a', 'No such file\n[exit code: 1]'), assistant("La copie a échoué : le fichier n'existe pas. J'ai créé le dossier sauvegarde/ quand même.")]);
  assert.deepEqual(codes(s), []);
});
test('actionWithoutTool: "j\'ai vérifié" with no tool call', () => {
  const s = run([user('vérifie que le service tourne'), assistant("J'ai vérifié : le service tourne correctement.")]);
  assert.deepEqual(codes(s), ['actionWithoutTool']);
});
test('announcedOnly: "je vais copier…" and nothing done', () => {
  const s = run([user('copie le fichier'), assistant('Je vais copier le fichier rapport-final.txt vers sauvegarde/, puis je confirmerai que c’est terminé.')]);
  assert.deepEqual(codes(s), ['announcedOnly']);
  const s2 = run([user('explique git'), assistant('Git garde l’historique des fichiers. '.repeat(20) + 'Voilà, c’est l’essentiel.')]);
  assert.deepEqual(codes(s2), []);
});
test('announcedOnly: stops on ":" after some tool calls', () => {
  const s = run([call('a', 'mcp__notes__logseq_search'), result('a', 'Starship (3 pages)'), assistant('La page Starship existe plusieurs fois. Je lis chaque version pour vous donner le contenu complet :')]);
  assert.deepEqual(codes(s), ['announcedOnly']);
});
test('announcedOnly: last sentence promises an action after a tool call; offers are fine', () => {
  const s = run([call('a', 'mcp__notes__logseq_search'), result('a', '3 pages'), assistant('J’ai trouvé plusieurs pages nommées "Starship". Je vais les lire une par une pour vous montrer leur contenu.')]);
  assert.deepEqual(codes(s), ['announcedOnly']);
  const s2 = run([call('a', 'web_search'), result('a', 'x'), assistant('Il fait 12 °C à Aarhus. Si vous voulez, je vais chercher la prévision de demain.')]);
  assert.deepEqual(codes(s2), []);
  const s3 = run([user('météo ?'), assistant('Pour connaître la météo, je vais utiliser une recherche web pour obtenir les informations.')]);
  assert.deepEqual(codes(s3), ['announcedOnly']);
});
test('deniedCapability only when a fitting tool is in the request', () => {
  const s1 = run([header(['bash', 'read']), user('lis notes.md'), assistant("Je n'ai pas accès à vos fichiers.")]);
  assert.deepEqual(codes(s1), ['deniedCapability']);
  const s2 = run([header(['skill']), user('lis notes.md'), assistant("Je n'ai pas accès à vos fichiers.")]);
  assert.deepEqual(codes(s2), []);
});
test('unverifiedDoi: DOI absent from tool results; evidence from tools or user is accepted', () => {
  const s1 = run([assistant('Voir Barnas (2020), DOI 10.1111/2041-2656.139028.')]);
  assert.deepEqual(codes(s1), ['unverifiedDoi']);
  const s2 = run([call('a', 'zotero_item'), result('a', 'DOI: 10.1111/2041-210X.13904'), assistant('Kline (2025), doi 10.1111/2041-210X.13904.')]);
  assert.deepEqual(codes(s2), []);
  const s3 = run([user('résume 10.1038/nature12345'), assistant('Le DOI 10.1038/nature12345 décrit…')]);
  assert.deepEqual(codes(s3), []);
});
test('foreignScript: Chinese characters the user did not write', () => {
  const s = run([user('explique'), assistant('Le lien 指向 le fichier.')]);
  assert.deepEqual(codes(s), ['foreignScript']);
});
test('cutAnswer: long answer ending mid-sentence; lists and full stops are fine', () => {
  const long = 'Voici la recette complète pour un repas protéiné et équilibré, adaptée à vos besoins. '.repeat(3);
  assert.equal(looksCut(`${long}Ajoutez ensuite 4 œufs et la farine de`), true);
  assert.equal(looksCut(`${long}Voici les étapes :`), true);
  assert.equal(looksCut(`${long}\n- œufs`), false);
  assert.equal(looksCut(`${long}Bon appétit.`), false);
  assert.equal(looksCut('court'), false);
  assert.equal(looksCut(`${long}\n\`\`\`bash\nls`), true);
});
test('markupLeak: tool call written as text', () => {
  const s = run([user('teste'), assistant('Je lance le test.\n<tool_call>\n<function=runtime_health>\n</function>\n</tool_call>')]);
  assert.deepEqual(codes(s), ['markupLeak']);
  const s2 = run([assistant('```shell\nmcp__web__search "GNOME 49"\n```')]);
  assert.deepEqual(codes(s2), ['markupLeak']);
});
test('no finding when the last message still calls tools, or answer is empty', () => {
  const s = run([assistant('')]);
  assert.deepEqual(codes(s), []);
});
test('nudge memory: own steering messages are counted per code and turn/end records outcomes', () => {
  let s = run([call('a', 'bash'), result('a', 'x\n[exit code: 2]'), assistant("C'est fait.")]);
  s = applyEvent(s, ev('user/message', { source: { kind: 'reliability-guard', form: 'notice', summary: 'falseSuccess reliability check' }, content: [{ type: 'text', text: 'Reliability check' }] }));
  assert.equal(s.work.nudges.falseSuccess, true);
  s = applyEvent(s, assistant('La commande a échoué (code 2) : rien n’a été copié.'));
  s = applyEvent(s, ev('turn/end', { turn: 1 }));
  assert.deepEqual(s.turns.at(-1).findings, [{ code: 'falseSuccess', action: 'corrected', detail: '' }]);
});
test('NOT FOUND verdicts carried by a nudge are remembered', () => {
  let s = run([assistant('DOI 10.9999/fake.1')]);
  s = applyEvent(s, ev('user/message', { source: { kind: 'reliability-guard', summary: 'unverifiedDoi reliability check' }, content: [{ type: 'text', text: 'NOT FOUND: 10.9999/fake.1' }] }));
  assert.equal(s.work.verified['10.9999/fake.1'], 'notFound');
});
test('classifyCommand', () => {
  const isFile = p => ['notes.md', '/home/m/a.txt'].includes(p);
  assert.equal(classifyCommand('rm -rf /home/m/themes/*', isFile)?.why, 'delete');
  assert.equal(classifyCommand('ls && rm notes.md', isFile)?.why, 'delete');
  assert.equal(classifyCommand('find . -name "*.log" -delete', isFile)?.why, 'delete');
  assert.equal(classifyCommand('mv a b', isFile)?.why, 'move');
  assert.equal(classifyCommand('git reset --hard HEAD~1', isFile)?.why, 'git');
  assert.equal(classifyCommand('echo hi > notes.md', isFile)?.why, 'overwrite');
  assert.equal(classifyCommand('echo hi >> notes.md', isFile), null);
  assert.equal(classifyCommand('echo hi > new.md', isFile), null);
  assert.equal(classifyCommand('ls 2>/dev/null', isFile), null);
  assert.equal(classifyCommand('cp x.txt /home/m/a.txt', isFile)?.why, 'overwrite');
  assert.equal(classifyCommand('cp x.txt y.txt', isFile), null);
  assert.equal(classifyCommand('cp -r projet /tmp/projet-backup', isFile)?.kind, 'tmpBackup');
  assert.equal(classifyCommand('grep -r "rm" .', isFile), null);
  assert.equal(classifyCommand('cat /tmp/x.log', isFile), null);
  assert.equal(classifyCommand('python3 -c "import os"', isFile), null);
});
test('overwriteTargets', () => {
  assert.deepEqual(overwriteTargets('a > "my file.txt"; b 2> err.log; c &> x; d >> y'), ['my file.txt']);
});
test('explain gesture', () => {
  assert.equal(explainGesture('/explain comment marche git ?'), true);
  assert.equal(explainGesture('ok /explain off'), false);
  assert.equal(explainGesture('voir ~/explain/file'), undefined);
  let s = run([user('/explain')]);
  assert.equal(s.explain, true);
  s = applyEvent(s, user('/explain off'));
  assert.equal(s.explain, false);
  assert.ok(MODIFYING_TOOLS.test('bash') && MODIFYING_TOOLS.test('logseq_add_task') && !MODIFYING_TOOLS.test('read'));
});
test('helpers', () => {
  assert.deepEqual(doisOf('x 10.1016/0304-3762(82)90187-0. et (10.1/abc.def)'), ['10.1016/0304-3762(82)90187-0']);
  assert.equal(failedResult({ isError: false, text: 'ok\n[exit code: 0]' }), false);
  assert.equal(failedResult({ isError: false, text: 'x\n[exit code: 127]' }), true);
});
test('a search run by the harness (Web chip) counts as a read and as DOI evidence', () => {
  const auto = ev('user/message', { source: { kind: 'web-toggle', summary: 'automatic web search: logseq' }, content: [{ type: 'text', text: '<automatic_web_search>[1] Paper https://doi.org/10.1234/abcd.5678</automatic_web_search>' }] });
  const s = run([user('quelle version ?'), auto, assistant("J'ai vérifié sur le web : la version 2.0.2 (doi 10.1234/abcd.5678).")]);
  assert.deepEqual(codes(s), []);
});

// --- emojis and French spelling ---------------------------------------------
import { spellCandidates, isFrench, nudgeText } from '../lib/rules.js';
import { misspelledFrench } from '../lib/spell.js';

test('emoji: flagged when the user wrote none, plain check marks allowed', () => {
  const st = { tools: [] };
  assert.deepEqual(detect({ finalText: 'Voici la liste 🐴 des chevaux.', userText: 'liste', calls: [], nudges: {} }, st).map(f => f.code), ['emoji']);
  assert.deepEqual(detect({ finalText: '| A | ✓ |\n| B | ✗ | → suite', userText: 'tableau', calls: [], nudges: {} }, st).map(f => f.code), []);
  assert.deepEqual(detect({ finalText: 'Oui 😀', userText: 'tu aimes 😀 ?', calls: [], nudges: {} }, st).map(f => f.code), []);
});

test('French spelling: candidates skip code, paths, names, user words and allowed terms', () => {
  const w = { finalText: 'Les poulinottes ont été menées au pré avec les juments. Le drone est utile pour la recherche sur le localhost dans une réserve, avec des chevaux que nous suivons et que Marie observe. Voir `qwenfoo` et /home/x/fichierbizarre.md aujourd’hui.', userText: 'résume', calls: [] };
  assert.ok(isFrench(w.finalText));
  const c = spellCandidates(w);
  assert.ok(c.includes('poulinottes'));
  for (const x of ['qwenfoo', 'fichierbizarre', 'localhost', 'marie', 'aujourd']) assert.ok(!c.includes(x), x);
  assert.deepEqual(spellCandidates({ finalText: 'The horses are in the field and the drone is flying over them for the study.', calls: [] }), []);
});

test('French spelling: the words recorded in the nudge are warned only while still present', () => {
  const st = { tools: [] };
  const w = { finalText: 'Les juments ont été mennée au pré.', userText: '', calls: [], nudges: { frenchSpelling: true }, misspelled: ['mennée'] };
  assert.deepEqual(detect(w, st).map(f => f.code), ['frenchSpelling']);
  assert.deepEqual(detect({ ...w, finalText: 'Les juments ont été menées au pré.' }, st).map(f => f.code), []);
});

test('French spelling: the nudge carries its words back into the projection', () => {
  let s = initState();
  s = applyEvent(s, { type: 'turn/start', data: { turn: 1 } });
  s = applyEvent(s, { type: 'user/message', data: { source: { kind: 'reliability-guard', summary: 'frenchSpelling reliability check' }, content: [{ type: 'text', text: nudgeText({ code: 'frenchSpelling', data: { words: ['mennée', 'fonctione'] } }) }] } });
  assert.deepEqual(s.work.misspelled, ['mennée', 'fonctione']);
});

test('French spelling: offline dictionary finds invented words, keeps English terms', async () => {
  const bad = await misspelledFrench(['poulinottes', 'juments', 'fonctione', 'benchmark', 'menées']);
  assert.deepEqual(bad, ['poulinottes', 'fonctione']);
});
