// Recurring and one-off tasks. A schedule is just a stored task brief plus a
// time rule; when it is due, a normal task is created from it.
import { Cron } from 'croner';
import { config } from './config.js';
import { schedules, tasks, ScheduleRow, now } from './db.js';
import { createTask } from './agent.js';

const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: config.timezone, weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
});
export const localTime = (ms: number) => fmt.format(new Date(ms));

/** Next occurrence of a 5-field cron expression in the configured timezone, or an error message. */
export function nextCron(expr: string, after = now()): number | string {
  if (expr.trim().split(/\s+/).length !== 5) return 'A cron expression needs exactly 5 fields: minute hour day-of-month month day-of-week.';
  try {
    const next = new Cron(expr, { timezone: config.timezone }).nextRun(new Date(after));
    return next ? next.getTime() : 'That expression never fires.';
  } catch (e: any) {
    return `Invalid cron expression: ${e.message}`;
  }
}

/** "2026-10-06 09:30" (local wall-clock time in the configured timezone) -> ms epoch. */
export function parseLocal(at: string): number | string {
  const m = at.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
  if (!m) return 'Use the form YYYY-MM-DD HH:MM.';
  // croner resolves the wall-clock time in the timezone, daylight saving included
  try {
    const next = new Cron(`${+m[5]} ${+m[4]} ${+m[3]} ${+m[2]} *`, { timezone: config.timezone })
      .nextRun(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]) - 2 * 86400_000));
    if (!next || next.getFullYear() !== +m[1]) return 'Could not resolve that date.';
    return next.getTime() <= now() ? 'That time is in the past.' : next.getTime();
  } catch (e: any) {
    return `Invalid date: ${e.message}`;
  }
}

export function describe(s: ScheduleRow): string {
  const when = s.cron ? `cron "${s.cron}"` : 'once';
  const next = !s.enabled ? 'paused' : s.next_run ? `next ${localTime(s.next_run)}` : 'finished';
  return `#${s.id} ${s.title} [${when}; ${next}${s.needs_screen ? '; screen' : ''}]`;
}

async function fire(s: ScheduleRow): Promise<void> {
  // Advance first: whatever happens below, this occurrence is not retried in a
  // loop. Occurrences missed while the system was down collapse into this one.
  const next = s.cron ? nextCron(s.cron) : null;
  schedules.update(s.id, { last_run: now(), next_run: typeof next === 'number' ? next : null, enabled: s.cron && typeof next === 'number' ? 1 : 0 });

  const prev = s.last_task_id ? tasks.get(s.last_task_id) : undefined;
  if (prev && (prev.status === 'queued' || prev.status === 'running')) {
    console.log(`[schedule] #${s.id} skipped: previous run (task #${prev.id}) has not finished`);
    return;
  }
  const t = await createTask(s.bot_id, `⏰ ${s.title}`, s.instructions, s.model, !!s.needs_screen);
  schedules.update(s.id, { last_task_id: t.id });
  console.log(`[schedule] #${s.id} fired as task #${t.id}`);
}

export function startScheduler(): void {
  setInterval(() => {
    for (const s of schedules.due()) fire(s).catch((e) => console.error('[schedule]', e));
  }, 20_000).unref();
}
