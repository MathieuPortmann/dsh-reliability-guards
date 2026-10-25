/**
 * Skills the user invoked (`/science-writing`, `/word`...) whose instructions
 * the model no longer sees.
 *
 * dsh-tool-skill injects a user-invoked skill once, on the step of the user
 * message (a `user/message` event with source kind `skill-invocation`). An
 * automatic summary (compaction) then hides that message from the model, and
 * since such skills refuse model invocation, the `skill` tool cannot bring them
 * back (observed: after three summaries, "not available for model
 * invocation" errors and a lost style). Pure: reads events, returns names.
 */

/** Most skills re-sent at once (the most recently invoked). */
export const MAX_KEPT_SKILLS = 4;

/**
 * @param events - the session events, oldest first ({seq, type, data}).
 * @param visible - seqs the model still sees (agent.session.surface.nodes).
 * @param pending - messages already in this step (not re-sent twice).
 * @returns names of invoked skills whose last injection is not visible, most recent first.
 */
export function lostSkills(events, visible, pending = []) {
  const last = new Map();
  for (const e of events) {
    if (e?.type !== 'user/message') continue;
    const s = e.data?.source;
    if (s?.kind === 'skill-invocation' && s.form === 'instructions' && typeof s.name === 'string') last.set(s.name, e.seq);
  }
  const inStep = new Set(pending.filter(m => m?.source?.kind === 'skill-invocation').map(m => m.source.name));
  return [...last.entries()]
    .filter(([name, seq]) => !visible.has(seq) && !inStep.has(name))
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_KEPT_SKILLS)
    .map(([name]) => name);
}

/** The events of a live session, oldest first. */
export function sessionEvents(session) {
  const out = [];
  for (let i = 0; i < session.seq; i += 1) {
    const e = session.eventAt(i);
    if (e) out.push(e);
  }
  return out;
}
