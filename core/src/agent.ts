// The bots' behaviour: the chat-facing session per bot, background tasks, and
// the requests that wait on the owner (questions, help, secrets, approvals).
import { InlineKeyboard } from 'grammy';
import path from 'node:path';
import { config } from './config.js';
import { box } from './box.js';
import { typeOnDisplay } from './vnc.js';
import { bots, events, links, requests, schedules, secrets, tasks, RequestRow, TaskRow, now } from './db.js';
import { describe as describeSchedule, localTime, nextCron, parseLocal } from './schedule.js';
import { runClaude, describeEvent, RunContext } from './claude.js';
import { frontPrompt, taskPrompt } from './prompts.js';
import { execApproved, mailTool } from './mail.js';
import { execFleet, fleetTool, noteDelegated } from './fleet.js';
import * as tg from './telegram.js';

const log = (...a: unknown[]) => console.log('[agent]', ...a);

// ============================================================== usage limit
let limitUntil = 0;
let limitNotified = false;

function hitLimit(botId: number, resetAt: number | null) {
  // No reset time in the error: probe again in half an hour.
  limitUntil = Math.max(limitUntil, resetAt && resetAt > now() ? resetAt + 60_000 : now() + 30 * 60_000);
  if (!limitNotified) {
    limitNotified = true;
    const at = new Date(limitUntil).toLocaleTimeString('en-GB', { timeZone: config.timezone, hour: '2-digit', minute: '2-digit' });
    tg.send(botId, `⏳ Claude usage limit reached. Everything is paused and will resume by itself around ${at}.`).catch(() => {});
  }
  setTimeout(pump, limitUntil - now() + 1000).unref();
}
const limited = () => now() < limitUntil;

// ============================================================== office exit
let officeExit: boolean | null = null;

/** The box reports which way browser traffic currently leaves. Tell the owner about changes only. */
export function exitChanged(office: boolean): void {
  const before = officeExit;
  officeExit = office;
  if (before === office || (before === null && office)) return;   // unchanged, or a normal start
  const main = bots.all()[0];
  tg.send(main.id, office
    ? '🏢 The office connection is back. Browsers use the office address again.'
    : '⚠️ The office connection is down. Browsers now go out through the server\'s own address until it returns; expect more captchas.').catch(() => {});
}

// ============================================================ chat session
const frontQueues = new Map<number, Promise<void>>();

/** Queue a turn of the bot's chat session. text=null: a turn triggered by system events only. */
export function enqueueFront(botId: number, text: string | null): void {
  const prev = frontQueues.get(botId) ?? Promise.resolve();
  frontQueues.set(botId, prev.then(() => frontTurn(botId, text)).catch((e) => {
    console.error('[front]', e);
    tg.send(botId, `Something broke on my side: ${e.message}`).catch(() => {});
  }));
}

async function frontTurn(botId: number, text: string | null): Promise<void> {
  const bot = bots.get(botId)!;
  if (limited()) {
    await tg.send(botId, '⏳ Still paused by the Claude usage limit; I will pick this up when it resets.');
    if (text) events.add(botId, `While you were paused by the usage limit the owner wrote: ${text}`);
    return;
  }
  const notes = [`[system] Now: ${localTime(now())} (${config.timezone})`, ...events.drain(botId).map((n) => `[system] ${n}`)];
  const hadEvents = notes.length > 1;
  for (const q of requests.pendingQuestions(botId)) {
    notes.push(`[system] Task #${q.task_id} is waiting for the owner's answer to: ${JSON.parse(q.payload).question}`);
  }
  if (!text && !hadEvents && !requests.pendingQuestions(botId).length) return;
  const prompt = [...notes, text ?? '[system] No new message from the owner; react to the events above if they need action, otherwise reply with nothing.']
    .join('\n\n');

  const typingTimer = setInterval(() => tg.typing(botId), 4500);
  tg.typing(botId);
  try {
    const attempt = (sessionId: string | null) => runClaude({
      runId: `front-${botId}-${now()}`, role: 'front', bot, model: config.frontModel,
      systemPrompt: frontPrompt(bot), prompt, sessionId, resume: !!sessionId, screen: false,
    });
    let r = await attempt(bot.session_id);
    if (r.sessionMissing) r = await attempt(null);   // session file gone: start over, memory file still applies
    if (r.sessionId) bots.setSession(botId, r.sessionId);
    if (r.limitHit) {
      hitLimit(botId, r.limitResetAt);
      if (text) events.add(botId, `While you were paused by the usage limit the owner wrote: ${text}`);
      return;
    }
    if (!r.ok) { await tg.send(botId, `⚠️ ${r.text}`, { plain: true }); return; }
    if (r.text.trim()) await tg.send(botId, r.text);
  } finally {
    clearInterval(typingTimer);
  }
}

