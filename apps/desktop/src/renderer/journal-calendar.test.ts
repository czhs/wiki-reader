/**
 * The journal calendar: marked days, folded runs, and the month grids the page draws
 * (criteria J02, V03).
 *
 * The collapse is where the off-by-one lives, so the boundary is asserted from both sides —
 * three unlogged days stay three bubbles, four become one marker — and every case checks the
 * *whole* layout rather than a count, because a rule that drops a day and a rule that folds
 * it produce the same number of cells and mean very different things.
 *
 * `calendarMonths` is the same description with nothing folded, which is what the researcher
 * asked the page for; the cases at the bottom assert that "nothing folded" survives a range
 * long enough that the folding rules would otherwise all fire.
 */
import { describe, expect, it } from 'vitest';
import {
  calendarCells,
  calendarMonths,
  daysBetween,
  type CalendarCell,
} from './journal-calendar.js';

/** A compact reading of the layout: `2026-07-04`, `·4·` for a folded run, `[today]`. */
function sketch(cells: readonly CalendarCell[]): string[] {
  return cells.map((cell) => {
    if (cell.kind === 'run') return `·${String(cell.count)}·`;
    if (cell.isToday) return `[${cell.date}]${cell.logged ? '*' : ''}`;
    return cell.logged ? `${cell.date}*` : cell.date;
  });
}

