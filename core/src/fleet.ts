// The fleet: creating, changing and removing bots from chat, and handing work
// from one bot to another.
//
// A bot is a row in `bots` plus its own Telegram identity, chat session,
// memory file, Chrome profile and screen. All bots share one machine, the
// files on it and the secret store. Telegram only lets a person create a bot,
// so the owner makes it in @BotFather and submits the token on a private page.
import { InlineKeyboard } from 'grammy';
import { config } from './config.js';
import { db, bots, decrypt, encrypt, events, links, tasks, now, BotRow, LinkRow, TaskRow } from './db.js';
import { box } from './box.js';
import { createApproval, createTask, enqueueFront, quoted, APPROVAL_SENT } from './agent.js';
import { RunContext } from './claude.js';
import * as tg from './telegram.js';

// Columns added after the first release.
for (const col of ['deleted INTEGER NOT NULL DEFAULT 0', 'username TEXT']) {
  try { db.exec(`ALTER TABLE bots ADD COLUMN ${col}`); } catch { /* already there */ }
}
try { db.exec('ALTER TABLE tasks ADD COLUMN origin_bot_id INTEGER'); } catch { /* already there */ }

const MAX_BOTS = 12;
type Reply = { result: unknown } | { wait: string } | { error: string };
type Bot = BotRow & { deleted: number; username: string | null };

const live = () => bots.all() as Bot[];
const bySlug = (slug: string) => live().find((b) => b.slug === String(slug ?? '').toLowerCase());
const describe = (b: Bot) => `${b.slug}: "${b.name}"${b.username ? ` (@${b.username})` : ''}${b.instructions ? ` - ${b.instructions.split('\n')[0].slice(0, 140)}` : ''}`;

/** The other bots, for the main bot's /bots and Mini App: where to find each and one line on what it does. */
export const siblings = (botId: number) => live().filter((b) => b.id !== botId && b.username).map((b) => ({
  name: b.name,
  username: b.username!,
  about: (b.instructions.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 140),
}));

