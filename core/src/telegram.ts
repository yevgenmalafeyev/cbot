// Telegram side: one grammY instance per bot, all locked to the owner.
import { Bot, Context, InlineKeyboard, InputFile } from 'grammy';
import path from 'node:path';
import { config } from './config.js';
import { BotRow, bots, db, events, messages, requests, secrets, tasks } from './db.js';
import { box } from './box.js';
import { multilingual, speak, speechReady } from './speech.js';
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
export interface SendOpts {
  keyboard?: InlineKeyboard; replyTo?: number; plain?: boolean;
  /** say it as well: the text goes out as a voice message (with the text as its caption when it fits) */
  voice?: boolean;
  /** language of the voice ("pt-PT", "uk", an Azure voice name); unset: guessed from the text */
  voiceLang?: string | null;
}

/** Send text to the owner (markdown in, split if long). Returns the last message id. */
export async function send(botId: number, text: string, opts: SendOpts = {}): Promise<number> {
  if (opts.voice && speechReady()) {
    const said = await sendSpoken(botId, text, opts).catch((e) => { console.error('[tg] spoken reply failed, sending text', e.message); return 0; });
    if (said) return said;
  }
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
    messages.put(botId, lastId, 'bot', parts[i]);
  }
  return lastId;
}

export async function edit(botId: number, msgId: number, text: string, keyboard?: InlineKeyboard): Promise<void> {
  const extra = { link_preview_options: { is_disabled: true }, ...(keyboard ? { reply_markup: keyboard } : {}) };
  const body = text.length > 3900 ? text.slice(0, 3900) + '…' : text;
  messages.put(botId, msgId, 'bot', body);
  try {
    await api(botId).editMessageText(config.ownerId, msgId, mdToHtml(body), { parse_mode: 'HTML', ...extra });
  } catch (e: any) {
    if (/not modified/i.test(e.message)) return;
    await api(botId).editMessageText(config.ownerId, msgId, body, extra).catch(() => {});
  }
}

/** Replace or remove the buttons under a message, leaving its text alone. */
export async function editMarkup(botId: number, msgId: number, keyboard?: InlineKeyboard): Promise<void> {
  await api(botId).editMessageReplyMarkup(config.ownerId, msgId, { reply_markup: keyboard })
    .catch((e: any) => { if (!/not modified/i.test(e.message)) throw e; });
}

/** Delete one of the bot's own messages (only possible for 48 hours; older ones are left alone). */
export const remove = (botId: number, msgId: number) => api(botId).deleteMessage(config.ownerId, msgId).then(() => true, () => false);

export const typing = (botId: number) => api(botId).sendChatAction(config.ownerId, 'typing').catch(() => {});
/** A reaction on one of the owner's messages: an acknowledgement that is not a message. */
export const react = (botId: number, msgId: number, emoji: '👍' | '👌') =>
  api(botId).setMessageReaction(config.ownerId, msgId, [{ type: 'emoji', emoji }]).catch(() => {});

// Messages that arrive together (the photos of an album, a few lines typed in
// a row) become one turn of the chat session, not one turn each. Telegram
// delivers an album as separate updates, so the only signal is time.
const BATCH_MS = 1500;
const batches = new Map<number, { parts: string[]; msgId: number; timer: NodeJS.Timeout }>();
function batch(row: BotRow, part: string, msgId: number): void {
  const b = batches.get(row.id) ?? { parts: [], msgId, timer: undefined as unknown as NodeJS.Timeout };
  clearTimeout(b.timer);
  b.parts.push(part);
  b.msgId = msgId;
  b.timer = setTimeout(() => {
    batches.delete(row.id);
    agent.dropChoices(row.id);
    agent.enqueueFront(row.id, b.parts.join('\n'), b.msgId);
  }, BATCH_MS);
  batches.set(row.id, b);
}

// Telegram shows a caption of up to 1024 characters under a voice message;
// a longer text is sent as a separate message after the voice.
const CAPTION_MAX = 1000;
/** Speak the text and send it as a voice message. Returns 0 when there is nothing to say aloud. */
async function sendSpoken(botId: number, text: string, opts: SendOpts): Promise<number> {
  const a = api(botId);
  a.sendChatAction(config.ownerId, 'record_voice').catch(() => {});
  const audio = await speak(text, opts.voiceLang ?? null);
  if (!audio) return 0;
  const fits = text.length <= CAPTION_MAX;
  const extra = {
    ...(fits && opts.keyboard ? { reply_markup: opts.keyboard } : {}),
    ...(opts.replyTo ? { reply_parameters: { message_id: opts.replyTo, allow_sending_without_reply: true } } : {}),
  };
  const file = () => new InputFile(audio, 'reply.ogg');
  let id: number;
  try {
    if (!fits) throw new Error('long');
    id = (await a.sendVoice(config.ownerId, file(), { caption: mdToHtml(text), parse_mode: 'HTML', ...extra })).message_id;
  } catch {
    id = (await a.sendVoice(config.ownerId, file(), fits ? { caption: text, ...extra } : extra)).message_id;
  }
  if (!fits) id = await send(botId, text, { ...opts, voice: false, replyTo: undefined });
  else messages.put(botId, id, 'bot', text);
  return id;
}

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

