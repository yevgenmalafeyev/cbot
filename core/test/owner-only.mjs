// Proves that a bot reacts to the owner and to nobody else.
//   docker exec cbot-core node /app/test/owner-only.mjs
// Builds every configured bot with the production handlers but a network that
// only records what the bot would send, then feeds it updates from a stranger
// and from the owner. Nothing is sent to Telegram and no session is started.
import { Bot } from 'grammy';
import { bots } from '/app/dist/db.js';
import { wire } from '/app/dist/telegram.js';
import { config } from '/app/dist/config.js';

const STRANGER = 999000111;
let failed = false;
let n = 1000;
const msg = (from, chatType, text) => ({
  update_id: n++,
  message: {
    message_id: n++, date: Math.floor(Date.now() / 1000), text,
    from: { id: from, is_bot: false, first_name: 'x' },
    chat: chatType === 'private' ? { id: from, type: 'private', first_name: 'x' } : { id: -100123, type: 'group', title: 'g' },
    ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] } : {}),
  },
});
const tap = (from) => ({
  update_id: n++,
  callback_query: { id: String(n++), from: { id: from, is_bot: false, first_name: 'x' }, chat_instance: '1', data: 'ap:doesnotexist:y',
    message: { message_id: 1, date: 0, chat: { id: from, type: 'private', first_name: 'x' } } },
});

for (const row of bots.all()) {
  const calls = [];
  const bot = new Bot('1:test', { botInfo: { id: 1, is_bot: true, first_name: row.name, username: 'test_bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false } });
  bot.api.config.use(async (_prev, method, payload) => { calls.push(method); return { ok: true, result: { message_id: 1, date: 0, chat: { id: payload.chat_id ?? 0, type: 'private' } } }; });
  wire(row, bot);
  const run = async (label, update, expectReaction) => {
    calls.length = 0;
    await bot.handleUpdate(update);
    const reacted = calls.length > 0;
    const ok = reacted === expectReaction;
    if (!ok) failed = true;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${row.slug.padEnd(14)} ${label.padEnd(44)} ${reacted ? 'reacted: ' + calls.join(',') : 'silent'}`);
  };
  await run('stranger: /start in private chat', msg(STRANGER, 'private', '/start'), false);
  await run('stranger: /help', msg(STRANGER, 'private', '/help'), false);
  await run('stranger: /secrets', msg(STRANGER, 'private', '/secrets'), false);
  await run('stranger: /screen', msg(STRANGER, 'private', '/screen'), false);
  await run('stranger: plain text', msg(STRANGER, 'private', 'do something'), false);
  await run('stranger: taps an Approve button', tap(STRANGER), false);
  await run('owner, but inside a group chat', msg(config.ownerId, 'group', '/help'), false);
  await run('owner: /help in private chat', msg(config.ownerId, 'private', '/help'), true);
}
console.log(failed ? '\nFAILED' : '\nAll bots react to the owner only.');
process.exit(failed ? 1 : 0);