export async function fleetTool(ctx: RunContext, bot: BotRow, tool: string, a: any): Promise<Reply | undefined> {
  if (!['create_bot', 'list_bots', 'update_bot', 'delete_bot', 'delegate_task'].includes(tool)) return undefined;
  // Only chat sessions manage the fleet. Tasks cannot, which also means work
  // can be handed on once and never bounces between bots.
  if (ctx.role !== 'front') return { error: 'Only the chat session can manage bots or delegate.' };

  switch (tool) {
    case 'list_bots':
      return { result: live().map((b) => (b.id === bot.id ? `${describe(b)} (this is you)` : describe(b))).join('\n') };

    case 'create_bot': {
      const slug = String(a.slug ?? '').toLowerCase();
      if (!/^[a-z][a-z0-9-]{1,23}$/.test(slug)) return { error: 'slug: 2-24 characters, lowercase letters, digits and dashes, starting with a letter.' };
      if (db.prepare('SELECT 1 FROM bots WHERE slug = ?').get(slug)) return { error: `The slug "${slug}" is already taken.` };
      if (live().length >= MAX_BOTS) return { error: `There are already ${MAX_BOTS} bots, which is the limit.` };
      // Without one the bot gets the initial-on-a-colour fallback, which looks like no picture at all in Telegram.
      if (!/<svg[\s>]/i.test(String(a.icon_svg ?? ''))) return { error: 'icon_svg is missing: design the bot\'s profile picture as a complete SVG document (see the tool description) and call create_bot again with it.' };
      const name = String(a.name).slice(0, 60);
      const username = suggestUsername(a.username, slug);
      const token = links.create('secret', bot.id, null, {
        name: `Telegram token for "${name}"`,
        description: 'The token @BotFather gave you for the new bot (looks like 123456789:AA...).',
        newBot: { slug, name, instructions: String(a.instructions), username, icon: a.icon_svg ? String(a.icon_svg) : null },
      });
      const manager = await tg.manager();
      if (manager.canManage) {
        // Telegram's own "create bot" dialog, pre-filled; the token then reaches
        // the main bot by itself (see botManaged below).
        await tg.send(bot.id, `🤖 **${name}** is ready to be born. Tap the button, confirm in Telegram, and it starts by itself.`, {
          keyboard: new InlineKeyboard().url('➕ Create the bot', `https://t.me/newbot/${manager.username}/${username}?name=${encodeURIComponent(name)}`),
        });
        return { result: 'The owner received a one-tap link that opens Telegram\'s create-bot dialog with the name pre-filled. You will get a [system] note when the bot is running.' };
      }
      await tg.send(bot.id, [
        `🤖 **${name}** needs a Telegram account. In @BotFather:`,
        '1. Send `/newbot`',
        `2. Name: send \`${name}\``,
        `3. Username: send \`${username}\` (tap to copy; if taken, add a digit)`,
        '4. Tap the token in its reply to copy it, then paste it on the token page',
        '',
        `_One-time shortcut for next time: in @BotFather open the mini app → @${manager.username} → Settings → enable "Bot Management Mode". After that, creating a bot is a single tap._`,
      ].join('\n'), { keyboard: new InlineKeyboard().url('1️⃣ Open BotFather', 'https://t.me/BotFather').row().webApp('2️⃣ Paste the token', `${config.publicUrl}/s/${token}`) });
      return { result: 'The owner received short BotFather steps, a link to BotFather and a private page for the token. You will get a [system] note when the bot is running. Its instructions are stored exactly as you wrote them.' };
    }

    case 'update_bot': {
      const target = bySlug(a.slug);
      if (!target) return { error: `No bot "${a.slug}".` };
      const name = a.name ? String(a.name).slice(0, 60) : undefined;
      const instructions = typeof a.instructions === 'string' ? a.instructions : undefined;
      if (a.icon_svg) {
        const err = await setIcon(target, String(a.icon_svg));
        if (err) return { error: `The picture was not changed: ${err}` };
        if (name === undefined && instructions === undefined) return { result: `New profile picture set for ${target.slug}.` };
      }
      if (name === undefined && instructions === undefined) return { error: 'Nothing to change.' };
      // Instructions steer everything a bot does from then on: the owner sees the exact new text first.
      await createApproval(bot, undefined, `Change the bot "${target.name}"`,
        [name !== undefined && `New name: ${name}`, instructions !== undefined && `New instructions:\n${instructions}`].filter(Boolean).join('\n\n'),
        { kind: 'bot_update', botId: target.id, by: bot.id, name, instructions });
      return { result: APPROVAL_SENT };
    }

    case 'delete_bot': {
      const target = bySlug(a.slug);
      if (!target) return { error: `No bot "${a.slug}".` };
      if (!target.token_enc) return { error: 'The main bot cannot be deleted.' };
      await createApproval(bot, undefined, `Delete the bot "${target.name}"${target.username ? ` (@${target.username})` : ''}`,
        'It stops answering and its schedules and mail watches are removed. Its files and memory stay on the machine. The Telegram account itself can only be removed in @BotFather.',
        { kind: 'bot_delete', botId: target.id });
      return { result: 'The owner was asked to confirm with a button. Nothing is deleted until they approve.' };
    }

    case 'delegate_task': {
      const target = bySlug(a.to);
      if (!target) return { error: `No bot "${a.to}". Use list_bots.` };
      if (target.id === bot.id) return { error: 'That is you; use start_task.' };
      const t = await createTask(target.id, String(a.title), `${a.instructions}\n\n(Handed over by the bot "${bot.name}".)`, a.model, !!a.needs_screen);
      db.prepare('UPDATE tasks SET origin_bot_id = ? WHERE id = ?').run(bot.id, t.id);
      return { result: `Task #${t.id} was started for "${target.name}". The owner gets the result in that bot's chat; you will see a [system] note with it on your next turn.` };
    }
  }
  return undefined;
}

/** Tell the bot that handed a task over how it ended. */
export function noteDelegated(t: TaskRow, ok: boolean, body: string): void {
  const origin = (t as TaskRow & { origin_bot_id?: number | null }).origin_bot_id;
  if (!origin) return;
  const worker = bots.get(t.bot_id);
  events.add(origin, `The task "${t.title}" you handed to "${worker?.name}" ${ok ? 'finished' : 'FAILED'}; the owner received this in that bot's chat:\n${quoted(body.slice(0, 2000))}`);
}

