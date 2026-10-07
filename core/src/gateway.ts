// The public face (behind a TLS reverse proxy): the links the bots hand out.
//
//   /a/<slug>    a bot's Mini App: what it waits for, its tasks, its screen
//   /h/<token>   watch and control a bot's screen (noVNC)
//   /s/<token>   enter a secret
//   /d/<token>   download a large file
//   /health      for monitoring
//
// A screen link is bound to the first browser that opens it. That binding is
// made by a POST, never by the GET, so link previews and scanners that fetch
// the URL cannot use the link up. Opened inside Telegram (the buttons the bots
// send, and the Mini App) no binding is needed: Telegram vouches for the owner.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from './config.js';
import { box } from './box.js';
import { bots, links, requests, secrets, tasks, now, LinkRow } from './db.js';
import { resolveRequest, screenDone, secretSubmitted, HELP_DONE, HELP_DECLINED } from './agent.js';
import { gmailAuthUrl, gmailCallback, gmailConfigured, imapPasswordSubmitted } from './mail.js';
import { botTokenSubmitted, siblings } from './fleet.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const NOVNC_DIR = process.env.NOVNC_DIR || '/opt/novnc';
const page = (name: string) => fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
  'x-content-type-options': 'nosniff',
  // Telegram's web client shows Mini Apps in a frame; nothing else may frame these pages
  'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' wss:; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors https://web.telegram.org",
};

function html(res: http.ServerResponse, code: number, body: string, extra: Record<string, string> = {}) {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', ...HEADERS, ...extra });
  res.end(body);
}
/** `finished`: the owner has nothing more to do on the page, so inside Telegram it closes itself. */
const message = (res: http.ServerResponse, code: number, title: string, text: string, finished = false) =>
  html(res, code, page('message.html').replaceAll('{{title}}', esc(title)).replaceAll('{{text}}', esc(text)).replace('{{close}}', finished ? page('close.html') : ''));
const gone = (res: http.ServerResponse) =>
  message(res, 404, 'Link not valid', 'This link has expired, was already used, or never existed. Ask the bot for a new one.');

function form(req: http.IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 1e5) req.destroy(); });
    req.on('end', () => resolve(new URLSearchParams(buf)));
    req.on('error', reject);
  });
}

const cookieName = (token: string) => `cbot_${crypto.createHash('sha256').update(token).digest('hex').slice(0, 12)}`;
function cookie(req: http.IncomingMessage, name: string): string | undefined {
  return req.headers.cookie?.split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === name)?.[1];
}
/** True when this browser is the one the screen link was bound to. */
const owns = (req: http.IncomingMessage, link: LinkRow) => {
  const c = cookie(req, cookieName(link.token));
  return !!c && !!link.claim && c.length === link.claim.length && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(link.claim));
};

/**
 * Telegram signs a Mini App's launch data with the token of the bot it was
 * opened from. True when that data is genuine, recent, and from the owner.
 */
function tgOwner(initData: string | null, botId: number): boolean {
  // not bots.get: a deleted bot has no token of its own any more
  const bot = initData ? bots.all().find((b) => b.id === botId) : undefined;
  if (!bot) return false;
  const p = new URLSearchParams(initData!);
  const hash = p.get('hash') ?? '';
  p.delete('hash');
  const check = [...p].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(bots.token(bot)).digest();
  const want = crypto.createHmac('sha256', key).update(check).digest('hex');
  if (hash.length !== want.length || !crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(want))) return false;
  try { return JSON.parse(p.get('user') ?? '{}').id === config.ownerId && Number(p.get('auth_date')) * 1000 > now() - config.linkTtlMs; }
  catch { return false; }
}
/** The Mini App pages pass their launch data as ?tg= on every call. */
const allowed = (req: http.IncomingMessage, url: URL, link: LinkRow) => owns(req, link) || tgOwner(url.searchParams.get('tg'), link.bot_id);

