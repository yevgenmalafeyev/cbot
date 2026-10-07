// Telegram side: one grammY instance per bot, all locked to the owner.
import { Bot, Context, InlineKeyboard, InputFile } from 'grammy';
import path from 'node:path';
import { config } from './config.js';
import { BotRow, bots, db, requests, secrets, tasks } from './db.js';
import { box } from './box.js';
import * as agent from './agent.js';
import { botManaged, siblings } from './fleet.js';

const instances = new Map<number, Bot>();
/** both the update and the service message announce a new managed bot; handle it once */
const seenManaged = new Set<number>();
const api = (botId: number) => {
  const b = instances.get(botId);
  if (!b) throw new Error(`bot ${botId} is not running`);
  return b.api;
};

// ------------------------------------------------------------------ Mini App
// Every bot has a web version (gateway.ts, /a/<slug>). The Open button next to
// the message field is set here; the one in the chat list exists only for a
// bot with a Main Mini App, which only @BotFather can set, so the owner is
// told how, once per bot.
try { db.exec('ALTER TABLE bots ADD COLUMN app_hinted INTEGER NOT NULL DEFAULT 0'); } catch { /* already there */ }
export const appUrl = (row: BotRow) => `${config.publicUrl}/a/${row.slug}`;
/** The one-time instruction for the chat-list Open button; taking it counts as giving it. */
export function appHint(row: BotRow, username: string): string {
  db.prepare('UPDATE bots SET app_hinted = 1 WHERE id = ?').run(row.id);
  return `For an **Open** button on @${username} in the chat list: in @BotFather choose this bot → Bot Settings → Configure Mini App → enable it with this address:\n\`${appUrl(row)}\``;
}

// ---------------------------------------------------------------- formatting
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The subset of Markdown models actually write -> Telegram HTML. */
export function mdToHtml(md: string): string {
  const stash: string[] = [];
  const keep = (html: string) => `\u0000${stash.push(html) - 1}\u0000`;
  let s = md.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, code) => keep(`<pre>${esc(code.replace(/\n$/, ''))}</pre>`));
  s = s.replace(/`([^`\n]+)`/g, (_m, code) => keep(`<code>${esc(code)}</code>`));
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, t, u) => keep(`<a href="${esc(u).replace(/"/g, '&quot;')}">${esc(t)}</a>`));
  s = esc(s);
  s = s.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=[\s).,!?:;]|$)/gm, '$1<i>$2</i>');
  s = s.replace(/^(\s*)[-*]\s+/gm, '$1• ');
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => stash[Number(i)]);
}

function chunks(text: string, max = 3800): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest.trim()) out.push(rest);
  return out;
}

// ------------------------------------------------------------------- sending
export interface SendOpts { keyboard?: InlineKeyboard; replyTo?: number; plain?: boolean }

/** Send text to the owner (markdown in, split if long). Returns the last message id. */
export async function send(botId: number, text: string, opts: SendOpts = {}): Promise<number> {
  const parts = chunks(text || '…');
  let lastId = 0;
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    const extra = {
      link_preview_options: { is_disabled: true },
      ...(last && opts.keyboard ? { reply_markup: opts.keyboard } : {}),
      ...(i === 0 && opts.replyTo ? { reply_parameters: { message_id: opts.replyTo, allow_sending_without_reply: true } } : {}),
    };
    try {
      if (opts.plain) throw new Error('plain');
      lastId = (await api(botId).sendMessage(config.ownerId, mdToHtml(parts[i]), { parse_mode: 'HTML', ...extra })).message_id;
    } catch {
      // unbalanced markup: the text matters more than the formatting
      lastId = (await api(botId).sendMessage(config.ownerId, parts[i], extra)).message_id;
    }
  }
  return lastId;
}

export async function edit(botId: number, msgId: number, text: string, keyboard?: InlineKeyboard): Promise<void> {
  const extra = { link_preview_options: { is_disabled: true }, ...(keyboard ? { reply_markup: keyboard } : {}) };
  const body = text.length > 3900 ? text.slice(0, 3900) + '…' : text;
  try {
    await api(botId).editMessageText(config.ownerId, msgId, mdToHtml(body), { parse_mode: 'HTML', ...extra });
  } catch (e: any) {
    if (/not modified/i.test(e.message)) return;
    await api(botId).editMessageText(config.ownerId, msgId, body, extra).catch(() => {});
  }
}

/** Delete one of the bot's own messages (only possible for 48 hours; older ones are left alone). */
export const remove = (botId: number, msgId: number) => api(botId).deleteMessage(config.ownerId, msgId).then(() => true, () => false);

