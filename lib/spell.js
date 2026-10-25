// Offline French spell check for dsh-reliability-guards, using the `enchant-2`
// program (hunspell dictionaries). No shell, no network, no dependency.
// A word is reported only if neither the French nor the English dictionary
// knows it: English technical terms are common in answers written in French.
import { execFile } from 'node:child_process';

const LIMIT_MS = 5000;

/** Run `enchant-2 -d <dict> -l`: the words it does not know, or null when the check cannot run. */
function unknownWords(dict, words, signal) {
  if (!words.length) return Promise.resolve([]);
  return new Promise(resolve => {
    let child;
    try {
      child = execFile('enchant-2', ['-d', dict, '-l'], { timeout: LIMIT_MS, signal, maxBuffer: 1 << 24, encoding: 'utf8' }, (err, stdout) => {
        const out = String(stdout ?? '');
        // Program missing, timed out, aborted, or dictionary missing (non-zero exit, nothing printed): skip.
        if (err && (typeof err.code !== 'number' || !out.trim())) return resolve(null);
        resolve(out.split('\n').map(l => l.trim()).filter(Boolean));
      });
    } catch {
      return resolve(null);
    }
    child.stdin?.on('error', () => {}); // the program may exit before reading everything
    child.stdin?.end(words.join('\n'));
  });
}

/**
 * Words that are neither French nor English, in their order of appearance,
 * without duplicates. [] when unsure (enchant-2 or a dictionary is missing).
 * @param {string[]} words lower-case candidate words
 * @param {AbortSignal} [signal]
 * @param {string[]} [allow] extra words to accept
 */
export async function misspelledFrench(words, signal, allow = []) {
  signal?.throwIfAborted?.();
  const ok = new Set((allow ?? []).map(w => String(w).toLowerCase()));
  const list = words.map(String).filter(w => !ok.has(w.toLowerCase()));
  const fr = await unknownWords('fr', list, signal);
  if (!fr?.length) return [];
  // "en_US" is the dictionary name most installs have; plain "en" is the fallback.
  const en = (await unknownWords('en_US', fr, signal)) ?? (await unknownWords('en', fr, signal));
  if (!en) return [];
  const unknown = new Set(en);
  const out = [];
  for (const w of list) if (unknown.has(w) && !out.includes(w)) out.push(w);
  return out;
}