const MIME: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  const [, section, token, action] = url.pathname.split('/');

  if (url.pathname === '/health') {
    const boxOk = await box.health().then(() => true, () => false);
    res.writeHead(boxOk ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: boxOk ? 'ok' : 'degraded', box: boxOk }));
    return;
  }

  // What Google's OAuth consent screen links to as the app's home and privacy pages.
  if ((url.pathname === '/' || url.pathname === '/privacy') && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY' });
    res.end(page('privacy.html'));
    return;
  }

  // static files: the noVNC client and our own stylesheet
  if ((section === 'novnc' || section === 'assets') && req.method === 'GET') {
    const root = section === 'novnc' ? NOVNC_DIR : PUBLIC_DIR;
    const file = path.normalize(path.join(root, url.pathname.slice(section.length + 2)));
    const ext = path.extname(file);
    if (!file.startsWith(root + path.sep) || !MIME[ext] || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': MIME[ext], 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' });
    fs.createReadStream(file).pipe(res);
    return;
  }

  // ---------------------------------------------------------------- Mini App
  // The page itself is the same for every slug and says nothing; what it shows
  // comes from the calls below, which only the owner's Telegram can make.
  if (section === 'a' && token) {
    if (req.method === 'GET' && !action) return html(res, 200, page('app.html'));
    const bot = bots.all().find((b) => b.slug === token);
    if (!bot || !tgOwner(url.searchParams.get('tg'), bot.id)) { res.writeHead(403, HEADERS).end(); return; }
    const json = (body: unknown) => { res.writeHead(200, { 'content-type': 'application/json', ...HEADERS }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && action === 'state') {
      const waiting = requests.pending().filter((r) => r.bot_id === bot.id).map((r) => {
        const p = JSON.parse(r.payload);
        const t = links.forRequest(r.id);
        return {
          kind: r.kind,
          text: String(p.reason ?? p.question ?? p.action ?? `${p.name}: ${p.description}`),
          url: !t ? undefined : r.kind === 'help' ? `/h/${t}?app` : r.kind === 'secret' ? `/s/${t}` : undefined,
        };
      });
      // the main bot is also the way to the others
      return json({ name: bot.name, bots: bot.token_enc ? [] : siblings(bot.id), waiting, tasks: tasks.recent(bot.id, 8).map((t) => ({ id: t.id, title: t.title, status: t.status })) });
    }
    if (req.method === 'POST' && action === 'screen') return json({ url: `/h/${links.create('help', bot.id, null)}?app` });
    res.writeHead(404, HEADERS).end();
    return;
  }

  // ------------------------------------------------------------- screen link
  if (section === 'h' && token) {
    const link = links.get(token, 'help');
    if (!link) return gone(res);
    // The help request this view can answer: the one the link was made for, or
    // (for a link from /screen) whatever this bot is currently waiting on.
    const bound = link.request_id ? requests.get(link.request_id) : undefined;
    const request = bound?.status === 'pending' ? bound
      : requests.pending().find((r) => r.kind === 'help' && r.bot_id === link.bot_id);
    // A screen the chat session shared itself has nothing to resolve, but the owner can still say they are done.
    const shared = JSON.parse(link.data) as { asked?: boolean; reason?: string };
    const asked = !request && !!shared.asked;
    const reason = request ? (JSON.parse(request.payload).reason as string) : asked && shared.reason || 'Live view of the bot\'s screen';
    const elsewhere = () => message(res, 403, 'Already opened elsewhere', 'This link was already opened in another browser. Ask the bot for a new one.');

    if (req.method === 'POST' && action === 'claim') {
      const value = crypto.randomBytes(24).toString('base64url');
      if (!links.claim(token, value) && !owns(req, link)) return elsewhere();
      const headers: Record<string, string> = { location: `/h/${token}` };
      if (!owns(req, link)) headers['set-cookie'] = `${cookieName(token)}=${value}; Path=/h/${token}; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`;
      res.writeHead(303, headers).end();
      return;
    }
    if (req.method === 'POST' && (action === 'done' || action === 'cancel')) {
      if (!allowed(req, url, link)) return gone(res);
      if (request) resolveRequest(request.id, action === 'done' ? HELP_DONE : HELP_DECLINED);
      else if (asked && action === 'done') screenDone(link.bot_id);
      // A link made for this request dies with it; a /screen link stays usable.
      if (links.get(token, 'help')) { res.writeHead(303, { location: `/h/${token}` }).end(); return; }
      return message(res, 200, action === 'done' ? 'Thanks' : 'Cancelled',
        action === 'done' ? 'The bot is continuing. You can close this page.' : 'The bot was told you will not do this. You can close this page.', true);
    }
    if (req.method === 'GET' && action === 'state') {
      if (!allowed(req, url, link)) return gone(res);
      res.writeHead(200, { 'content-type': 'application/json', ...HEADERS });
      res.end(JSON.stringify({ pending: !!request, asked, reason }));
      return;
    }
    if (req.method === 'GET' && !action) {
      // inside Telegram: the page proves who it is with every call it makes
      if (url.searchParams.has('app')) return html(res, 200, page('screen.html').replaceAll('{{token}}', token));
      if (!link.claim) return html(res, 200, page('open.html').replaceAll('{{reason}}', esc(reason)).replaceAll('{{token}}', token));
      if (!owns(req, link)) return elsewhere();
      return html(res, 200, page('screen.html').replaceAll('{{token}}', token));
    }
    return gone(res);
  }

  // ------------------------------------------------------------- secret link
  if (section === 's' && token && !action) {
    const link = links.get(token, 'secret');
    if (!link) return gone(res);
    const data = JSON.parse(link.data) as { name: string; description: string };
    if (req.method === 'GET') {
      return html(res, 200, page('secret.html').replace('{{name}}', esc(data.name)).replace('{{description}}', esc(data.description)));
    }
    if (req.method === 'POST') {
      const value = (await form(req)).get('value') ?? '';
      if (!value) return message(res, 400, 'Nothing entered', 'Go back and enter a value.');
      if ('newBot' in data) {
        // a create_bot link: the value is the BotFather token of the new bot
        try {
          const username = await botTokenSubmitted(link, value);
          return message(res, 200, 'Bot created', `Now open @${username} in Telegram and press Start. You can close this page.`, true);
        } catch (e: any) { return message(res, 400, 'Not created', `${e.message} Go back and try again.`); }
      }
      if ('imap' in data) {
        // a connect_imap link: the value is the mailbox password, verified before it is kept
        try { return message(res, 200, 'Connected', `${await imapPasswordSubmitted(link, value)} is connected. You can close this page.`, true); }
        catch (e: any) { return message(res, 400, 'Login failed', `${e.message} Go back and try again.`); }
      }
      secrets.set(data.name, value, data.description);
      links.use(token);
      secretSubmitted(link.request_id, link.bot_id, data.name);
      return message(res, 200, 'Saved', `${data.name} is stored encrypted. You can close this page.`, true);
    }
  }

  // -------------------------------------------------------------- Gmail OAuth
  // /g/<token> is what the bot hands out; it carries the token to Google as
  // `state` and Google brings it back to /oauth/google.
  if (section === 'g' && token && req.method === 'GET') {
    if (!links.get(token, 'gmail') || !gmailConfigured()) return gone(res);
    res.writeHead(302, { location: gmailAuthUrl(token), ...HEADERS }).end();
    return;
  }
  if (url.pathname === '/oauth/google' && req.method === 'GET') {
    const link = links.get(url.searchParams.get('state') ?? '', 'gmail');
    if (!link) return gone(res);
    const code = url.searchParams.get('code');
    if (!code) return message(res, 400, 'Not connected', `Google did not grant access (${url.searchParams.get('error') ?? 'no code'}). Ask the bot for a new link to try again.`);
    try { return message(res, 200, 'Connected', `${await gmailCallback(link, code)} is now connected to the bot. You can close this page.`); }
    catch (e: any) { return message(res, 400, 'Not connected', e.message); }
  }

  // ----------------------------------------------------------- download link
  if (section === 'd' && token && req.method === 'GET') {
    const link = links.get(token, 'download');
    if (!link) return gone(res);
    const p = JSON.parse(link.data).path as string;
    const st = await box.stat(p).catch(() => null);
    if (!st?.isFile) return message(res, 404, 'File is gone', 'The file no longer exists on the bot\'s machine.');
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(st.size),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(p))}`,
      ...HEADERS,
    });
    (await box.getFile(p)).pipe(res);
    return;
  }

  res.writeHead(404, HEADERS).end();
}

export function startGateway(): void {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error('[gateway]', e);
      if (!res.headersSent) res.writeHead(500).end(); else res.end();
    });
  });

  // /h/<token>/ws: browser <-> the bot's VNC server, bytes passed through.
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  server.on('upgrade', async (req, socket, head) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const m = url.pathname.match(/^\/h\/([\w-]+)\/ws$/);
      const link = m && links.get(m[1], 'help');
      if (!link || !allowed(req, url, link)) { socket.destroy(); return; }
      const bot = bots.get(link.bot_id)!;
      const display = bots.display(bot);
      await box.ensureDisplay(display, bots.home(bot));
      wss.handleUpgrade(req, socket, head, (ws) => bridge(ws, display));
    } catch (e) {
      console.error('[gateway] ws', e);
      socket.destroy();
    }
  });

  server.listen(config.publicPort, '0.0.0.0', () => console.log(`[gateway] listening on :${config.publicPort}`));
}

function bridge(ws: WebSocket, display: number): void {
  const vnc = net.connect(5900 + display, config.boxHost);
  // someone is watching: do not let the idle reaper stop the screen
  const keepalive = setInterval(() => box.touchDisplay(display), 60_000);
  const close = () => { clearInterval(keepalive); vnc.destroy(); ws.close(); };
  vnc.on('data', (d) => { if (ws.readyState === WebSocket.OPEN) ws.send(d); });
  vnc.on('error', close);
  vnc.on('close', close);
  ws.on('message', (d) => vnc.write(d as Buffer));
  ws.on('error', close);
  ws.on('close', close);
}
