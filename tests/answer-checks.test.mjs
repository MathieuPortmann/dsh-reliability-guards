import test from 'node:test';
import assert from 'node:assert/strict';
import {
  codeBlocks, commandsOf, checkAnswer, checkNudgeText, nextWaiting, isHold, isGo, identifiersOf, untestedNames, requirementsOf,
  installedBy, checkSources, inlineCommands, AUTHORED, shellMistakes, answerRules, groupedNudge,
} from '../lib/answer-checks.js';
import { initState, applyEvent, detect, isProbe, SOURCE_KIND } from '../lib/rules.js';

const answer = [
  'Approach:',
  '```',
  'zsh-theme-colors -t green -c light \\',
  '  --colors "background: F3EAD3 / EAE4CA" \\',
  '  -n "Orchis-EverForest-Light"',
  '```',
  '```bash',
  '# Light mode',
  'flatpak override --env=GTK_THEME=Orchis-EverForest-Light',
  'sudo apt install -y sassc && cd ~/themes/sources | grep x',
  '```',
  '```scss',
  '$green-dark: #A7C080;',
  '```',
].join('\n');
const installed = new Set(['flatpak', 'apt', 'grep', 'gsettings']);
const exists = n => installed.has(n);

test('code blocks and the programs that start their commands', () => {
  assert.deepEqual(codeBlocks(answer).map(b => b.lang), ['', 'bash', 'scss']);
  assert.deepEqual(commandsOf(codeBlocks(answer)[0].body), ['zsh-theme-colors']);
  assert.deepEqual(commandsOf(codeBlocks(answer)[1].body), ['flatpak', 'apt', 'grep']); // sudo, cd and comments skipped
  assert.deepEqual(commandsOf('$ ls -la\nFOO=1 make install\nfor f in *; do echo $f; done'), ['ls', 'make']);
  // Text or code in an unlabelled block is not a command.
  assert.deepEqual(commandsOf('Drone survey\n3- No\nOption A\ntitle_pattern = re.compile(x)\nprint(x)\nkey: value'), []);
});

test('unknownCommand: an invented command is reported, installed or seen ones are not', () => {
  const f = checkAnswer({ finalText: answer, calls: [], userText: '' }, { exists });
  assert.deepEqual(f.map(x => x.code), ['unknownCommand']);
  assert.deepEqual(f[0].data.names, ['zsh-theme-colors']);
  assert.match(checkNudgeText(f[0]), /zsh-theme-colors.*untested/s);
  const seen = { finalText: answer, userText: '', calls: [{ args: '{}', result: { text: 'usage: zsh-theme-colors [-t]; themes: Orchis-EverForest-Light' } }] };
  assert.deepEqual(checkAnswer(seen, { exists }), []);
  assert.deepEqual(checkAnswer({ finalText: '```bash\n./install.sh -t green\n```', calls: [] }, { exists }), []);
  assert.deepEqual(checkAnswer({ finalText: answer, calls: [] }, { exists, on: { unknownCommand: false } }), []);
});

test('a program the answer installs itself is not unknown', () => {
  const a = '```bash\nsudo apt install dconf-editor\ndconf-editor\n```';
  assert.ok(installedBy(a).has('dconf-editor'));
  assert.ok(installedBy('flatpak install flathub ca.desrt.dconf-editor').has('dconf-editor'));
  assert.deepEqual(checkAnswer({ finalText: a, calls: [], userText: '' }, { exists: n => n === 'apt' }), []);
});

test('codeWhileWaiting: while the user waits, any code block is reported first', () => {
  const f = checkAnswer({ finalText: answer, calls: [] }, { waiting: true, exists });
  assert.deepEqual(f.map(x => x.code), ['codeWhileWaiting']);
  assert.match(checkNudgeText(f[0]), /words only/);
  assert.deepEqual(checkAnswer({ finalText: 'Step 1: change the palette.', calls: [] }, { waiting: true, exists }), []);
});

test('the wait starts with a "wait for my approval" message and ends with the go-ahead (French and English)', () => {
  let w = nextWaiting(false, 'Explique la démarche. Attends ma validation avant toute action.');
  assert.equal(w, true);
  w = nextWaiting(w, '1. medium 2. no snap. Read the service without changing it.');
  assert.equal(w, true);
  w = nextWaiting(w, 'Je valide, vas-y.');
  assert.equal(w, false);
  assert.ok(isHold('Please only explain, wait for my approval.'));
  assert.ok(isGo('OK, go ahead.'));
  assert.ok(!isHold('Install it please.'));
  // The projection keeps the wait from message to message.
  let s = initState();
  const user = text => ({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } });
  s = applyEvent(s, user('Do not change anything yet, wait for my approval.'));
  assert.equal(s.waiting, true);
  s = applyEvent(s, user('Answer: the light theme.'));
  assert.equal(s.waiting, true);
  s = applyEvent(s, user('Approved, proceed.'));
  assert.equal(s.waiting, false);
});

