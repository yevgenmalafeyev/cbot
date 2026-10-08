// The tools a bot's Claude session gets on top of the built-in ones.
//
// Spawned by the Claude CLI over stdio, once per session. Two kinds of tools:
//   - control tools, forwarded to core (tasks, questions, help links, secrets,
//     approvals, file delivery). Some of them block for hours while the owner
//     is away, so they long-poll core instead of holding one request open.
//   - screen tools, executed right here against the bot's own X display.
//
// CBOT_ROLE decides which set is exposed: the chat-facing session ("front")
// only dispatches, a task session does the work.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const CORE = process.env.CBOT_CORE_URL;
const RUN_TOKEN = process.env.CBOT_RUN_TOKEN;
const ROLE = process.env.CBOT_ROLE || 'task';
const HAS_SCREEN = process.env.CBOT_SCREEN === '1';
const DISPLAY_N = process.env.CBOT_DISPLAY_N;
const BOT_HOME = process.env.CBOT_BOT_HOME;
const DISPLAY = `:${DISPLAY_N}`;
const xenv = { ...process.env, DISPLAY, CBOT_BOT_HOME: BOT_HOME };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (t) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] });

async function post(path, body) {
  const res = await fetch(CORE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${RUN_TOKEN}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`core ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

// Forward a tool call to core. If core answers {wait}, the result depends on
// the owner (a tap, a typed secret, a reply): poll until it arrives. Core being
// restarted in the meantime is fine, pending requests are in its database.
async function core(tool, args) {
  let r = await post('/internal/call', { tool, args });
  while (r.wait) {
    try { r = await post('/internal/wait', { id: r.wait }); }
    catch { await sleep(5000); r = { wait: r.wait }; }
  }
  if (r.error) throw new Error(r.error);
  return r.result;
}

const server = new McpServer({ name: 'cbot', version: '0.1.0' });
const tool = (name, description, shape, handler) =>
  server.tool(name, description, shape, async (args) => {
    try { return await handler(args); }
    catch (e) { return { isError: true, content: [{ type: 'text', text: String(e.message || e) }] }; }
  });
const coreTool = (name, description, shape) => tool(name, description, shape, async (args) => text(await core(name, args)));

// ---------------------------------------------------------------- shared tools
coreTool('send_file',
  'Send a file from this machine to the owner in Telegram. Files over 50 MB are delivered as an expiring download link.',
  { path: z.string().describe('Absolute path under /home/bot'), caption: z.string().optional() });

coreTool('list_secrets',
  'List the names of stored secrets (passwords, tokens). Values are never shown to you.', {});

coreTool('request_secret',
  'Ask the owner for a password or other secret. They get a one-time link to a page with a single field; the value is stored encrypted under the given name and never shown to you. ' +
  (ROLE === 'task' ? 'Blocks until they submit it. Afterwards use type_secret to enter it.' : 'Returns immediately; the owner is told what to do.'),
  { name: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/).describe('Environment-variable style name, e.g. GITHUB_PASSWORD'),
    description: z.string().describe('What it is and what it is for, shown to the owner') });

coreTool('mail_accounts', 'List the mail accounts connected to this bot.', {});

// ----------------------------------------------------------------- front tools
if (ROLE === 'front') {
  coreTool('start_task',
    'Start a background task run by a separate agent on this machine. Returns immediately with the task id; the owner gets a live status message and the result when it finishes. Use this for anything beyond a quick answer.',
    { title: z.string().describe('Short title shown to the owner, in their language'),
      instructions: z.string().describe('Complete, self-contained brief: goal, relevant context from the conversation, what to deliver. The task agent sees nothing else.'),
      needs_screen: z.boolean().describe('true if the task needs the desktop or the browser. Screen tasks of one bot run one at a time.'),
      model: z.enum(['sonnet', 'opus', 'haiku']).optional().describe('sonnet (default) for screen and routine work, opus for hard reasoning or coding, haiku for trivial checks') });
  const when = {
    cron: z.string().optional().describe('Recurring: 5-field cron (minute hour day-of-month month day-of-week) in the owner\'s timezone, e.g. "0 9 * * 1-5" = weekdays 09:00'),
    at: z.string().optional().describe('One-off: local date and time, "YYYY-MM-DD HH:MM"'),
  };
  coreTool('schedule_create',
    'Plan a task to run later or repeatedly. At each due time a background task is started from the stored brief, exactly as with start_task. Give either cron or at. The owner sees the brief and confirms it with a button before it is saved.',
    { title: z.string(), instructions: z.string().describe('Complete, self-contained brief; it is reused unchanged on every run, so do not reference "today\'s conversation"'),
      needs_screen: z.boolean(), model: z.enum(['sonnet', 'opus', 'haiku']).optional(), ...when });
  coreTool('schedule_list', 'List this bot\'s schedules with their next run time.', {});
  coreTool('schedule_update', 'Change, pause (enabled=false) or resume (enabled=true) a schedule. Anything other than pausing or renaming is confirmed by the owner with a button first.',
    { id: z.number().int(), title: z.string().optional(), instructions: z.string().optional(), needs_screen: z.boolean().optional(),
      model: z.enum(['sonnet', 'opus', 'haiku']).optional(), enabled: z.boolean().optional(), ...when });
  coreTool('schedule_delete', 'Delete a schedule.', { id: z.number().int() });
  coreTool('ask_choice',
    'Ask the owner one question with tap-to-answer buttons. This is how you ask anything that has a few likely answers: a clarification, a preference, a go-ahead. One question per call. They can always type a different answer instead. After calling it, end your turn without further text.',
    { question: z.string().describe('The question only, short, in the owner\'s language. No preamble, no list of other questions. (Long only when you present a draft for a go-ahead.)'),
      options: z.array(z.string().max(60)).min(2).max(5).describe('Short answers, the one you recommend first. Do not add an "other" option; typing covers that.') });
  coreTool('list_bots', 'List the owner\'s bots (you and your siblings) with their roles.', {});
  coreTool('create_bot',
    'Create a new bot with its own Telegram identity, chat history, memory, browser profile and screen. Call it only after you have interviewed the owner and they agreed to the instructions you drafted (see your system prompt). The owner then creates the Telegram account in @BotFather and submits its token on a private page.',
    { name: z.string().describe('Display name, e.g. "Mail assistant"'),
      slug: z.string().describe('Short id used for its folder, lowercase with dashes, e.g. "mail"'),
      username: z.string().optional().describe('Suggested Telegram username: letters, digits, underscores, ending in "bot", e.g. "anna_mail_helper_bot". Pick something unlikely to be taken.'),
      instructions: z.string().describe('The new bot\'s standing role and instructions, written to the bot in the second person. This is all it will know about its job.'),
      icon_svg: z.string().describe('Profile picture as a complete SVG document, viewBox="0 0 512 512": a simple, bold, flat icon that says what the bot does, on a full-bleed coloured background (Telegram crops it to a circle, so keep the motif inside the central 60%). Two or three colours, basic shapes and paths only: no text, no external images, no fonts, no scripts. Different bots should get clearly different colours.') });
  coreTool('update_bot', 'Change a bot\'s name, rewrite its standing instructions (give the complete new text), or give it a new profile picture. Works on yourself too. A new name or new instructions take effect only after the owner approves the exact text with a button.',
    { slug: z.string(), name: z.string().optional(), instructions: z.string().optional(),
      icon_svg: z.string().optional().describe('New profile picture as a complete SVG document, viewBox="0 0 512 512": a simple, bold, flat icon that says what the bot does, on a full-bleed coloured background (Telegram crops it to a circle, so keep the motif inside the central 60%). Two or three colours, basic shapes and paths only: no text, no external images, no fonts, no scripts. Different bots should get clearly different colours.') });
  coreTool('delete_bot', 'Remove a bot. The owner confirms with a button first.', { slug: z.string() });
  coreTool('delegate_task',
    'Hand a task to another bot when it is that bot\'s job (its accounts, its logins, its role). It runs there as a normal background task; the owner gets the result in that bot\'s chat.',
    { to: z.string().describe('Slug of the other bot'), title: z.string(), instructions: z.string().describe('Complete, self-contained brief'),
      needs_screen: z.boolean(), model: z.enum(['sonnet', 'opus', 'haiku']).optional() });
  coreTool('connect_gmail', 'Send the owner a link to connect one of their Gmail accounts to this bot (Google sign-in). They can connect several, one at a time.', {});
  coreTool('connect_imap', 'Connect a non-Gmail mailbox over IMAP/SMTP. The owner gets a private page for the password; the login is verified before the account is saved.',
    { address: z.string(), imap_host: z.string(), imap_port: z.number().int().optional().describe('default 993'),
      smtp_host: z.string(), smtp_port: z.number().int().optional().describe('default 465'), username: z.string().optional().describe('default: the address') });
  coreTool('mail_disconnect', 'Remove a connected mail account from this bot.', { account: z.string() });
  coreTool('mail_watch_create',
    'Watch a mailbox for future messages matching a search and start a background task for each one. Checking costs nothing; use it for "when X writes, do Y" and for waiting on a specific reply. Messages that do not match are ignored. The owner sees the brief and confirms it with a button before the watch starts.',
    { account: z.string(), title: z.string(), query: z.string().describe('Gmail search syntax, e.g. from:support@acme.com subject:refund. On IMAP accounts only from:, to:, subject:, is:unread and plain words work.'),
      instructions: z.string().describe('Complete brief for the task that handles each matching message'),
      once: z.boolean().optional().describe('true: stop after the first match (waiting for one particular message)'),
      needs_screen: z.boolean().optional(), model: z.enum(['sonnet', 'opus', 'haiku']).optional() });
  coreTool('mail_watch_list', 'List this bot\'s mail watches.', {});
  coreTool('mail_watch_delete', 'Delete a mail watch.', { id: z.number().int() });
  coreTool('share_screen',
    'Send the owner a button that opens your live desktop inside Telegram, where they can watch it and take control with mouse and keyboard. Use it when they ask to see your screen or to do something on it themselves. Returns immediately.',
    { note: z.string().optional().describe('One short line shown above the button, in the owner\'s language') });
  coreTool('list_tasks', 'List recent tasks of this bot with their status and latest progress line.', {});
  coreTool('cancel_task', 'Stop a running or queued task.', { task_id: z.number().int() });
  coreTool('answer_task',
    'Deliver the owner\'s reply to a task that is waiting on a question it asked them.',
    { task_id: z.number().int(), answer: z.string() });
}

// ------------------------------------------------------------------ task tools
if (ROLE === 'task') {
  coreTool('nothing_to_report',
    'For runs started by a schedule or by arriving mail: the run went well and there is nothing the owner needs to hear about. They are then not messaged at all. Call it once, then end.',
    {});
  coreTool('send_message',
    'Send the owner a short interim message. Not for the final result: that is your last reply.',
    { text: z.string() });
  const acct = z.string().describe('Address of a connected account (see mail_accounts)');
  coreTool('mail_search', 'Search a connected mailbox. Returns ids, sender, subject, date, snippet.',
    { account: acct, query: z.string().describe('Gmail search syntax (from:, subject:, is:unread, newer_than:7d, has:attachment, plain words). On IMAP accounts: from:, to:, subject:, is:unread, newer_than:Nd, plain words.'),
      max: z.number().int().min(1).max(50).optional() });
  coreTool('mail_read', 'Read one message in full (headers, text body, attachment list).',
    { account: acct, id: z.string(), save_attachments: z.boolean().optional().describe('true: also save the attachments to this machine and return their paths') });
  coreTool('mail_modify', 'Reversible housekeeping on messages.',
    { account: acct, ids: z.array(z.string()).min(1).max(100), action: z.enum(['mark_read', 'mark_unread', 'archive', 'unarchive', 'star', 'unstar', 'add_label', 'remove_label']),
      label: z.string().optional().describe('For add_label / remove_label (Gmail accounts only): the label name, "Parent/Child" for a nested one. add_label creates a label that does not exist yet.') });
  coreTool('mail_labels', 'List the labels of a connected Gmail account.', { account: acct });
  coreTool('mail_send',
    'Send an email from a connected account. The owner is shown the exact message with Approve/Deny and it is sent only after they approve; this call blocks until then and returns the outcome. Do not call request_approval for it separately.',
    { account: acct, to: z.string().describe('Comma-separated recipients'), cc: z.string().optional(), bcc: z.string().optional(), subject: z.string(), body: z.string().describe('Plain text'),
      reply_to_id: z.string().optional().describe('Id of the message this replies to; keeps it in the same thread'),
      attachments: z.array(z.string()).optional().describe('Absolute paths under /home/bot') });
  coreTool('mail_trash', 'Move messages to Trash. Asks the owner for approval first and blocks until they answer.',
    { account: acct, ids: z.array(z.string()).min(1).max(100), summary: z.string().describe('What these messages are, shown to the owner') });
  coreTool('ask_user',
    'Ask the owner a question you cannot resolve yourself and wait for the answer. Blocks until they reply (possibly hours). Other tasks keep running meanwhile.',
    { question: z.string(), options: z.array(z.string().max(60)).max(5).optional().describe('Likely answers shown as buttons, your recommendation first; the owner can still type something else') });
  coreTool('request_approval',
    'REQUIRED before: spending money; sending email/messages or submitting forms in the owner\'s name; posting anything publicly; deleting data or making irreversible changes in their accounts. Shows the owner the exact action with Approve/Deny buttons and blocks until they tap. Returns "approved" or "denied" (with an optional note). Never proceed without "approved".',
    { action: z.string().describe('One line: what you are about to do'),
      details: z.string().describe('The full content: draft text, recipient, amount, what gets deleted') });
}

// ---------------------------------------------------------------- screen tools
if (ROLE === 'task' && HAS_SCREEN) {
  let ready = false;
  async function ensureDisplay() {
    if (!ready) {
      await exec('cbot-display', ['ensure', DISPLAY_N, BOT_HOME], { timeout: 60_000 });
      ready = true;
    } else {
      // keeps boxd's idle reaper away while the task is using the screen
      exec('cbot-display', ['touch', DISPLAY_N]).catch(() => {});
    }
  }
  // The screen can go away under a running task (idle reaper, a crashed X
  // server): bring it back and try once more before the agent sees an error.
  async function onScreen(fn) {
    await ensureDisplay();
    try { return await fn(); } catch (e) {
      if (!/display/i.test(`${e.stderr ?? ''}${e.message ?? ''}`)) throw e;
      ready = false;
      await ensureDisplay();
      return fn();
    }
  }
  const xdo = (...args) => onScreen(() => exec('xdotool', args.map(String), { env: xenv, timeout: 30_000 }));

  async function shot(note) {
    const { stdout } = await onScreen(() => exec('maim', ['--format', 'png'], { env: xenv, encoding: 'buffer', maxBuffer: 32e6, timeout: 20_000 }));
    const content = [{ type: 'image', data: stdout.toString('base64'), mimeType: 'image/png' }];
    if (note) content.unshift({ type: 'text', text: note });
    return { content };
  }
  // Every action answers with a fresh screenshot, saving a round trip.
  async function act(fn, settleMs = 700) {
    await ensureDisplay();
    await fn();
    await sleep(settleMs);
    return shot();
  }
  const xy = { x: z.number().int().describe('pixels from the left edge'), y: z.number().int().describe('pixels from the top edge') };
  const BUTTON = { left: 1, middle: 2, right: 3 };

  tool('screenshot', 'Look at your screen (1280x800). Coordinates in the other tools are pixels in this image.', {}, () => shot());

  tool('open_url', 'Open a URL in your Chrome (starts Chrome if needed). Much faster than clicking through the desktop.',
    { url: z.string() },
    ({ url }) => act(async () => {
      spawn('chrome', [url], { env: xenv, detached: true, stdio: 'ignore' }).unref();
    }, 3500));

  tool('click', 'Click at a position.',
    { ...xy, button: z.enum(['left', 'middle', 'right']).optional(), count: z.number().int().min(1).max(3).optional().describe('2 = double click, 3 = triple click (select line)') },
    ({ x, y, button = 'left', count = 1 }) => act(async () => {
      await xdo('mousemove', x, y);
      await xdo('click', '--repeat', count, '--delay', 80, BUTTON[button]);
    }));

  tool('move_mouse', 'Move the pointer without clicking (hover).', xy,
    ({ x, y }) => act(() => xdo('mousemove', x, y)));

  tool('drag', 'Press the left button at one position, move, release at another.',
    { from_x: z.number().int(), from_y: z.number().int(), to_x: z.number().int(), to_y: z.number().int() },
    ({ from_x, from_y, to_x, to_y }) => act(async () => {
      await xdo('mousemove', from_x, from_y, 'mousedown', 1);
      await sleep(150);
      // intermediate point: many drag handlers ignore a single jump
      await xdo('mousemove', Math.round((from_x + to_x) / 2), Math.round((from_y + to_y) / 2));
      await sleep(100);
      await xdo('mousemove', to_x, to_y);
      await sleep(150);
      await xdo('mouseup', 1);
    }));

  tool('type_text', 'Type text into the focused field. Does not press Enter.',
    { text: z.string() },
    ({ text: t }) => act(async () => {
      if (/^[\x20-\x7e]*$/.test(t)) {
        await xdo('type', '--delay', 12, '--', t);
      } else {
        // xdotool mistypes characters outside the current keymap; paste instead
        await new Promise((resolve, reject) => {
          const p = spawn('xclip', ['-selection', 'clipboard'], { env: xenv, stdio: ['pipe', 'ignore', 'ignore'] });
          p.on('error', reject); p.on('close', resolve); p.stdin.end(t);
        });
        await xdo('key', 'ctrl+v');
      }
    }));

  tool('press_key', 'Press a key or key combination, xdotool syntax: Return, Tab, Escape, BackSpace, ctrl+a, ctrl+l, alt+Left, Page_Down, F5 ...',
    { keys: z.string(), repeat: z.number().int().min(1).max(50).optional() },
    ({ keys, repeat = 1 }) => act(() => xdo('key', '--repeat', repeat, '--delay', 60, keys)));

  tool('scroll', 'Scroll the mouse wheel at a position.',
    { ...xy, direction: z.enum(['up', 'down', 'left', 'right']), clicks: z.number().int().min(1).max(30).optional().describe('wheel notches, default 5') },
    ({ x, y, direction, clicks = 5 }) => act(async () => {
      await xdo('mousemove', x, y);
      await xdo('click', '--repeat', clicks, '--delay', 30, { up: 4, down: 5, left: 6, right: 7 }[direction]);
    }));

  tool('wait', 'Wait for the screen to change (page load, download), then look.',
    { seconds: z.number().min(0.5).max(60) },
    ({ seconds }) => act(() => sleep(seconds * 1000), 0));

  tool('type_secret',
    'Type a stored secret into the focused field without ever seeing it. Click the password field first. Only use it in the real login field of the site the secret belongs to. A secret the owner did not enter for this task is typed only after they approve it with a button, so this can block until they tap.',
    { name: z.string() },
    async ({ name }) => {
      await ensureDisplay();
      // the control service types it on the screen itself; the value never comes here
      const note = await core('type_secret', { name });
      await sleep(400);
      return text(note);
    });

  tool('request_help',
    'Hand your screen to the owner when you are stuck on something only a human can do: a captcha, a login with 2FA, a confirmation on their phone. They get a one-time link to view and control this screen. Blocks until they press "I\'m done, go on" (or Cancel, if they will not do it), then returns their answer and a screenshot. Leave the screen exactly where they need to act.',
    { reason: z.string().describe('What you need them to do, in their language. Do not say which button to press afterwards: the buttons are shown next to this text.') },
    async ({ reason }) => {
      await ensureDisplay();
      const note = await core('request_help', { reason });
      return shot(note);
    });
}

await server.connect(new StdioServerTransport());