// ==================================================================== tasks
const ICON: Record<string, string> = { queued: '🕓', running: '⚙️', done: '✅', failed: '❌', cancelled: '🚫', interrupted: '⚠️' };
const statusTimers = new Map<number, NodeJS.Timeout>();
const lastStatusEdit = new Map<number, number>();

function duration(t: TaskRow): string {
  const s = Math.round(((t.finished_at ?? now()) - (t.started_at ?? t.created_at)) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function statusText(t: TaskRow): string {
  const waiting = t.status === 'running' && requests.pendingForTask(t.id).length > 0;
  const head = `${waiting ? '⏸' : ICON[t.status] ?? '•'} **#${t.id} ${t.title}**`;
  if (t.status === 'running') return waiting ? `${head}\nwaiting for you` : `⏳ **Working: #${t.id} ${t.title}**\n${t.progress ?? 'starting…'}`;
  if (t.status === 'queued') return `${head}\nqueued`;
  return `${head} (${duration(t)})`;
}

/** Edit the task's status message, at most once every few seconds. */
function refreshStatus(taskId: number, immediate = false): void {
  const run = () => {
    statusTimers.delete(taskId);
    lastStatusEdit.set(taskId, now());
    const t = tasks.get(taskId);
    if (t?.status_msg_id) tg.edit(t.bot_id, t.status_msg_id, statusText(t)).catch(() => {});
  };
  if (immediate) { clearTimeout(statusTimers.get(taskId)); return run(); }
  if (statusTimers.has(taskId)) return;
  const wait = Math.max(0, 4000 - (now() - (lastStatusEdit.get(taskId) ?? 0)));
  statusTimers.set(taskId, setTimeout(run, wait));
}

export function taskList(botId: number): string {
  return tasks.recent(botId).reverse().map((t) => {
    const waiting = t.status === 'running' && requests.pendingForTask(t.id).length > 0;
    const extra = t.status === 'running' ? ` - ${waiting ? 'waiting for you' : t.progress ?? ''}` : '';
    return `${waiting ? '⏸' : ICON[t.status] ?? '•'} #${t.id} ${t.title} [${t.status}]${extra}`;
  }).join('\n');
}

/**
 * Queue a task and show the owner its status message.
 * unattended: started by a schedule or by arriving mail. Nobody is waiting for
 * it, so it works out of sight: no status message, and no result message
 * either when it has nothing for the owner (see nothing_to_report).
 */
export async function createTask(botId: number, title: string, instructions: string, model: string, needsScreen: boolean, unattended = false): Promise<TaskRow> {
  const t = tasks.create(botId, title.slice(0, 120), instructions, model || config.taskModel, needsScreen, unattended);
  const msgId = unattended ? 0 : await tg.send(botId, statusText(t)).catch(() => 0);
  if (msgId) tasks.update(t.id, { status_msg_id: msgId });
  pump();
  return tasks.get(t.id)!;
}

export const scheduleList = (botId: number) => schedules.forBot(botId).map(describeSchedule).join('\n');

/** Start whatever the limits allow. Called after every state change. */
export function pump(): void {
  if (limited()) return;
  limitNotified = false;
  const running = tasks.byStatus('running');
  let screens = running.filter((t) => t.needs_screen).length;
  let slots = config.maxParallelTasks - running.length;
  for (const t of tasks.byStatus('queued')) {
    if (slots <= 0) break;
    if (t.needs_screen) {
      // one screen per bot, and only so many Chromes fit in the box's memory
      if (screens >= config.maxScreens) continue;
      if (running.some((r) => r.needs_screen && r.bot_id === t.bot_id)) continue;
      screens++;
    }
    slots--;
    running.push({ ...t, status: 'running' });
    runTask(t).catch((e) => console.error('[task]', e));
  }
}

async function runTask(t: TaskRow): Promise<void> {
  const bot = bots.get(t.bot_id)!;
  tasks.update(t.id, { status: 'running', started_at: t.started_at ?? now(), progress: null });
  refreshStatus(t.id, true);
  log(`task #${t.id} started (${t.model}${t.needs_screen ? ', screen' : ''})`);

  const r = await runClaude({
    runId: `task-${t.id}`, role: 'task', bot, taskId: t.id, model: t.model,
    systemPrompt: taskPrompt(bot, !!t.needs_screen, !!t.unattended),
    prompt: t.resume ? 'You were interrupted. Continue the task from where you stopped.' : `# Task: ${t.title}\n\n${t.instructions}`,
    sessionId: t.session_id, resume: !!(t.resume && t.session_id), screen: !!t.needs_screen,
    onEvent: (ev) => {
      if (ev.type === 'system' && ev.session_id) tasks.update(t.id, { session_id: ev.session_id });
      const line = describeEvent(ev);
      if (line) { tasks.update(t.id, { progress: line }); refreshStatus(t.id); }
    },
  });

  cancelRequestsOf(t.id);
  const current = tasks.get(t.id)!;
  if (current.status === 'cancelled') { refreshStatus(t.id, true); return pump(); }   // cancelTask already reported

  if (r.limitHit) {
    // back in the queue; it resumes its own session once the limit resets
    tasks.update(t.id, { status: 'queued', resume: 1, session_id: r.sessionId ?? current.session_id, progress: null });
    refreshStatus(t.id, true);
    hitLimit(t.bot_id, r.limitResetAt);
    return;
  }

  tasks.update(t.id, { status: r.ok ? 'done' : 'failed', result: r.text, finished_at: now(), session_id: r.sessionId ?? current.session_id });
  log(`task #${t.id} ${r.ok ? 'done' : 'failed'}`);
  // The "working" message has done its job: remove it and let the result stand
  // alone. If Telegram refuses the delete, fall back to marking it finished.
  clearTimeout(statusTimers.get(t.id)); statusTimers.delete(t.id);
  if (current.status_msg_id && !(await tg.remove(t.bot_id, current.status_msg_id))) refreshStatus(t.id, true);
  const done = tasks.get(t.id)!;
  // An unattended run that went well and has nothing for the owner ends without a message.
  if (r.ok && done.unattended && (done.quiet || !r.text.trim())) {
    log(`task #${t.id} had nothing to report`);
    events.add(t.bot_id, `The unattended task #${t.id} "${t.title}" ran and had nothing to report, so the owner was not messaged.${r.text.trim() ? ` Its note: ${quoted(r.text.trim().slice(0, 500))}` : ''}`);
    return pump();
  }
  const body = r.text.trim() || (r.ok ? 'Done.' : 'The task failed without an explanation.');
  const head = `${r.ok ? '✅' : '❌'} **#${t.id} ${t.title}** (${duration(done)})`;
  await tg.send(t.bot_id, `${head}\n\n${body}`)
    .catch((e) => console.error('[task] result delivery failed', e));
  events.add(t.bot_id, `Task #${t.id} "${t.title}" ${r.ok ? 'finished' : 'FAILED'}; the owner already received this result:\n${quoted(body.slice(0, 2500))}`);
  noteDelegated(done, r.ok, body);
  pump();
}

export async function cancelTask(taskId: number): Promise<string> {
  const t = tasks.get(taskId);
  if (!t) return 'No such task.';
  if (t.status !== 'running' && t.status !== 'queued') return `Task #${taskId} is already ${t.status}.`;
  tasks.update(taskId, { status: 'cancelled', finished_at: now() });
  if (t.status === 'running') await box.kill(`task-${taskId}`).catch(() => {});
  cancelRequestsOf(taskId);
  refreshStatus(taskId, true);
  pump();
  return `Task #${taskId} cancelled.`;
}

/** After a restart nothing in the box is observed any more: stop it and say so. */
export async function recoverAfterRestart(): Promise<void> {
  await box.killAll().catch(() => {});
  for (const t of tasks.byStatus('running')) {
    tasks.update(t.id, { status: 'interrupted', finished_at: now() });
    cancelRequestsOf(t.id);
    if (t.status_msg_id) tg.edit(t.bot_id, t.status_msg_id, statusText(tasks.get(t.id)!)).catch(() => {});
    events.add(t.bot_id, `Task #${t.id} "${t.title}" was interrupted by a restart of the system and did not finish.`);
    tg.send(t.bot_id, `⚠️ Task #${t.id} "${t.title}" was interrupted by a restart. Tell me if I should run it again.`).catch(() => {});
  }
  pump();
}

// ================================================================= requests
const waiters = new Map<string, Set<() => void>>();

function requestLabel(r: RequestRow): string {
  const t = r.task_id ? tasks.get(r.task_id) : undefined;
  return t ? `#${t.id} ${t.title}` : 'me';
}

/** Close a pending request with its outcome and wake the tool call waiting on it. */
export function resolveRequest(id: string, result: string, status: 'done' | 'cancelled' = 'done'): boolean {
  const r = requests.get(id);
  if (!r || !requests.finish(id, status, result)) return false;
  links.useForRequest(id);
  waiters.get(id)?.forEach((w) => w());
  waiters.delete(id);
  if (r.tg_msg_id) {
    const p = JSON.parse(r.payload);
    const tail = status === 'cancelled' ? '— no longer needed' : {
      question: `\n→ ${result.slice(0, 300)}`,
      choice: `\n→ ${result.slice(0, 300)}`,
      help: result === HELP_DECLINED ? '— cancelled by you' : '— done, thank you',
      secret: `— saved`,
      approval: `— ${result.startsWith('approved') ? 'approved ✅' : 'denied 🚫'}`,
    }[r.kind];
    const summary = { question: `❓ ${p.question}`, choice: p.question, help: `🖥 ${p.reason}`, secret: `🔑 ${p.name}`, approval: `✋ ${p.action}` }[r.kind];
    // rewriting the message also removes its buttons
    // a chat question the owner answered by typing instead: just drop its buttons
    tg.edit(r.bot_id, r.tg_msg_id, r.kind === 'choice' && status === 'cancelled' ? String(summary) : `${summary} ${tail}`).catch(() => {});
  }
  if (r.task_id) refreshStatus(r.task_id, true);
  return true;
}

function cancelRequestsOf(taskId: number) {
  for (const r of requests.pendingForTask(taskId)) resolveRequest(r.id, 'cancelled', 'cancelled');
}

/** Long-poll used by the box: resolves with the result, or null after ~25 s. */
export function waitRequest(id: string): Promise<{ result?: string; error?: string } | null> {
  const check = () => {
    const r = requests.get(id);
    if (!r) return { error: 'unknown request' };
    if (r.status === 'done') return { result: r.result ?? '' };
    if (r.status === 'cancelled') return { error: 'The request was cancelled.' };
    return null;
  };
  const first = check();
  if (first) return Promise.resolve(first);
  return new Promise((resolve) => {
    const set = waiters.get(id) ?? new Set();
    waiters.set(id, set);
    const wake = () => { clearTimeout(timer); set.delete(wake); resolve(check()); };
    const timer = setTimeout(wake, 25_000);
    set.add(wake);
  });
}

/** Text a task wrote, passed on to a chat session: it must not be able to pose as a control-service line. */
export const quoted = (s: string): string => s.replace(/^[ \t]*\[(system|owner)\]/gim, '($1)');

export const HELP_DONE = 'The owner says they are done. Look at the screen and continue.';
export const HELP_DECLINED = 'DECLINED: the owner will not do this. Do not ask for the same help again; continue without it if you can, otherwise finish and explain what is blocked.';

/**
 * Ask the owner to approve an action. With `exec`, core itself performs the
 * action after the tap (mail sending/trashing), so the agent cannot skip the
 * question; without it, the agent is told the answer and acts itself.
 */
export async function createApproval(bot: { id: number }, task: TaskRow | undefined, action: string, details: string, exec?: unknown): Promise<string> {
  const r = requests.create(bot.id, task?.id ?? null, 'approval', { action, exec });
  const label = task ? `**#${task.id} ${task.title}**\n` : '';
  const msgId = await tg.send(bot.id, `${label}✋ **Approval needed:** ${action}\n\n${details}`, {
    keyboard: new InlineKeyboard().text('✅ Approve', `ap:${r.id}:y`).text('🚫 Deny', `ap:${r.id}:n`),
  });
  requests.setMessage(r.id, msgId);
  if (task) refreshStatus(task.id, true);
  return r.id;
}
const executing = new Set<string>();

/** One button per option, each on its own row. */
const optionButtons = (id: string, options: string[]) =>
  options.reduce((kb, o, i) => kb.text(o.slice(0, 60), `op:${id}:${i}`).row(), new InlineKeyboard());
const cleanOptions = (o: unknown): string[] => (Array.isArray(o) ? o.map(String).filter(Boolean).slice(0, 5) : []);

/** The owner typed instead of tapping: the buttons of open chat questions are stale now. */
export function dropChoices(botId: number): void {
  for (const r of requests.pending()) if (r.kind === 'choice' && r.bot_id === botId) resolveRequest(r.id, '', 'cancelled');
}

// ?app: opened inside Telegram by a web-app button (see gateway.ts)
const helpUrl = (token: string) => `${config.publicUrl}/h/${token}?app`;

/** note: the chat session handed the screen over itself, so the view offers to tell it when the owner is done. */
export async function screenLink(botId: number, note?: string): Promise<string> {
  return helpUrl(links.create('help', botId, null, note === undefined ? {} : { asked: true, reason: note }));
}

/** The owner finished on a screen the chat session shared: tell it, as a turn of its own. */
export function screenDone(botId: number): void {
  events.add(botId, 'The owner says they have done everything on your screen. Look at it and continue.');
  enqueueFront(botId, null);
}

/** Inline button taps: approvals and "done helping". Returns the toast text. */
export async function handleButton(kind: string, id: string, arg?: string): Promise<string> {
  if (kind === 'ap') {
    const r = requests.get(id);
    const exec = r?.status === 'pending' ? JSON.parse(r.payload).exec : undefined;
    if (arg === 'y' && r && exec) {
      if (executing.has(id)) return 'Already in progress';
      executing.add(id);
      const kind = String(exec.kind);
      const action = JSON.parse(r.payload).action;
      // A chat session does not wait on its approvals: it is told the outcome as an event.
      const tellFront = (note: string) => { if (!r.task_id) { events.add(r.bot_id, note); enqueueFront(r.bot_id, null); } };
      try {
        const out = kind.startsWith('bot_') ? await execFleet(exec)
          : kind === 'secret_type' ? await typeSecret(r.bot_id, exec.name, exec.taskId)
          : kind.startsWith('schedule_') ? execSchedule(r.bot_id, exec)
          : await execApproved(r.bot_id, exec);
        resolveRequest(id, `approved and done: ${out}`);
        tellFront(`The owner approved "${action}" and it is done: ${out} Confirm it to them in one short line.`);
        return 'Approved and done';
      } catch (e: any) {
        resolveRequest(id, `approved, but it FAILED: ${e.message}`);
        tg.send(r.bot_id, `⚠️ Approved, but it failed: ${e.message}`, { replyTo: r.tg_msg_id ?? undefined, plain: true }).catch(() => {});
        tellFront(`The owner approved "${action}", but it failed: ${e.message}`);
        return 'Failed';
      } finally { executing.delete(id); }
    }
    const done = resolveRequest(id, arg === 'y' ? 'approved' : 'denied');
    if (done && arg !== 'y' && r && exec && !r.task_id) events.add(r.bot_id, `The owner denied "${JSON.parse(r.payload).action}". Do not ask for it again unless they bring it up.`);
    return done ? (arg === 'y' ? 'Approved' : 'Denied') : 'Already handled';
  }
  if (kind === 'op') {
    // an option button: under a chat question it becomes the owner's next
    // message, under a task's question it is the answer the task waits for
    const r = requests.get(id);
    const option = r && (JSON.parse(r.payload).options as string[] | undefined)?.[Number(arg)];
    if (!r || !option || !resolveRequest(id, option)) return 'Already answered';
    if (r.kind === 'choice') enqueueFront(r.bot_id, option);
    return option.slice(0, 180);
  }
  if (kind === 'hd') return resolveRequest(id, HELP_DONE) ? 'Thanks, continuing' : 'Already handled';
  if (kind === 'hc') return resolveRequest(id, HELP_DECLINED) ? 'Cancelled' : 'Already handled';
  return '';
}

// Nudge the owner about things still waiting on them, and keep screens that
// are waiting for their help from being put to sleep.
export function startRequestLoops(): void {
  setInterval(() => {
    for (const r of requests.pending()) {
      if (r.kind === 'help') box.touchDisplay(bots.display(bots.get(r.bot_id)!));
    }
  }, 60_000).unref();
  setInterval(() => {
    for (const r of requests.pending()) {
      if (now() - r.reminded_at < config.remindAfterMs) continue;
      requests.setReminded(r.id);
      tg.send(r.bot_id, `🔔 Still waiting for you here (${requestLabel(r)}).`, { replyTo: r.tg_msg_id ?? undefined }).catch(() => {});
    }
    links.purge();
  }, 5 * 60_000).unref();
}

// ======================================================= tools (from the box)
type Reply = { result: unknown } | { wait: string } | { error: string };
export const APPROVAL_SENT = 'The owner was asked to confirm with a button that shows the exact text. Nothing is saved until they approve; you will get a [system] note with the outcome. Do not repeat the text to them; add at most one short line.';

function scheduleUpdate(botId: number, a: any): { result: string } | { error: string } {
  const sc = schedules.get(a.id);
  if (!sc || sc.bot_id !== botId) return { error: 'No such schedule.' };
  const f: Record<string, unknown> = {};
  if (a.title) f.title = String(a.title).slice(0, 100);
  if (a.instructions) f.instructions = String(a.instructions);
  if (typeof a.needs_screen === 'boolean') f.needs_screen = a.needs_screen ? 1 : 0;
  if (a.model) f.model = a.model;
  if (typeof a.enabled === 'boolean') f.enabled = a.enabled ? 1 : 0;
  const cron = a.cron ? String(a.cron).trim() : sc.cron;
  if (a.cron || a.at || a.enabled === true) {
    // recompute from now, so resuming never fires a backlog
    const next = a.at ? parseLocal(String(a.at)) : cron ? nextCron(cron) : sc.next_run ?? 'This one-off schedule already ran; give a new time with at.';
    if (typeof next === 'string') return { error: next };
    f.next_run = next; f.cron = a.at ? null : cron;
  }
  schedules.update(sc.id, f);
  return { result: `Updated: ${describeSchedule(schedules.get(sc.id)!)}` };
}

/** Runs after the owner approved a schedule. */
function execSchedule(botId: number, exec: any): string {
  if (exec.kind === 'schedule_update') {
    const r = scheduleUpdate(botId, exec.a);
    if ('error' in r) throw new Error(r.error);
    return r.result;
  }
  const f = exec.f;
  const next = f.cron ? nextCron(f.cron) : parseLocal(f.at);
  if (typeof next === 'string') throw new Error(next);
  const sc = schedules.create(botId, { title: f.title, instructions: f.instructions, cron: f.cron, model: f.model, needsScreen: f.needsScreen, nextRun: next });
  return `Schedule #${sc.id} saved. First run: ${localTime(next)} (${config.timezone}).`;
}

export async function toolCall(ctx: RunContext, tool: string, a: any): Promise<Reply> {
  const bot = bots.get(ctx.botId)!;
  const task = ctx.taskId ? tasks.get(ctx.taskId) : undefined;
  const label = task ? `**#${task.id} ${task.title}**\n` : '';
  const ownTask = (id: number) => { const t = tasks.get(id); return t && t.bot_id === bot.id ? t : undefined; };

  const mail = await mailTool(ctx, bot, task, tool, a);
  if (mail) return mail;
  const fleet = await fleetTool(ctx, bot, tool, a);
  if (fleet) return fleet;

  switch (tool) {
    // ------------------------------------------------------------ chat session
    case 'start_task': {
      if (ctx.role !== 'front') break;
      const t = await createTask(bot.id, String(a.title), String(a.instructions), a.model, !!a.needs_screen);
      return { result: `Task #${t.id} created (${t.status}). The owner sees its status message and will receive the result automatically.` };
    }
    case 'schedule_create': {
      if (ctx.role !== 'front') break;
      if (!a.cron === !a.at) return { error: 'Give exactly one of cron (recurring) or at (one-off).' };
      const next = a.cron ? nextCron(String(a.cron)) : parseLocal(String(a.at));
      if (typeof next === 'string') return { error: next };
      const f = { title: String(a.title).slice(0, 100), instructions: String(a.instructions), cron: a.cron ? String(a.cron).trim() : null,
        at: a.cron ? null : String(a.at), model: a.model || config.taskModel, needsScreen: !!a.needs_screen };
      // A schedule keeps starting tasks from this brief for as long as it exists: the owner sees the exact text first.
      await createApproval(bot, undefined, `Schedule "${f.title}"`,
        `${f.cron ? `Repeats: \`${f.cron}\`` : 'Once'}, first run ${localTime(next)} (${config.timezone})${f.needsScreen ? ', with the screen' : ''}\n\nBrief:\n${f.instructions}`,
        { kind: 'schedule_create', f });
      return { result: APPROVAL_SENT };
    }
    case 'schedule_list':
      if (ctx.role !== 'front') break;
      return { result: scheduleList(bot.id) || 'No schedules.' };
    case 'schedule_update': {
      if (ctx.role !== 'front') break;
      const sc = schedules.get(a.id);
      if (!sc || sc.bot_id !== bot.id) return { error: 'No such schedule.' };
      // Pausing or renaming is harmless; what will run, or when, is the owner's to confirm.
      if (!a.instructions && !a.cron && !a.at && a.needs_screen === undefined && !a.model && a.enabled !== true) return scheduleUpdate(bot.id, a);
      for (const bad of [a.cron && nextCron(String(a.cron)), a.at && parseLocal(String(a.at))]) if (typeof bad === 'string') return { error: bad };
      const lines = [a.title && `Title: ${a.title}`, a.cron && `Repeats: \`${a.cron}\``, a.at && `Once at: ${a.at}`, a.enabled === true && 'Resumed', a.enabled === false && 'Paused',
        typeof a.needs_screen === 'boolean' && `Screen: ${a.needs_screen ? 'yes' : 'no'}`, a.model && `Model: ${a.model}`, a.instructions && `\nNew brief:\n${a.instructions}`];
      await createApproval(bot, undefined, `Change schedule #${sc.id} "${sc.title}"`, lines.filter(Boolean).join('\n'), { kind: 'schedule_update', a });
      return { result: APPROVAL_SENT };
    }
    case 'schedule_delete': {
      if (ctx.role !== 'front') break;
      const sc = schedules.get(a.id);
      return sc && sc.bot_id === bot.id && schedules.delete(sc.id) ? { result: 'Deleted.' } : { error: 'No such schedule.' };
    }
    case 'share_screen': {
      if (ctx.role !== 'front') break;
      const note = String(a.note || 'My screen, live.');
      await tg.send(bot.id, `🖥 ${note}`, {
        keyboard: new InlineKeyboard().webApp('🖥 Open my screen', await screenLink(bot.id, note)),
      });
      return { result: 'The owner received a button that opens your live screen inside Telegram, where they can watch it and take control. When they tap "I\'m done, go on" there, you are told. Do not describe the button; add at most one short line.' };
    }
    case 'list_tasks':
      return { result: taskList(bot.id) || 'No tasks yet.' };
    case 'cancel_task':
      if (ctx.role !== 'front') break;
      return { result: ownTask(a.task_id) ? await cancelTask(a.task_id) : 'No such task.' };
    case 'answer_task': {
      if (ctx.role !== 'front') break;
      const q = requests.pendingQuestions(bot.id).find((r) => r.task_id === a.task_id);
      if (!q) return { result: `Task #${a.task_id} is not waiting for an answer.` };
      resolveRequest(q.id, String(a.answer));
      return { result: 'Answer delivered to the task.' };
    }

    // ------------------------------------------------------------------ shared
    case 'send_file': {
      const p = String(a.path);
      const st = await box.stat(p);
      if (!st.isFile) return { error: 'Not a file.' };
      if (st.size <= config.telegramFileLimit) {
        const chunksBuf: Buffer[] = [];
        for await (const c of await box.getFile(p)) chunksBuf.push(c as Buffer);
        await tg.sendDocument(bot.id, Buffer.concat(chunksBuf), path.basename(p), a.caption);
        return { result: 'File sent to the owner.' };
      }
      const token = links.create('download', bot.id, null, { path: p });
      await tg.send(bot.id, `📎 ${a.caption ? a.caption + '\n' : ''}${path.basename(p)} (${Math.round(st.size / 1048576)} MB) is too large for Telegram.`, {
        keyboard: new InlineKeyboard().url('⬇️ Download (24 h)', `${config.publicUrl}/d/${token}`),
      });
      return { result: 'The file is too large for Telegram; the owner received a download link valid for 24 hours.' };
    }
    case 'list_secrets':
      return { result: secrets.names().map((s) => `${s.name}: ${s.description}`).join('\n') || 'No secrets stored.' };
    case 'request_secret': {
      // checked here, not only in the box: the name is what the owner is shown and what the value is filed under
      if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(String(a.name))) return { error: 'name: 2-64 characters, capital letters, digits and underscores, e.g. GITHUB_PASSWORD.' };
      a.description = String(a.description ?? '').slice(0, 300);
      const r = requests.create(bot.id, ctx.taskId, 'secret', { name: a.name, description: a.description, fromFront: ctx.role === 'front' });
      const token = links.create('secret', bot.id, r.id, { name: a.name, description: a.description });
      const msgId = await tg.send(bot.id, `${label}🔑 I need **${a.name}**: ${a.description}\nEnter it on a private page; I never see the value.`, {
        keyboard: new InlineKeyboard().webApp('🔑 Enter it', `${config.publicUrl}/s/${token}`),
      });
      requests.setMessage(r.id, msgId);
      if (task) refreshStatus(task.id, true);
      return ctx.role === 'front'
        ? { result: `The owner received a link to enter ${a.name}. You will get a [system] note when it is stored.` }
        : { wait: r.id };
    }

    // -------------------------------------------------------------- task only
    case 'send_message':
      if (ctx.role !== 'task') break;
      await tg.send(bot.id, `${label}${a.text}`);
      return { result: 'Sent.' };
    case 'ask_choice': {
      if (ctx.role !== 'front') break;
      const options = cleanOptions(a.options);
      if (options.length < 2) return { error: 'Give 2 to 5 options.' };
      dropChoices(bot.id);
      const r = requests.create(bot.id, null, 'choice', { question: a.question, options });
      requests.setMessage(r.id, await tg.send(bot.id, String(a.question), { keyboard: optionButtons(r.id, options) }));
      return { result: 'Sent with buttons. End your turn now and write nothing more: whatever the owner taps or types arrives as their next message.' };
    }
    case 'ask_user': {
      if (ctx.role !== 'task') break;
      const options = cleanOptions(a.options);
      const r = requests.create(bot.id, ctx.taskId, 'question', { question: a.question, options });
      requests.setMessage(r.id, await tg.send(bot.id, `${label}❓ ${a.question}\n\n_${options.length ? 'Tap an option, or reply' : 'Reply'} to this message to answer._`,
        options.length ? { keyboard: optionButtons(r.id, options) } : {}));
      refreshStatus(task!.id, true);
      return { wait: r.id };
    }
    case 'request_approval':
      if (ctx.role !== 'task') break;
      return { wait: await createApproval(bot, task, String(a.action), String(a.details)) };
    case 'request_help': {
      if (ctx.role !== 'task') break;
      const r = requests.create(bot.id, ctx.taskId, 'help', { reason: a.reason });
      const token = links.create('help', bot.id, r.id, { reason: a.reason });
      const msgId = await tg.send(bot.id, `${label}🖥 I need your hands: ${a.reason}`, {
        keyboard: new InlineKeyboard().webApp('🖥 Open my screen', helpUrl(token)).row()
          .text("✅ I'm done, go on", `hd:${r.id}`).text('✖️ Cancel', `hc:${r.id}`),
      });
      requests.setMessage(r.id, msgId);
      refreshStatus(task!.id, true);
      return { wait: r.id };
    }
    case 'nothing_to_report': {
      if (ctx.role !== 'task' || !task) break;
      if (!task.unattended) return { error: 'The owner started this task themselves and expects a result: end with it.' };
      tasks.update(task.id, { quiet: 1 });
      return { result: 'Noted: the owner will not be messaged about this run. End now; whatever you write as your last reply is kept as a note and not sent.' };
    }
    // The value never goes to the box: core types it on the screen itself.
    case 'type_secret': {
      if (ctx.role !== 'task' || !task?.needs_screen) break;
      const name = String(a.name);
      if (secrets.get(name) === undefined) return { error: `No secret named ${name}. Use request_secret first.` };
      // The owner said yes to this secret in this task already: they entered it for it, or approved typing it.
      const cleared = requests.forTask(task.id).some((r) => {
        if (r.status !== 'done') return false;
        const p = JSON.parse(r.payload);
        return r.kind === 'secret' ? p.name === name
          : r.kind === 'approval' && p.exec?.kind === 'secret_type' && p.exec.name === name && String(r.result).startsWith('approved and done');
      });
      if (cleared) return { result: await typeSecret(bot.id, name, task.id) };
      return { wait: await createApproval(bot, task, `Type the stored secret ${name} on my screen`,
        'It goes into whatever field is focused there right now. Open my screen first if you want to see where.',
        { kind: 'secret_type', name, taskId: task.id }) };
    }
  }
  return { error: `Unknown tool ${tool} for this session.` };
}

async function typeSecret(botId: number, name: string, taskId: number): Promise<string> {
  const bot = bots.get(botId)!;
  const value = secrets.get(name);
  if (value === undefined) throw new Error(`No secret named ${name}.`);
  const display = bots.display(bot);
  await box.ensureDisplay(display, bots.home(bot));
  await typeOnDisplay(display, value);
  log(`secret ${name} typed for task #${taskId}`);
  return `Typed ${name} into the focused field.`;
}

/** Called by the secret page when the owner submits a value. */
export function secretSubmitted(requestId: string | null, botId: number, name: string): void {
  if (!requestId) return;
  const r = requests.get(requestId);
  if (!r || !resolveRequest(requestId, `Secret ${name} is stored. Use type_secret to enter it.`)) return;
  if (JSON.parse(r.payload).fromFront) {
    events.add(botId, `The owner stored the secret ${name}.`);
    enqueueFront(botId, null);
  }
}