export const typing = (botId: number) => api(botId).sendChatAction(config.ownerId, 'typing').catch(() => {});

export async function sendDocument(botId: number, data: Buffer, filename: string, caption?: string): Promise<void> {
  await api(botId).sendDocument(config.ownerId, new InputFile(data, filename), caption ? { caption: caption.slice(0, 1000) } : {});
}

// ------------------------------------------------------------------ receiving
async function download(bot: Bot, fileId: string): Promise<Buffer> {
  const f = await bot.api.getFile(fileId);
  const res = await fetch(`https://api.telegram.org/file/bot${bot.token}/${f.file_path}`);
  if (!res.ok) throw new Error(`telegram file download: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function transcribe(audio: Buffer, filename: string): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)]), filename);
  form.append('model', 'whisper-large-v3-turbo');
  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST', headers: { authorization: `Bearer ${config.groqKey}` }, body: form,
  });
  if (!res.ok) throw new Error(`transcription failed: ${res.status}`);
  return ((await res.json()) as { text: string }).text.trim();
}

async function saveToInbox(row: BotRow, data: Buffer, name: string): Promise<string> {
  const safe = name.replace(/[^\w.\-() ]+/g, '_').slice(-120) || 'file';
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const p = `/home/bot/inbox/${row.slug}/${stamp}-${safe}`;
  await box.putFile(p, data);
  return p;
}

/** The main bot's username and whether Telegram lets it create bots for its owner ("Bot Management Mode"). */
export async function manager(): Promise<{ username: string; canManage: boolean }> {
  const me: any = await (await fetch(`https://api.telegram.org/bot${config.mainBotToken}/getMe`)).json();
  return { username: me.result?.username ?? '', canManage: !!me.result?.can_manage_bots };
}

export function wire(row: BotRow, bot: Bot) {
  // The owner created a bot through the one-tap link: Telegram reports it to
  // the managing (main) bot. Newer than the library's types, hence the cast;
  // it runs before the owner filter below, which cannot read this update type.
  bot.use(async (ctx, next) => {
    const u = ctx.update as any;
    const created = u.managed_bot?.bot ?? u.message?.managed_bot_created?.bot;
    if (!created) return next();
    // only the owner's own creations, and only on the managing bot
    const by = u.managed_bot?.user?.id ?? u.message?.from?.id;
    if (by === config.ownerId && !row.token_enc && !seenManaged.has(created.id)) {
      seenManaged.add(created.id);
      await botManaged(created);
    }
  });

  // Everyone except the owner is ignored without a reply: the bot's username
  // is discoverable, its existence should not be confirmed to strangers.
  bot.use(async (ctx, next) => { if (ctx.from?.id === config.ownerId && ctx.chat?.type === 'private') await next(); });

  bot.command('start', (ctx) => ctx.reply(`${bots.get(row.id)?.name ?? row.name} is online. Tell me what to do.\n/help lists the commands.`));
  // the main bot is also the way to the others
  if (!row.token_enc) bot.command('bots', (ctx) => {
    const list = siblings(row.id).map((b) => `<a href="https://t.me/${b.username}">${esc(b.name)}</a>${b.about ? `\n${esc(b.about)}` : ''}`);
    return ctx.reply(list.join('\n\n') || 'No other bots yet. Ask me to create one.', { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  });
  bot.command('help', (ctx) => ctx.reply([
    ...(row.token_enc ? [] : ['/bots - my other bots']),
    '/tasks - what is running',
    '/cancel <id> - stop a task',
    '/schedules - recurring and planned tasks',
    '/screen - a link to watch and control my screen',
    '/secrets - names of stored secrets',
    '/forget <NAME> - delete a stored secret',
    '/new - start a fresh conversation (memory file is kept)',
  ].join('\n')));
  bot.command('tasks', (ctx) => ctx.reply(agent.taskList(row.id) || 'No tasks yet.'));
  bot.command('schedules', (ctx) => ctx.reply(agent.scheduleList(row.id) || 'No schedules. Ask me in plain words to set one up.'));
  bot.command('cancel', async (ctx) => {
    const id = Number(ctx.match);
    const t = id ? tasks.get(id) : undefined;
    if (!t || t.bot_id !== row.id) return ctx.reply('Usage: /cancel <task id>');
    await ctx.reply(await agent.cancelTask(t.id));
  });
  bot.command('screen', async (ctx) => {
    const url = await agent.screenLink(row.id);
    await ctx.reply('Live screen. The button works for 24 hours.', {
      reply_markup: new InlineKeyboard().webApp('🖥 Open screen', url),
    });
  });
  bot.command('secrets', (ctx) => {
    const list = secrets.names();
    return ctx.reply(list.length ? list.map((s) => `${s.name} - ${s.description}`).join('\n') : 'No secrets stored.');
  });
  bot.command('forget', (ctx) => ctx.reply(secrets.delete(String(ctx.match).trim()) ? 'Deleted.' : 'No secret with that name.'));
  bot.command('new', (ctx) => { bots.setSession(row.id, null); return ctx.reply('Started a fresh conversation.'); });

  bot.on('callback_query:data', async (ctx) => {
    const [kind, id, arg] = ctx.callbackQuery.data.split(':');
    const text = await agent.handleButton(kind, id, arg);
    await ctx.answerCallbackQuery({ text }).catch(() => {});
  });

  bot.on('message', async (ctx: Context) => {
    const m = ctx.message!;
    try {
      let text = m.text ?? m.caption ?? '';
      const notes: string[] = [];

      const voice = m.voice ?? m.audio ?? m.video_note;
      if (voice) {
        if (!config.groqKey) { await ctx.reply('Voice messages are not set up yet (no transcription key).'); return; }
        const said = await transcribe(await download(bot, voice.file_id), 'voice.ogg');
        text = [text, said].filter(Boolean).join('\n');
        notes.push('(transcribed from a voice message)');
      }
      const doc = m.document ?? m.video ?? m.animation;
      const photo = m.photo?.at(-1);
      if (doc || photo) {
        const size = (doc ?? photo)!.file_size ?? 0;
        if (size > 20 * 1024 * 1024) { await ctx.reply('Telegram only lets bots download files up to 20 MB.'); return; }
        const name = (doc && 'file_name' in doc && doc.file_name) || (photo ? 'photo.jpg' : 'file');
        const saved = await saveToInbox(row, await download(bot, (doc ?? photo)!.file_id), path.basename(name));
        notes.push(`[system] The owner sent a file, saved at ${saved}`);
      }
      if (!text && !notes.length) return;

      // A reply to a task's question goes straight to that task.
      const replied = m.reply_to_message && requests.byMessage(row.id, m.reply_to_message.message_id);
      if (replied && replied.kind === 'question' && text) {
        agent.resolveRequest(replied.id, text);
        await ctx.react('👌').catch(() => {});
        return;
      }
      agent.dropChoices(row.id);
      agent.enqueueFront(row.id, [text, ...notes].filter(Boolean).join('\n'));
    } catch (e: any) {
      console.error(`[tg:${row.slug}]`, e);
      await ctx.reply(`Could not process that message: ${e.message}`).catch(() => {});
    }
  });

  bot.catch((err) => console.error(`[tg:${row.slug}]`, err.error));
}

export async function startBot(row: BotRow): Promise<void> {
  const bot = new Bot(bots.token(row));
  wire(row, bot);
  instances.set(row.id, bot);
  await bot.api.setMyCommands([
    ...(row.token_enc ? [] : [{ command: 'bots', description: 'My other bots' }]),
    { command: 'tasks', description: 'What is running' },
    { command: 'schedules', description: 'Recurring and planned tasks' },
    { command: 'screen', description: 'Watch my screen' },
    { command: 'cancel', description: 'Stop a task: /cancel <id>' },
    { command: 'new', description: 'Fresh conversation' },
    { command: 'help', description: 'All commands' },
  ]).catch(() => {});
  await bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'Open', web_app: { url: appUrl(row) } } })
    .catch((e) => console.error(`[tg:${row.slug}] menu button`, e.message));
  // long polling; resolves only when the bot stops
  bot.start({
    allowed_updates: ['message', 'callback_query', ...(row.token_enc ? [] : ['managed_bot'])] as any,
    onStart: (me) => {
      console.log(`[tg:${row.slug}] polling as @${me.username}`);
      if (!me.has_main_web_app && !(bots.get(row.id) as any)?.app_hinted) send(row.id, appHint(row, me.username)).catch(() => {});
    },
  }).catch((e) => console.error(`[tg:${row.slug}] stopped`, e));
}

export async function stopBot(botId: number): Promise<void> {
  await instances.get(botId)?.stop().catch(() => {});
  instances.delete(botId);
}

export async function stopAll(): Promise<void> {
  await Promise.all([...instances.values()].map((b) => b.stop().catch(() => {})));
}
