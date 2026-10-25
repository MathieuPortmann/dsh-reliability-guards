// DOI existence check done by the harness (not by the model): OpenAlex, then Crossref.
// Same requests as the doi_verify tool of the dsh-research-agents bundle,
// kept separate so this bundle works without that one.
const OPENALEX = 'https://api.openalex.org';

async function getJson(url, signal, timeoutMs) {
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(timeoutMs)]) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${new URL(url).host} answered HTTP ${res.status}`);
  return res.json();
}

/**
 * 'found' | 'notFound' | 'unknown' (network error: never reported as invented).
 * @param {string} doi
 */
export async function checkDoi(doi, signal, timeoutMs = 15_000) {
  try {
    if (await getJson(`${OPENALEX}/works/doi:${encodeURIComponent(doi)}`, signal, timeoutMs)) return 'found';
    const c = await getJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, signal, timeoutMs);
    return c?.message ? 'found' : 'notFound';
  } catch {
    return 'unknown';
  }
}