/** A plain but presentable icon when the creating bot supplied none: the initial on a colour derived from the slug. */
function fallbackIcon(name: string, slug: string): string {
  const hue = [...slug].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  const letter = (name.trim()[0] ?? '?').toUpperCase().replace(/[<&>]/g, '?');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="hsl(${hue},70%,55%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},75%,40%)"/></linearGradient></defs>
<rect width="512" height="512" fill="url(#g)"/><text x="256" y="345" font-family="DejaVu Sans, sans-serif" font-weight="700" font-size="270" text-anchor="middle" fill="#fff">${letter}</text></svg>`;
}

/** Render an SVG on the bots' machine and set it as the bot's Telegram profile photo. Returns an error text, or null. */
export async function setIcon(target: BotRow, svg: string): Promise<string | null> {
  try {
    if (!/<svg[\s>]/i.test(svg) || svg.length > 60_000) throw new Error('not an SVG, or larger than 60 kB');
    const dir = `/home/bot/bots/${target.slug}`;
    await box.putFile(`${dir}/icon.svg`, Buffer.from(svg));
    const exit = await box.run({ id: `icon-${target.id}-${now()}`, cmd: 'cbot-render-icon', args: [`${dir}/icon.svg`, `${dir}/icon.jpg`], cwd: dir, env: {}, stdin: '' }, () => {});
    if (exit.code !== 0) throw new Error(`rendering failed: ${exit.stderr.trim().split('\n').pop() || exit.error || 'unknown error'}`);
    const chunks: Buffer[] = [];
    for await (const c of await box.getFile(`${dir}/icon.jpg`)) chunks.push(c as Buffer);
    const form = new FormData();
    form.append('photo', JSON.stringify({ type: 'static', photo: 'attach://icon' }));
    form.append('icon', new Blob([new Uint8Array(Buffer.concat(chunks))], { type: 'image/jpeg' }), 'icon.jpg');
    const token = target.token_enc ? decrypt(target.token_enc) : config.mainBotToken;
    const r: any = await (await fetch(`https://api.telegram.org/bot${token}/setMyProfilePhoto`, { method: 'POST', body: form })).json();
    if (!r.ok) throw new Error(r.description || 'Telegram refused the photo');
    return null;
  } catch (e: any) {
    console.error(`[fleet] icon for ${target.slug}:`, e.message);
    return e.message;
  }
}

/** Telegram usernames: 5-32 characters, letters, digits and underscores, ending in "bot". */
function suggestUsername(wanted: unknown, slug: string): string {
  let u = String(wanted || `${slug}_assistant_bot`).replace(/^@/, '').replace(/[^A-Za-z0-9_]/g, '_');
  if (!/bot$/i.test(u)) u += '_bot';
  if (!/^[A-Za-z]/.test(u)) u = `b_${u}`;
  return u.slice(0, 32).padEnd(5, '_');
}

