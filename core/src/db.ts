import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
export const db = new Database(path.join(config.dataDir, 'cbot.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS bots (
  id           INTEGER PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  token_enc    BLOB,                 -- NULL for the main bot (token comes from the environment)
  instructions TEXT NOT NULL DEFAULT '',
  session_id   TEXT,                 -- the chat-facing Claude session
  created_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY,
  bot_id        INTEGER NOT NULL REFERENCES bots(id),
  title         TEXT NOT NULL,
  instructions  TEXT NOT NULL,
  model         TEXT NOT NULL,
  needs_screen  INTEGER NOT NULL,
  status        TEXT NOT NULL,       -- queued | running | waiting | done | failed | cancelled | interrupted
  session_id    TEXT,
  resume        INTEGER NOT NULL DEFAULT 0,   -- 1: continue session_id instead of starting over
  status_msg_id INTEGER,
  progress      TEXT,
  result        TEXT,
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  finished_at   INTEGER
);
CREATE TABLE IF NOT EXISTS requests (
  id          TEXT PRIMARY KEY,
  bot_id      INTEGER NOT NULL REFERENCES bots(id),
  task_id     INTEGER,
  kind        TEXT NOT NULL,         -- question | help | secret | approval
  payload     TEXT NOT NULL,         -- JSON
  status      TEXT NOT NULL,         -- pending | done | cancelled
  result      TEXT,
  tg_msg_id   INTEGER,
  created_at  INTEGER NOT NULL,
  reminded_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS links (
  token      TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,          -- help | secret | download
  bot_id     INTEGER NOT NULL,
  request_id TEXT,
  data       TEXT NOT NULL DEFAULT '{}',
  claim      TEXT,                   -- cookie value of the browser that opened it first
  used       INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS secrets (
  name        TEXT PRIMARY KEY,
  value_enc   BLOB NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS schedules (
  id           INTEGER PRIMARY KEY,
  bot_id       INTEGER NOT NULL REFERENCES bots(id),
  title        TEXT NOT NULL,
  instructions TEXT NOT NULL,
  cron         TEXT,                 -- 5-field cron in the configured timezone; NULL for a one-off
  model        TEXT NOT NULL,
  needs_screen INTEGER NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  next_run     INTEGER,              -- ms epoch; for a one-off this is its time
  last_run     INTEGER,
  last_task_id INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (   -- notes for a bot's chat session, delivered with its next turn
  id     INTEGER PRIMARY KEY,
  bot_id INTEGER NOT NULL,
  text   TEXT NOT NULL
);
`);

export interface BotRow {
  id: number; slug: string; name: string; token_enc: Buffer | null; instructions: string; session_id: string | null; created_at: number;
  /** 1: the owner wants to hear this bot: its messages go out as voice messages (speech.ts) */
  voice: number;
  /** language of spoken replies ("pt-PT", "uk", or an Azure voice name); NULL: guessed from each text */
  voice_lang: string | null;
}
for (const col of ['voice INTEGER NOT NULL DEFAULT 0', 'voice_lang TEXT']) {
  try { db.exec(`ALTER TABLE bots ADD COLUMN ${col}`); } catch { /* already there */ }
}
for (const col of ['unattended INTEGER NOT NULL DEFAULT 0', 'quiet INTEGER NOT NULL DEFAULT 0', 'resume_note TEXT', 'auto_approve INTEGER NOT NULL DEFAULT 0']) {
  try { db.exec(`ALTER TABLE tasks ADD COLUMN ${col}`); } catch { /* already there */ }
}

// Full-text index over finished tasks (brief and result), so a bot can recall
// what it did and found earlier. Rebuilt row by row as tasks finish.
let fts = true;
try {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS task_fts USING fts5(task_id UNINDEXED, bot_id UNINDEXED, title, body, tokenize='unicode61 remove_diacritics 2')`);
} catch (e: any) {
  fts = false;
  console.error('[db] full-text search unavailable:', e.message);
}
export const hasFts = () => fts;

export interface TaskRow {
  id: number; bot_id: number; title: string; instructions: string; model: string; needs_screen: number;
  status: string; session_id: string | null; resume: number; status_msg_id: number | null; progress: string | null;
  result: string | null; created_at: number; started_at: number | null; finished_at: number | null;
  /** 1: started by a schedule or by arriving mail, not by the owner just now */
  unattended: number;
  /** set by the task itself: it found nothing the owner needs to hear about */
  quiet: number;
  /** what to tell a paused (waiting) task when it is resumed: the owner's answer */
  resume_note: string | null;
  /** 1: the owner approved every further approval request of this task in advance */
  auto_approve: number;
}
export interface ScheduleRow {
  id: number; bot_id: number; title: string; instructions: string; cron: string | null; model: string; needs_screen: number;
  enabled: number; next_run: number | null; last_run: number | null; last_task_id: number | null; created_at: number;
}
export interface RequestRow { id: string; bot_id: number; task_id: number | null; kind: string; payload: string; status: string; result: string | null; tg_msg_id: number | null; created_at: number; reminded_at: number }
export interface LinkRow { token: string; kind: string; bot_id: number; request_id: string | null; data: string; claim: string | null; used: number; expires_at: number }

// ------------------------------------------------------------------ encryption
// AES-256-GCM, layout: 12-byte nonce | 16-byte tag | ciphertext
export function encrypt(plain: string): Buffer {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', config.masterKey, iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}
export function decrypt(blob: Buffer): string {
  const d = crypto.createDecipheriv('aes-256-gcm', config.masterKey, blob.subarray(0, 12));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString('utf8');
}

export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const now = () => Date.now();

// --------------------------------------------------------------------- helpers
export const bots = {
  // `deleted` is added by fleet.ts; rows of deleted bots stay because tasks refer to them
  all: () => (db.prepare('SELECT * FROM bots ORDER BY id').all() as (BotRow & { deleted?: number })[]).filter((b) => !b.deleted) as BotRow[],
  get: (id: number) => db.prepare('SELECT * FROM bots WHERE id = ?').get(id) as BotRow | undefined,
  ensureMain(): BotRow {
    db.prepare(`INSERT OR IGNORE INTO bots (slug, name, created_at) VALUES ('main', 'Main', ?)`).run(now());
    return db.prepare(`SELECT * FROM bots WHERE slug = 'main'`).get() as BotRow;
  },
  setSession: (id: number, sid: string | null) => db.prepare('UPDATE bots SET session_id = ? WHERE id = ?').run(sid, id),
  setVoice: (id: number, on: boolean) => db.prepare('UPDATE bots SET voice = ? WHERE id = ?').run(on ? 1 : 0, id),
  setVoiceLang: (id: number, lang: string | null) => db.prepare('UPDATE bots SET voice_lang = ? WHERE id = ?').run(lang, id),
  token: (b: BotRow) => (b.token_enc ? decrypt(b.token_enc) : config.mainBotToken),
  home: (b: BotRow) => `/home/bot/bots/${b.slug}`,
  // X display number; VNC is on 5900 + this
  display: (b: BotRow) => 10 + b.id,
};

export const tasks = {
  get: (id: number) => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined,
  create(botId: number, title: string, instructions: string, model: string, needsScreen: boolean, unattended = false): TaskRow {
    const r = db.prepare(`INSERT INTO tasks (bot_id, title, instructions, model, needs_screen, unattended, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`).run(botId, title, instructions, model, needsScreen ? 1 : 0, unattended ? 1 : 0, now());
    return tasks.get(Number(r.lastInsertRowid))!;
  },
  update(id: number, fields: Partial<TaskRow>) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    db.prepare(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map((k) => (fields as Record<string, unknown>)[k]), id);
  },
  byStatus: (status: string) => db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY id').all(status) as TaskRow[],
  recent: (botId: number, limit = 15) =>
    db.prepare('SELECT * FROM tasks WHERE bot_id = ? ORDER BY id DESC LIMIT ?').all(botId, limit) as TaskRow[],

  // ------------------------------------------------------------ recall (FTS)
  /** (Re)index one finished task. */
  index(t: TaskRow) {
    if (!fts) return;
    db.prepare('DELETE FROM task_fts WHERE task_id = ?').run(t.id);
    db.prepare('INSERT INTO task_fts (task_id, bot_id, title, body) VALUES (?, ?, ?, ?)')
      .run(t.id, t.bot_id, t.title, `${t.instructions}\n\n${t.result ?? ''}`);
  },
  /** Index finished tasks that are not in the index yet (first start after the upgrade). */
  indexMissing() {
    if (!fts) return;
    const rows = db.prepare(`SELECT * FROM tasks WHERE status IN ('done', 'failed') AND id NOT IN (SELECT task_id FROM task_fts)`).all() as TaskRow[];
    for (const t of rows) tasks.index(t);
    if (rows.length) console.log(`[db] indexed ${rows.length} earlier task(s) for recall`);
  },
  /**
   * Full-text search over a bot's finished tasks. Words are matched as prefixes,
   * all of them must occur. Falls back to a plain substring match when the
   * query cannot be turned into an FTS expression or FTS is unavailable.
   */
  search(botId: number, query: string, limit = 8): { task: TaskRow; snippet: string }[] {
    const words = query.replace(/["'*^:()]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 12);
    if (!words.length) return [];
    if (fts) {
      try {
        const match = words.map((w) => `"${w}"*`).join(' ');
        const rows = db.prepare(`SELECT task_id, snippet(task_fts, 3, '[', ']', '…', 24) AS snippet FROM task_fts
          WHERE task_fts MATCH ? AND bot_id = ? ORDER BY rank LIMIT ?`).all(match, botId, limit) as { task_id: number; snippet: string }[];
        return rows.map((r) => ({ task: tasks.get(r.task_id)!, snippet: r.snippet })).filter((r) => r.task);
      } catch { /* odd query: fall through to LIKE */ }
    }
    const like = `%${words[0]}%`;
    const rows = db.prepare(`SELECT * FROM tasks WHERE bot_id = ? AND status IN ('done', 'failed') AND (title LIKE ? OR instructions LIKE ? OR result LIKE ?) ORDER BY id DESC LIMIT ?`)
      .all(botId, like, like, like, limit) as TaskRow[];
    return rows.map((t) => ({ task: t, snippet: (t.result ?? t.instructions).slice(0, 160) }));
  },
};

export const schedules = {
  get: (id: number) => db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as ScheduleRow | undefined,
  forBot: (botId: number) => db.prepare('SELECT * FROM schedules WHERE bot_id = ? ORDER BY id').all(botId) as ScheduleRow[],
  due: () => db.prepare('SELECT * FROM schedules WHERE enabled = 1 AND next_run IS NOT NULL AND next_run <= ? ORDER BY next_run').all(now()) as ScheduleRow[],
  create(botId: number, f: { title: string; instructions: string; cron: string | null; model: string; needsScreen: boolean; nextRun: number }): ScheduleRow {
    const r = db.prepare(`INSERT INTO schedules (bot_id, title, instructions, cron, model, needs_screen, next_run, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(botId, f.title, f.instructions, f.cron, f.model, f.needsScreen ? 1 : 0, f.nextRun, now());
    return schedules.get(Number(r.lastInsertRowid))!;
  },
  update(id: number, fields: Partial<ScheduleRow>) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    db.prepare(`UPDATE schedules SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map((k) => (fields as Record<string, unknown>)[k]), id);
  },
  delete: (id: number) => db.prepare('DELETE FROM schedules WHERE id = ?').run(id).changes > 0,
};

export const requests = {
  get: (id: string) => db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as RequestRow | undefined,
  create(botId: number, taskId: number | null, kind: string, payload: unknown): RequestRow {
    const id = crypto.randomBytes(9).toString('base64url');
    db.prepare(`INSERT INTO requests (id, bot_id, task_id, kind, payload, status, created_at, reminded_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`).run(id, botId, taskId, kind, JSON.stringify(payload), now(), now());
    return requests.get(id)!;
  },
  pending: () => db.prepare(`SELECT * FROM requests WHERE status = 'pending' ORDER BY created_at`).all() as RequestRow[],
  forTask: (taskId: number) => db.prepare('SELECT * FROM requests WHERE task_id = ?').all(taskId) as RequestRow[],
  pendingForTask: (taskId: number) =>
    db.prepare(`SELECT * FROM requests WHERE status = 'pending' AND task_id = ?`).all(taskId) as RequestRow[],
  pendingQuestions: (botId: number) =>
    db.prepare(`SELECT * FROM requests WHERE status = 'pending' AND kind = 'question' AND bot_id = ?`).all(botId) as RequestRow[],
  byMessage: (botId: number, msgId: number) =>
    db.prepare(`SELECT * FROM requests WHERE status = 'pending' AND bot_id = ? AND tg_msg_id = ?`).get(botId, msgId) as RequestRow | undefined,
  setMessage: (id: string, msgId: number) => db.prepare('UPDATE requests SET tg_msg_id = ? WHERE id = ?').run(msgId, id),
  setReminded: (id: string) => db.prepare('UPDATE requests SET reminded_at = ? WHERE id = ?').run(now(), id),
  finish: (id: string, status: 'done' | 'cancelled', result: string) =>
    db.prepare(`UPDATE requests SET status = ?, result = ? WHERE id = ? AND status = 'pending'`).run(status, result, id).changes > 0,
};

export const links = {
  create(kind: string, botId: number, requestId: string | null, data: unknown = {}): string {
    const token = newToken();
    db.prepare('INSERT INTO links (token, kind, bot_id, request_id, data, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(token, kind, botId, requestId, JSON.stringify(data), now() + config.linkTtlMs);
    return token;
  },
  // Only live links are ever returned: unexpired and not used up.
  get(token: string, kind: string): LinkRow | undefined {
    return db.prepare('SELECT * FROM links WHERE token = ? AND kind = ? AND used = 0 AND expires_at > ?')
      .get(token, kind, now()) as LinkRow | undefined;
  },
  claim: (token: string, cookie: string) =>
    db.prepare('UPDATE links SET claim = ? WHERE token = ? AND claim IS NULL').run(cookie, token).changes > 0,
  use: (token: string) => db.prepare('UPDATE links SET used = 1 WHERE token = ?').run(token),
  forRequest: (requestId: string) =>
    (db.prepare('SELECT token FROM links WHERE request_id = ? AND used = 0 AND expires_at > ?').get(requestId, now()) as { token: string } | undefined)?.token,
  useForRequest: (requestId: string) => db.prepare('UPDATE links SET used = 1 WHERE request_id = ?').run(requestId),
  purge: () => db.prepare('DELETE FROM links WHERE expires_at < ?').run(now() - 7 * 86400_000),
};

export const secrets = {
  names: () => db.prepare('SELECT name, description, updated_at FROM secrets ORDER BY name').all() as { name: string; description: string; updated_at: number }[],
  set: (name: string, value: string, description: string) =>
    db.prepare(`INSERT INTO secrets (name, value_enc, description, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET value_enc = excluded.value_enc, description = excluded.description, updated_at = excluded.updated_at`)
      .run(name, encrypt(value), description, now()),
  get(name: string): string | undefined {
    const row = db.prepare('SELECT value_enc FROM secrets WHERE name = ?').get(name) as { value_enc: Buffer } | undefined;
    return row && decrypt(row.value_enc);
  },
  delete: (name: string) => db.prepare('DELETE FROM secrets WHERE name = ?').run(name).changes > 0,
};

export const events = {
  add: (botId: number, text: string) => db.prepare('INSERT INTO events (bot_id, text) VALUES (?, ?)').run(botId, text),
  // read and clear in one go
  drain(botId: number): string[] {
    const rows = db.prepare('SELECT id, text FROM events WHERE bot_id = ? ORDER BY id').all(botId) as { id: number; text: string }[];
    if (rows.length) db.prepare(`DELETE FROM events WHERE id <= ? AND bot_id = ?`).run(rows[rows.length - 1].id, botId);
    return rows.map((r) => r.text);
  },
};