// The message id keeps the path unique: the photos of an album all arrive
// within the same second under the same name ("photo.jpg").
async function saveToInbox(row: BotRow, msgId: number, data: Buffer, name: string): Promise<string> {
  const safe = name.replace(/[^\w.\-() ]+/g, '_').slice(-120) || 'file';
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const p = `/home/bot/inbox/${row.slug}/${stamp}-${msgId}-${safe}`;
  await box.putFile(p, data);
  return p;
}

/** What a message said, for quoting it back to the model: its text, or what kind of thing it was. */
function gist(m: any, max = 600): string {
  const text: string = m.text ?? m.caption ?? '';
  const kind = m.photo ? 'a photo' : m.voice || m.audio ? 'a voice message' : m.video_note ? 'a video message'
    : m.document ? `the file ${m.document.file_name ?? ''}`.trim() : m.video ? 'a video' : m.sticker ? 'a sticker' : '';
  const t = text.length > max ? text.slice(0, max) + '…' : text;
  return kind ? (t ? `${kind}: "${t}"` : kind) : `"${t}"`;
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
    '/voice - spoken replies on or off',
    '/new - start a fresh conversation (memory file is kept)',
  ].join('\n')));
  bot.command('voice', (ctx) => {
    if (!speechReady()) return ctx.reply('Spoken replies are not set up (no Groq key).');
    const on = !bots.get(row.id)?.voice;
    bots.setVoice(row.id, on);
    events.add(row.id, `The owner turned spoken replies ${on ? 'on' : 'off'} with /voice.`);
    return ctx.reply(!on ? 'Spoken replies are off.'
      : `Spoken replies are on: my messages come as voice messages${multilingual() ? '' : ', in English'}. /voice turns them off.`);
  });
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
        const saved = await saveToInbox(row, m.message_id, await download(bot, (doc ?? photo)!.file_id), path.basename(name));
        notes.push(`[system] The owner sent a file, saved at ${saved}`);
      }
      if (!text && !notes.length) return;

      if (text) messages.put(row.id, m.message_id, 'owner', text);

      // A reply to a task's question goes straight to that task.
      const replied = m.reply_to_message && requests.byMessage(row.id, m.reply_to_message.message_id);
      if (replied && replied.kind === 'question' && text) {
        agent.resolveRequest(replied.id, text);
        await ctx.react('👌').catch(() => {});
        return;
      }
      // Any other reply: the model is shown what the owner is referring to.
      const quoted = m.reply_to_message as any;
      const context = quoted
        ? `[system] The owner replies to ${quoted.from?.id === config.ownerId ? 'their own earlier message' : 'your message'}${
          m.quote ? `, quoting this part of it: "${m.quote.text}"` : `: ${gist(quoted)}`}`
        : '';
      batch(row, [context, text, ...notes].filter(Boolean).join('\n'), m.message_id);
    } catch (e: any) {
      console.error(`[tg:${row.slug}]`, e);
      await ctx.reply(`Could not process that message: ${e.message}`).catch(() => {});
    }
  });

  // A reaction on a message is the owner's answer to it, without a message of
  // their own. Telegram sends only the message id; the text is kept in the db.
  bot.on('message_reaction', (ctx) => {
    const r = ctx.messageReaction!;
    const added = r.new_reaction.filter((n) => !r.old_reaction.some((o) => JSON.stringify(o) === JSON.stringify(n)));
    if (!added.length) return;                       // a reaction was removed: nothing to act on
    const emoji = added.map((x) => x.type === 'emoji' ? x.emoji : x.type === 'paid' ? '⭐' : 'a custom emoji').join(' ');
    const known = messages.get(row.id, r.message_id);
    const target = !known ? 'an earlier message' : known.who === 'owner' ? `their own message "${known.text}"` : `your message "${known.text}"`;
    const pending = requests.byMessage(row.id, r.message_id);
    let note = '';
    if (pending?.kind === 'choice') {
      // the reaction stands in for a tap: the buttons are stale now
      note = ` The buttons under it were: ${(JSON.parse(pending.payload).options as string[]).join(' | ')}.`;
      agent.dropChoices(row.id);
    } else if (pending) note = ' That message waits for a button tap or a reply, which a reaction does not replace.';
    events.add(row.id, `The owner reacted ${emoji} to ${target}.${note}`);
    agent.enqueueFront(row.id, null);
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
    { command: 'voice', description: 'Spoken replies on/off' },
    { command: 'new', description: 'Fresh conversation' },
    { command: 'help', description: 'All commands' },
  ]).catch(() => {});
  await bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'Open', web_app: { url: appUrl(row) } } })
    .catch((e) => console.error(`[tg:${row.slug}] menu button`, e.message));
  // long polling; resolves only when the bot stops
  bot.start({
    allowed_updates: ['message', 'message_reaction', 'callback_query', ...(row.token_enc ? [] : ['managed_bot'])] as any,
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