test('untestedCommand: a key the tools never showed is flagged, a seen one is not', () => {
  const blocks = codeBlocks('```bash\ngsettings set org.gnome.shell.extensions.blur-my-shell panel-blur true\ndconf read /org/x/panel/blur\n```');
  const seen = '<schema id="org.gnome.shell.extensions.blur-my-shell"> /org/x/panel/blur';
  assert.deepEqual(untestedNames(blocks, seen), ['panel-blur']);
});

test('untestedCommand: install lines, marked lines, options and existing paths pass', () => {
  const blocks = codeBlocks('```bash\nsudo apt install dconf-editor\nfoo-bar --some-option x.y-z # untested\nbaz-qux a.b-c # non testé\nls ~/.bashrc\n```');
  assert.deepEqual(untestedNames(blocks, '', p => p === '~/.bashrc'), []);
  assert.deepEqual(identifiersOf('gsettings --schemadir /a/b get my.schema key'), ['/a/b', 'my.schema']);
  assert.deepEqual(identifiersOf('theme-tool -n My-New_Theme apply'), []); // a name the command creates
});

test('untestedCommand: only after a turn that used tools', () => {
  const work = { finalText: '```bash\ndconf write /org/a/b-c true\n```', calls: [] };
  assert.deepEqual(checkAnswer(work), []);
  assert.equal(checkAnswer({ ...work, calls: [{}] })[0].code, 'untestedCommand');
  assert.deepEqual(checkAnswer({ ...work, calls: [{}] }, { on: { untestedCommand: false } }), []);
});

test('a settings path made of a seen folder and a seen key is confirmed', () => {
  const seen = '<schema path="/org/gnome/shell/extensions/blur-my-shell/overview/"> <key name="blur" type="b">';
  const b = [{ lang: 'bash', body: 'dconf read /org/gnome/shell/extensions/blur-my-shell/overview/blur\ndconf read /org/gnome/shell/extensions/blur-my-shell/overview/panel-blur' }];
  assert.deepEqual(untestedNames(b, seen), ['/org/gnome/shell/extensions/blur-my-shell/overview/panel-blur']);
});

test('inline commands: a program with options, options alone; marked or plain code ignored', () => {
  const t = 'Run `./install.sh -n Orchis -t green` then `install.sh` with `-t everforest -c medium -p light/dark`, '
    + 'or `gsettings get a.b c` and `dconf write /x 1`; `foo -x bar` (untested); `bg0=#2D353B`.';
  assert.deepEqual(inlineCommands(t, n => n === 'dconf'), ['./install.sh -n Orchis -t green', 'options -t everforest -c medium -p light/dark']);
});

test('an invented option value is untested even if the model wrote it in its own proposal', () => {
  const work = {
    finalText: 'Step b: pass the arguments `-t everforest -c medium -p light/dark -s dark/light`.',
    userText: 'Wait for my approval.',
    calls: [{ name: 'notes_propose', args: '{"content":"install.sh -p light/dark -s dark/light"}', result: { isError: true, text: 'REFUSED' } },
      { name: 'read', args: '{"path":"README"}', result: { isError: false, text: './install.sh -c light dark' } }],
  };
  const f = checkAnswer(work, { waiting: true });
  assert.equal(f[0].code, 'untestedCommand');
  assert.deepEqual(f[0].data.names, ['light/dark', 'dark/light']);
  assert.ok(AUTHORED.test('notes_propose') && AUTHORED.test('step_done') && AUTHORED.test('write') && !AUTHORED.test('read'));
});

test('shellMistake: dconf keys never end with "/", dump and list take a folder', () => {
  const b = [{ lang: 'bash', body: 'dconf read /org/gnome/shell/extensions/blur-my-shell/\ndconf dump /org/gnome/shell/extensions/blur-my-shell/\ndconf reset -f /org/a/\ndconf dump /org/a' }];
  const issues = shellMistakes(b);
  assert.equal(issues.length, 2, issues.join('\n'));
  assert.match(issues[0], /dconf read .*never ends/);
  assert.match(issues[1], /dconf dump \/org\/a:/);
  const work = { finalText: '```bash\ndconf read /org/gnome/shell/extensions/blur-my-shell/\n```', calls: [{ name: 'bash', args: 'dconf', result: { text: '/org/gnome/shell/extensions/blur-my-shell/' } }] };
  assert.equal(checkAnswer(work)[0]?.code, 'shellMistake');
  assert.match(checkNudgeText(checkAnswer(work)[0]), /never ends with/);
});