/** Store the new bot, start it, and tell the bot that asked for it. */
async function register(link: LinkRow, token: string, username: string): Promise<void> {
  const d = JSON.parse(link.data).newBot as { slug: string; name: string; instructions: string; icon?: string | null };
  if (token === config.mainBotToken || live().some((b) => b.username === username)) {
    throw new Error('That token belongs to a bot that is already running here. Create a new one.');
  }
  const r = db.prepare('INSERT INTO bots (slug, name, token_enc, instructions, username, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(d.slug, d.name, encrypt(token), d.instructions, username, now());
  links.use(link.token);
  const created = bots.get(Number(r.lastInsertRowid))!;
  const appHint = tg.appHint(created, username);
  await tg.startBot(created);
  // The picture is a nicety: try the designed icon, fall back to a generated one, never fail the creation over it.
  const iconErr = d.icon ? await setIcon(created, d.icon) : 'none was given';
  if (iconErr) await setIcon(created, fallbackIcon(d.name, d.slug));
  // Telegram does not let a bot write first, so the owner has to open it once.
  await tg.send(link.bot_id, `✅ **${d.name}** is running as @${username}. Open it and press Start; from then on you talk to it there.\n\n${appHint}`, {
    keyboard: new InlineKeyboard().url(`Open @${username}`, `https://t.me/${username}`),
  }).catch(() => {});
  events.add(link.bot_id, `The new bot "${d.name}" is running as @${username}; the owner was told to open it and press Start. Do not repeat that; only mention anything the new bot still needs set up in its own chat.${iconErr ? ` Its profile picture is only a placeholder letter, because the icon you designed could not be used (${iconErr}): design a simpler one and set it with update_bot now.` : ''}`);
  enqueueFront(link.bot_id, null);
}

/** The owner pasted the BotFather token on the page of a create_bot link. Returns the new bot's @username. */
export async function botTokenSubmitted(link: LinkRow, token: string): Promise<string> {
  token = token.trim();
  if (!/^\d{6,}:[\w-]{30,}$/.test(token)) throw new Error('That does not look like a bot token (expected something like 123456789:AA...).');
  const me: any = await (await fetch(`https://api.telegram.org/bot${token}/getMe`)).json();
  if (!me.ok) throw new Error('Telegram rejected the token. Copy it again from @BotFather.');
  await register(link, token, me.result.username);
  return me.result.username;
}

/**
 * Second lock on a managed bot, enforced by Telegram itself: nobody but its
 * owner can open or message it. (The first lock is in telegram.ts: every bot
 * here ignores any update that is not from the owner.) Returns an error text, or null.
 */
export async function restrictToOwner(botUserId: number | string): Promise<string | null> {
  const r: any = await (await fetch(`https://api.telegram.org/bot${config.mainBotToken}/setManagedBotAccessSettings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user_id: Number(botUserId), is_access_restricted: true }),
  })).json();
  return r.ok ? null : String(r.description || 'refused');
}

/**
 * Telegram told the main bot that the owner created a bot for it to manage
 * (the one-tap path). Match it to the creation that is waiting and fetch its token.
 */
export async function botManaged(newBot: { id: number; username?: string }): Promise<void> {
  const pending = (db.prepare(`SELECT * FROM links WHERE kind = 'secret' AND used = 0 AND expires_at > ? AND data LIKE '%"newBot"%' ORDER BY rowid DESC`).all(now()) as LinkRow[]);
  // the owner may have changed the suggested username in the dialog: fall back to the latest request
  const link = pending.find((l) => JSON.parse(l.data).newBot.username?.toLowerCase() === newBot.username?.toLowerCase()) ?? pending[0];
  const main = bots.all()[0];
  if (!link) {
    await tg.send(main.id, `A bot @${newBot.username} was created for me to manage, but I have no bot waiting to be created. Ask me to create a bot first.`).catch(() => {});
    return;
  }
  try {
    const r: any = await (await fetch(`https://api.telegram.org/bot${config.mainBotToken}/getManagedBotToken?user_id=${newBot.id}`)).json();
    if (!r.ok || !r.result) throw new Error(r.description || 'Telegram did not return the token');
    await register(link, String(r.result), newBot.username ?? `bot${newBot.id}`);
    const err = await restrictToOwner(newBot.id);
    if (err) console.error(`[fleet] could not restrict @${newBot.username} to the owner at Telegram: ${err}`);
  } catch (e: any) {
    await tg.send(link.bot_id, `⚠️ The bot @${newBot.username} was created, but I could not take it over: ${e.message}`, { plain: true }).catch(() => {});
  }
}

/** Runs after the owner approved a fleet action. */
export async function execFleet(exec: any): Promise<string> {
  if (exec.kind === 'bot_update') {
    const target = bots.get(exec.botId);
    if (!target || (target as BotRow & { deleted?: number }).deleted) throw new Error('No such bot.');
    if (typeof exec.name === 'string') db.prepare('UPDATE bots SET name = ? WHERE id = ?').run(exec.name, target.id);
    if (typeof exec.instructions === 'string') db.prepare('UPDATE bots SET instructions = ? WHERE id = ?').run(exec.instructions, target.id);
    if (target.id !== exec.by) events.add(target.id, 'Your role and instructions were updated by the owner. They apply from now on.');
    return `Updated ${target.slug}. The new instructions apply from its next message.`;
  }
  if (exec.kind !== 'bot_delete') throw new Error('unknown action');
  const target = bots.get(exec.botId);
  if (!target || !target.token_enc) throw new Error('No such bot.');
  for (const t of [...tasks.byStatus('running'), ...tasks.byStatus('queued')]) {
    if (t.bot_id === target.id) await (await import('./agent.js')).cancelTask(t.id);
  }
  await tg.stopBot(target.id);
  db.prepare('DELETE FROM schedules WHERE bot_id = ?').run(target.id);
  db.prepare('DELETE FROM mail_watches WHERE bot_id = ?').run(target.id);
  db.prepare('DELETE FROM mail_accounts WHERE bot_id = ?').run(target.id);
  // The row stays (tasks refer to it); the slug is freed for reuse.
  db.prepare('UPDATE bots SET deleted = 1, token_enc = NULL, slug = ? WHERE id = ?').run(`${target.slug}~deleted-${target.id}`, target.id);
  return `The bot "${target.name}" was deleted.`;
}