describe('the journal calendar', () => {
  it('[J02] marks the days that have an entry', () => {
    const cells = calendarCells({
      from: '2026-07-01',
      to: '2026-07-04',
      today: '2026-07-04',
      logged: ['2026-07-01', '2026-07-03'],
    });

    expect(sketch(cells)).toEqual([
      '2026-07-01*',
      '2026-07-02',
      '2026-07-03*',
      '[2026-07-04]',
    ]);
  });

  it('[J02] collapses a run of four unlogged days, and leaves three alone', () => {
    const threeIdle = calendarCells({
      from: '2026-07-01',
      to: '2026-07-05',
      today: '2026-07-31',
      logged: ['2026-07-01', '2026-07-05'],
    });
    expect(sketch(threeIdle)).toEqual([
      '2026-07-01*',
      '2026-07-02',
      '2026-07-03',
      '2026-07-04',
      '2026-07-05*',
    ]);

    const fourIdle = calendarCells({
      from: '2026-07-01',
      to: '2026-07-06',
      today: '2026-07-31',
      logged: ['2026-07-01', '2026-07-06'],
    });
    expect(sketch(fourIdle)).toEqual(['2026-07-01*', '·4·', '2026-07-06*']);
    const run = fourIdle[1];
    if (run === undefined || run.kind !== 'run') throw new Error('expected a folded run');
    // The marker names the days it stands for, so nothing is silently dropped.
    expect(run).toEqual({ kind: 'run', from: '2026-07-02', to: '2026-07-05', count: 4 });
  });

  it('[J02] never folds today away, and today splits a run in two', () => {
    const cells = calendarCells({
      from: '2026-07-01',
      to: '2026-07-14',
      today: '2026-07-07',
      logged: [],
    });

    // Six idle days, today, six more. Today is a bubble; the runs either side are folded.
    expect(sketch(cells)).toEqual(['·6·', '[2026-07-07]', '·7·']);
  });

  it('[J02] a run shortened by today going below the threshold is drawn day by day', () => {
    const cells = calendarCells({
      from: '2026-07-01',
      to: '2026-07-07',
      today: '2026-07-04',
      logged: [],
    });

    // Three idle, today, three idle: neither side reaches four, so nothing folds. The naive
    // implementation folds the whole week and hides the day you would click.
    expect(sketch(cells)).toEqual([
      '2026-07-01',
      '2026-07-02',
      '2026-07-03',
      '[2026-07-04]',
      '2026-07-05',
      '2026-07-06',
      '2026-07-07',
    ]);
  });

  it('[J02] expands the run the reader clicked open, and only that one', () => {
    const input = {
      from: '2026-07-01',
      to: '2026-07-12',
      today: '2026-07-31',
      logged: ['2026-07-01', '2026-07-06'],
    };
    expect(sketch(calendarCells(input))).toEqual(['2026-07-01*', '·4·', '2026-07-06*', '·6·']);

    const opened = calendarCells({ ...input, expanded: ['2026-07-02'] });
    expect(sketch(opened)).toEqual([
      '2026-07-01*',
      '2026-07-02',
      '2026-07-03',
      '2026-07-04',
      '2026-07-05',
      '2026-07-06*',
      '·6·',
    ]);
  });

  it('[J02] a logged day never joins a run, however long the idle stretch around it', () => {
    const cells = calendarCells({
      from: '2026-07-01',
      to: '2026-07-20',
      today: '2026-07-31',
      logged: ['2026-07-10'],
    });

    expect(sketch(cells)).toEqual(['·9·', '2026-07-10*', '·10·']);
  });

  it('[J02] counts every day in the range, folded or not', () => {
    const from = '2026-01-01';
    const to = '2026-03-15';
    const logged = ['2026-01-04', '2026-02-11', '2026-02-12'];
    const cells = calendarCells({ from, to, today: '2026-06-01', logged });

    const covered = cells.reduce(
      (total, cell) => total + (cell.kind === 'run' ? cell.count : 1),
      0,
    );
    expect(covered).toBe(daysBetween(from, to).length);
    expect(daysBetween(from, to)).toHaveLength(74);
    // Crossing a month boundary, and a leap-free February, without losing or inventing a day.
    expect(daysBetween('2026-02-27', '2026-03-01')).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
    ]);
  });

  it('[V03] lays every day of the range out, with none folded away', () => {
    const from = '2026-01-01';
    const to = '2026-03-15';
    // One logged day in January and a two-day stretch in February: every rule that folds —
    // a long idle run, a run either side of a logged day, a run running to the end — has
    // something to fire on here, and none of them may.
    const months = calendarMonths({
      from,
      to,
      today: '2026-06-01',
      logged: ['2026-01-04', '2026-02-11', '2026-02-12'],
    });

    const drawn = months.flatMap((month) => month.days.map((day) => day.date));
    expect(drawn).toEqual(daysBetween(from, to));
    expect(drawn).toHaveLength(74);
    expect(months.map((month) => month.month)).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(months.map((month) => month.label)).toEqual([
      'January 2026',
      'February 2026',
      'March 2026',
    ]);
    expect(months.map((month) => month.days.length)).toEqual([31, 28, 15]);
    // Marked days are still marked: laying them out differently must not lose which ones
    // have something in them.
    expect(drawn.filter((date) => months.some((month) =>
      month.days.some((day) => day.date === date && day.logged),
    ))).toEqual(['2026-01-04', '2026-02-11', '2026-02-12']);
  });

  it('[V03] opens each month under the weekday its first drawn day falls on', () => {
    // 2026-01-01 is a Thursday, so January opens with three blanks under Mon–Wed.
    const whole = calendarMonths({
      from: '2026-01-01',
      to: '2026-02-28',
      today: '2026-06-01',
      logged: [],
    });
    expect(whole.map((month) => month.leading)).toEqual([3, 6]);

    // A range that begins mid-month aligns on the day it begins, not on the 1st: the 12th of
    // January 2026 is a Monday.
    const partial = calendarMonths({
      from: '2026-01-12',
      to: '2026-01-20',
      today: '2026-06-01',
      logged: [],
    });
    expect(partial).toHaveLength(1);
    expect(partial[0]?.leading).toBe(0);
    expect(partial[0]?.days[0]?.date).toBe('2026-01-12');
  });

  it('[V03] marks today wherever it falls, and a one-day range is one day', () => {
    const months = calendarMonths({
      from: '2026-07-28',
      to: '2026-07-28',
      today: '2026-07-28',
      logged: [],
    });
    expect(months).toHaveLength(1);
    expect(months[0]?.days).toEqual([
      { kind: 'day', date: '2026-07-28', logged: false, isToday: true },
    ]);
  });
});