test('sourcesDenied: web pages read, then "no source used"', () => {
  const calls = [{ name: 'web_read', args: '{"url":"https://askubuntu.com/questions/1554116/x"}', result: { isError: false, text: 'Page: x' } }];
  const lie = 'Answer…\n\n## Sources\n\nNo external sources were consulted for this answer.';
  const f = checkSources({ finalText: lie, calls });
  assert.deepEqual(f.map(x => x.code), ['sourcesDenied']);
  assert.deepEqual(f[0].data.urls, ['https://askubuntu.com/questions/1554116/x']);
  assert.match(checkNudgeText(f[0]), /askubuntu/);
  assert.equal(checkSources({ finalText: 'Réponse.\n\nSources :\n\nAucune source externe n\'a été consultée.', calls }).length, 1);
  assert.deepEqual(checkSources({ finalText: 'Answer.\n\nSources:\n- X: https://askubuntu.com/questions/1554116/x', calls }), []);
  assert.deepEqual(checkSources({ finalText: lie, calls: [] }), []);
  const auto = [{ id: 'auto-web-0', name: 'web_search', args: '(automatic search by the harness)', result: { isError: false, text: 'https://x.org' } }];
  assert.deepEqual(checkSources({ finalText: lie, calls: auto }), []);
});

test('answer rules: demands, wait, Sources, dconf syntax, names from tool results', () => {
  assert.deepEqual(requirementsOf('Tell me about Blur my Shell. Explicitly check the installed version of the extension.'),
    ['Explicitly check the installed version of the extension.']);
  assert.deepEqual(requirementsOf('Vérifie explicitement la version installée.'), ['Vérifie explicitement la version installée.']);
  const w = { userText: 'Make sure you check the installed version before giving the commands.', calls: [
    { name: 'bash', args: 'dconf list /org/gnome/shell/extensions/blur-my-shell/', result: { text: 'x' } },
    { name: 'web_read', args: '{"url":"https://example.org/a"}', result: { isError: false, text: 'page' } }] };
  const rules = answerRules(w);
  assert.match(rules, /explicit demand[\s\S]*Make sure/);
  assert.match(rules, /"Sources" section.*https:\/\/example\.org\/a/);
  assert.match(rules, /never ending with "\/"/);
  assert.match(rules, /# untested/);
  assert.match(answerRules({ userText: 'x', calls: [] }, { waiting: true }), /no code block/);
  assert.equal(answerRules({ userText: 'hello', calls: [] }), '');
  assert.equal(answerRules(null), '');
});

test('several findings go back as one message, and the projection marks each one as sent', () => {
  const g = groupedNudge(['Problem A. Rewrite your whole answer. Do not mention this reminder.', 'Problem B. Then rewrite your whole answer again, complete.']);
  assert.match(g, /found 2 problems/);
  assert.doesNotMatch(g.split('\n\n').slice(1).join(), /rewrite your whole/i);
  assert.equal(groupedNudge(['only one']), 'only one');
  let s = initState();
  s = applyEvent(s, { type: 'turn/start', data: { turn: 1 } });
  s = applyEvent(s, { type: 'user/message', data: { content: [{ type: 'text', text: 'x' }], source: { kind: SOURCE_KIND, summary: 'untestedCommand+shellMistake reliability check' } } });
  assert.equal(s.work.nudges.untestedCommand, true);
  assert.equal(s.work.nudges.shellMistake, true);
  assert.equal(s.work.nudgeCount, 1);
});

test('probe shell commands are not task steps (falseSuccess)', () => {
  assert.ok(isProbe('which web_read web_search 2>/dev/null; compgen -b web_read 2>/dev/null; type web_read 2>&1'));
  assert.ok(isProbe('command -v dconf'));
  assert.ok(!isProbe('type x && dconf write /a 1'));
  assert.ok(!isProbe(''));
  const probe = { name: 'bash', args: '{"command":"type web_read"}', result: { isError: false, text: 'not found\n[exit code: 1]' } };
  const work = { finalText: "C'est fait.", calls: [probe], finalHasCalls: false };
  assert.deepEqual(detect(work, initState()).filter(f => f.code === 'falseSuccess'), []);
  const real = { ...probe, args: '{"command":"make install"}' };
  assert.equal(detect({ ...work, calls: [real] }, initState()).filter(f => f.code === 'falseSuccess').length, 1);
});
