/**
 * The journal calendar's shape: which days are shown, and how they are laid out (J02, V03).
 *
 * Two functions, and the difference between them is a decision the researcher made.
 *
 * `calendarCells` folds a long run of unlogged days into one marker, because a strip that
 * renders every empty day as an empty bubble buries the days that have something in them.
 * Two rules keep that collapse honest, and both are the sort of thing an off-by-one quietly
 * breaks:
 *
 * - A logged day never collapses, and never joins a run.
 * - **Today always shows**, logged or not, and splits a run in two. Today is where writing
 *   happens; folding it away hides the one bubble that is there to be clicked.
 *
 * `calendarMonths` is what the journal page draws, and it never folds: *"render all days"* —
 * a strip reading `20 21 · 9 days · 31` is a sensible compression that looks like a calendar
 * which failed to load, and a month one can count off is worth more than the room it saves.
 * So the days go into weekday-aligned month grids, where a gap in the writing is a shape
 * rather than a number. It is the same day-by-day answer as `calendarCells` with nothing
 * folded — one description of which days exist and how each one reads, laid out two ways —
 * so the fold stays a parameter of that description rather than a second copy of it.
 *
 * Pure, and dateless: the caller supplies today rather than the function reading a clock, so
 * a test can stand anywhere in the year and the answer is the same on every machine.
 */

/** A run shorter than this is drawn day by day. Four is the reference notebook's default. */
export const COLLAPSE_RUN = 4;

/** Month names, written here rather than taken from the platform's locale data, so that the
 * heading a test reads is the heading every machine draws. */
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** Monday first: a journal is a record of work, and a week of work starts on Monday. */
export const WEEKDAY_INITIALS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const;

/**
 * The local calendar day an instant falls on.
 *
 * Timestamps are stored as UTC instants and the days on screen are the ones on the
 * researcher's wall, so the conversion happens here rather than by slicing the string — an
 * ISO instant sliced at ten characters says *tomorrow* for anything written after 5pm in
 * California, which is how a notebook made this evening reported that it had started
 * tomorrow. `JournalRepository.start` keeps the same rule on the other side of the wire.
 */
export function localDay(at: Date | string = new Date()): string {
  const when = typeof at === 'string' ? new Date(at) : at;
  if (Number.isNaN(when.getTime())) return typeof at === 'string' ? at.slice(0, 10) : '';
  const month = String(when.getMonth() + 1).padStart(2, '0');
  const day = String(when.getDate()).padStart(2, '0');
  return `${String(when.getFullYear())}-${month}-${day}`;
}

export interface CalendarDay {
  readonly kind: 'day';
  readonly date: string;
  readonly logged: boolean;
  readonly isToday: boolean;
}

export interface CalendarRun {
  readonly kind: 'run';
  readonly from: string;
  readonly to: string;
  readonly count: number;
}

export type CalendarCell = CalendarDay | CalendarRun;

export interface CalendarInput {
  /** Inclusive ISO bounds of the range to lay out. */
  readonly from: string;
  readonly to: string;
  readonly today: string;
  /** The days with an entry. Order does not matter. */
  readonly logged: Iterable<string>;
  /** Runs the reader has clicked open, named by their first day. */
  readonly expanded?: Iterable<string>;
  readonly collapseRun?: number;
}

/** Every ISO date from `from` to `to`, inclusive. UTC, so no timezone shifts a day. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(end.getTime())) return out;
  while (cursor.getTime() <= end.getTime()) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/** Lay the range out as bubbles, folding long runs of unlogged days into one marker each. */
export function calendarCells(input: CalendarInput): CalendarCell[] {
  const logged = new Set(input.logged);
  const expanded = new Set(input.expanded ?? []);
  const threshold = input.collapseRun ?? COLLAPSE_RUN;
  const days = daysBetween(input.from, input.to);
  const shows = (date: string): boolean => logged.has(date) || date === input.today;

  const cells: CalendarCell[] = [];
  let index = 0;
  while (index < days.length) {
    const date = days[index];
    if (date === undefined) break;
    if (shows(date)) {
      cells.push({ kind: 'day', date, logged: logged.has(date), isToday: date === input.today });
      index += 1;
      continue;
    }
    let end = index;
    while (end < days.length) {
      const candidate = days[end];
      if (candidate === undefined || shows(candidate)) break;
      end += 1;
    }
    const run = days.slice(index, end);
    const first = run[0];
    const last = run[run.length - 1];
    if (first !== undefined && last !== undefined && run.length >= threshold && !expanded.has(first)) {
      cells.push({ kind: 'run', from: first, to: last, count: run.length });
    } else {
      for (const day of run) {
        cells.push({ kind: 'day', date: day, logged: false, isToday: false });
      }
    }
    index = end;
  }
  return cells;
}

export interface CalendarMonth {
  /** `YYYY-MM`, and the key React lays the months out by. */
  readonly month: string;
  /** `July 2026` — written from `MONTH_NAMES`, never from the platform's locale. */
  readonly label: string;
  /** Blank cells before the first day, so the 1st falls under its own weekday. */
  readonly leading: number;
  readonly days: readonly CalendarDay[];
}

/** Monday-first weekday index of an ISO day. UTC, matching `daysBetween`. */
function weekdayIndex(date: string): number {
  const at = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return 0;
  return (at.getUTCDay() + 6) % 7;
}

/**
 * The range as month grids, every day in it — the journal page's calendar (`V03`).
 *
 * Built on `calendarCells` with the fold turned off, so which days exist and whether each is
 * logged is answered in exactly one place. `leading` is how many blanks the month opens with,
 * because a grid whose 1st does not sit under its weekday is a grid nobody can count off.
 */
export function calendarMonths(input: CalendarInput): CalendarMonth[] {
  const months: CalendarMonth[] = [];
  let current: { month: string; label: string; leading: number; days: CalendarDay[] } | null = null;

  for (const cell of calendarCells({ ...input, collapseRun: Number.POSITIVE_INFINITY })) {
    // Nothing folds at that threshold, and the narrowing says so rather than assuming it.
    if (cell.kind !== 'day') continue;
    const month = cell.date.slice(0, 7);
    if (current === null || current.month !== month) {
      const monthIndex: number = Number(month.slice(5, 7)) - 1;
      current = {
        month,
        label: `${MONTH_NAMES[monthIndex] ?? month} ${month.slice(0, 4)}`,
        leading: weekdayIndex(cell.date),
        days: [],
      };
      months.push(current);
    }
    current.days.push(cell);
  }
  return months;
}
