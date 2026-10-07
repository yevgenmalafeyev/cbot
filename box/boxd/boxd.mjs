// boxd: the only door from core into the box. Zero dependencies.
//
// Core calls it to start Claude sessions (as the `bot` user), move files in and
// out, and keep the bots' screens alive. It runs as root so it can drop to
// `bot` for the work and survive whatever the bots do to their own processes.
//
// Auth is a shared bearer token. The bots have sudo here and could read it, but
// it grants nothing they do not already have: everything boxd can do, they can.
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const PORT = Number(process.env.BOXD_PORT || 7070);
const TOKEN = process.env.BOXD_TOKEN || '';
const IDLE_MS = Number(process.env.DISPLAY_IDLE_MIN || 15) * 60_000;
const BOT_UID = 1000, BOT_GID = 1000, BOT_HOME = '/home/bot';
const RUN_DIR = '/run/cbot';

if (!TOKEN) { console.error('BOXD_TOKEN is required'); process.exit(1); }

/** run id -> child process */
const runs = new Map();

const botEnv = (extra = {}) => ({
  HOME: BOT_HOME, USER: 'bot', LOGNAME: 'bot', SHELL: '/bin/bash',
  PATH: `${BOT_HOME}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
  LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: process.env.TZ || 'UTC',
  DISABLE_AUTOUPDATER: '1',
  ...extra,
});

function readJson(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 8e6) reject(new Error('body too large')); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function killRun(id) {
  const child = runs.get(id);
  if (!child) return false;
  // Negative pid: the whole process group (claude, its MCP server, its shells).
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000).unref();
  return true;
}

function display(args) {
  return new Promise((resolve, reject) => {
    execFile('/usr/local/bin/cbot-display', args.map(String),
      { uid: BOT_UID, gid: BOT_GID, env: botEnv(), cwd: BOT_HOME, timeout: 60_000 },
      (err, stdout, stderr) => err ? reject(new Error(stderr || err.message)) : resolve(stdout.trim()));
  });
}

// Files may only be exchanged below the bot's home.
function safePath(p) {
  const resolved = path.resolve(String(p || ''));
  if (resolved !== BOT_HOME && !resolved.startsWith(BOT_HOME + '/')) throw new Error('path outside /home/bot');
  return resolved;
}

const routes = {
  'GET /health': async (_req, res) => send(res, 200, { ok: true, runs: runs.size }),

  // Start a process as `bot` and stream its stdout back line by line. The last
  // line is always {"type":"cbot_exit",...}. If core drops the connection the
  // process is killed, so nothing keeps running unobserved.
  'POST /run': async (req, res) => {
    const { id, cmd = 'claude', args = [], cwd = BOT_HOME, env = {}, stdin = '' } = await readJson(req);
    if (!id || runs.has(id)) return send(res, 409, { error: 'bad or duplicate run id' });
    fs.mkdirSync(cwd, { recursive: true });
    fs.chownSync(cwd, BOT_UID, BOT_GID);
    const child = spawn(cmd, args, {
      cwd, env: botEnv(env), uid: BOT_UID, gid: BOT_GID, detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    runs.set(id, child);
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.flushHeaders();   // a quiet command must not look like a dead connection to the caller
    let stderrTail = '';
    child.stderr.on('data', (c) => { stderrTail = (stderrTail + c).slice(-4000); });
    child.stdout.pipe(res, { end: false });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
    let done = false;
    const finish = (code, signal, error) => {
      if (done) return; done = true;
      runs.delete(id);
      res.end('\n' + JSON.stringify({ type: 'cbot_exit', code, signal, error, stderr: stderrTail }) + '\n');
    };
    child.on('error', (e) => finish(null, null, e.message));
    child.on('close', (code, signal) => finish(code, signal));
    res.on('close', () => { if (!done) killRun(id); });
  },

  'POST /kill': async (req, res) => {
    const { id } = await readJson(req);
    send(res, 200, { killed: killRun(id) });
  },

  'POST /kill-all': async (_req, res) => {
    const ids = [...runs.keys()];
    ids.forEach(killRun);
    send(res, 200, { killed: ids.length });
  },

  'POST /display/ensure': async (req, res) => {
    const { n, home } = await readJson(req);
    await display(['ensure', n, safePath(home)]);
    send(res, 200, { ok: true, port: 5900 + Number(n) });
  },

  'POST /display/touch': async (req, res) => {
    const { n } = await readJson(req);
    await display(['touch', n]);
    send(res, 200, { ok: true });
  },

  'PUT /file': async (req, res, url) => {
    const p = safePath(url.searchParams.get('path'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    await pipeline(req, fs.createWriteStream(p));
    // chown the file and any directories we just created
    for (let d = p; d.startsWith(BOT_HOME + '/'); d = path.dirname(d)) {
      if (fs.statSync(d).uid === BOT_UID) break;
      fs.chownSync(d, BOT_UID, BOT_GID);
    }
    send(res, 200, { ok: true, path: p });
  },

  'GET /file': async (_req, res, url) => {
    const p = safePath(url.searchParams.get('path'));
    const st = fs.statSync(p);
    if (!st.isFile()) return send(res, 400, { error: 'not a file' });
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': st.size });
    await pipeline(fs.createReadStream(p), res);
  },

  'GET /stat': async (_req, res, url) => {
    const p = safePath(url.searchParams.get('path'));
    const st = fs.statSync(p);
    send(res, 200, { size: st.size, isFile: st.isFile() });
  },
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://boxd');
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'unauthorized' });
  const handler = routes[`${req.method} ${url.pathname}`];
  if (!handler) return send(res, 404, { error: 'not found' });
  try { await handler(req, res, url); }
  catch (e) {
    console.error(`[boxd] ${req.method} ${url.pathname}: ${e.message}`);
    if (!res.headersSent) send(res, 500, { error: e.message }); else res.end();
  }
}).listen(PORT, '0.0.0.0', () => console.log(`[boxd] listening on :${PORT}`));

// Stop screens nobody has used for a while: an idle Chrome still holds ~1 GB.
setInterval(() => {
  let files;
  try { files = fs.readdirSync(RUN_DIR); } catch { return; }
  for (const f of files) {
    const m = f.match(/^display-(\d+)\.pid$/);
    if (!m) continue;
    let last = 0;
    try { last = fs.statSync(path.join(RUN_DIR, `display-${m[1]}.touch`)).mtimeMs; } catch {}
    if (Date.now() - last > IDLE_MS) {
      console.log(`[boxd] display :${m[1]} idle, stopping`);
      display(['stop', m[1]]).catch((e) => console.error(`[boxd] stop failed: ${e.message}`));
    }
  }
}, 60_000).unref();

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { [...runs.keys()].forEach(killRun); setTimeout(() => process.exit(0), 500); });
}
