/**
 * The day on the researcher's wall.
 *
 * Timestamps are stored as UTC instants and the days on screen are local ones, so the
 * conversion has to happen somewhere — and it happened in two places. `JournalRepository.start`
 * had a copy in the main process and the journal's calendar had one in the renderer, each with
 * a comment saying the other kept the same rule. A rule two modules promise to keep the same is
 * one module.
 *
 * Slicing an ISO instant at ten characters is the mistake this exists to prevent: it says
 * *tomorrow* for anything written after 5pm in California, which is how a notebook made this
 * evening reported that it had started tomorrow.
 */

/**
 * `YYYY-MM-DD` for the local calendar day an instant falls on.
 *
 * Total, because a day is a label and never worth throwing over: an unparseable string falls
 * back to its own first ten characters, which is the best guess available and what the two
 * copies of this already did.
 */
export function localDay(at: Date | string = new Date()): string {
  const when = typeof at === 'string' ? new Date(at) : at;
  if (Number.isNaN(when.getTime())) return typeof at === 'string' ? at.slice(0, 10) : '';
  const month = String(when.getMonth() + 1).padStart(2, '0');
  const day = String(when.getDate()).padStart(2, '0');
  return `${String(when.getFullYear())}-${month}-${day}`;
}
