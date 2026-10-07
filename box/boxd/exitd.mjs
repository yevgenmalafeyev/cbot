// exitd: the browsers' way out, with failover. Zero dependencies.
//
// Chrome is pointed at this local proxy once and never reconfigured. For each
// new connection exitd decides where it leaves from:
//   - through the office proxy (OFFICE_PROXY=host:port), so sites see the
//     office's ordinary business address instead of a datacenter one;
//   - directly, from the server's own address, whenever the office proxy does
//     not answer.
// Every change of route is reported to core, which tells the owner in Telegram.
//
// Connections already open when the office goes away are lost; pages reload
// over the direct route.
import http from 'node:http';
import net from 'node:net';

const PORT = Number(process.env.EXITD_PORT || 3128);
const [UP_HOST, UP_PORT] = (process.env.OFFICE_PROXY || '').split(':');
const CORE_URL = process.env.CORE_URL || 'http://core:8791';
const TOKEN = process.env.BOXD_TOKEN || '';
const CHECK_MS = Number(process.env.EXIT_CHECK_SECONDS || 30) * 1000;
const PROBE = process.env.EXIT_PROBE || 'www.gstatic.com:443';

if (!UP_HOST || !UP_PORT) { console.error('[exitd] OFFICE_PROXY=host:port is required'); process.exit(1); }

let officeUp = false;
let known = false;      // false until the first probe has finished
let failures = 0;

/** Open a tunnel to host:port through the office proxy. */
function viaOffice(target, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const s = net.connect(Number(UP_PORT), UP_HOST);
    const fail = (e) => { s.destroy(); reject(e instanceof Error ? e : new Error(String(e))); };
    s.setTimeout(timeoutMs, () => fail('timeout'));
    s.once('error', fail);
    s.once('connect', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let head = Buffer.alloc(0);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return head.length > 8192 ? fail('oversized proxy reply') : undefined;
      s.off('data', onData);
      s.setTimeout(0);
      if (!/^HTTP\/1\.[01] 2\d\d/.test(head.toString('latin1', 0, 16))) return fail(`proxy said: ${head.toString('latin1', 0, 60).split('\r\n')[0]}`);
      const rest = head.subarray(end + 4);
      if (rest.length) s.unshift(rest);
      resolve(s);
    };
    s.on('data', onData);
  });
}

function direct(target, timeoutMs = 15_000) {
  const i = target.lastIndexOf(':');
  return tcp(target.slice(0, i).replace(/^\[|\]$/g, ''), target.slice(i + 1), timeoutMs);
}

let sinceReport = 0;
async function report() {
  sinceReport = 0;
  try {
    await fetch(`${CORE_URL}/internal/exit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ office: officeUp }),
    });
  } catch (e) { console.error('[exitd] could not report to core:', e.message); }
}

async function probe() {
  let ok = false;
  try { (await viaOffice(PROBE, 8000)).destroy(); ok = true; } catch {}
  failures = ok ? 0 : failures + 1;
  // One failed probe is noise; two in a row is an outage. Recovery is immediate.
  const next = ok ? true : failures >= 2 || !known ? false : officeUp;
  if (!known || next !== officeUp) {
    officeUp = next; known = true;
    console.log(`[exitd] route: ${officeUp ? `office proxy ${UP_HOST}:${UP_PORT}` : 'direct (office proxy unreachable)'}`);
    report();
  } else if (++sinceReport >= 10) {
    // Repeat the current state now and then: core forgets it when it restarts
    // and ignores a report that changes nothing.
    report();
  }
}

/** A tunnel to the target by the current route; falls back to direct if the office drops this very attempt. */
async function open(target) {
  if (officeUp) {
    try { return await viaOffice(target); }
    catch { probe(); }
  }
  return direct(target);
}

/** Plain TCP connection, used for the proxy itself and for direct targets. */
function tcp(host, port, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const s = net.connect(Number(port), host);
    s.setTimeout(timeoutMs, () => { s.destroy(); reject(new Error('timeout')); });
    s.once('error', reject);
    s.once('connect', () => { s.setTimeout(0); resolve(s); });
  });
}

// Plain http:// requests arrive with an absolute URL. Through the office they
// are passed on as ordinary proxy requests (forward proxies commonly refuse
// CONNECT to anything but 443); directly, they become normal origin requests.
const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url); } catch { res.writeHead(400).end(); return; }
  if (url.protocol !== 'http:') { res.writeHead(400).end(); return; }
  const headers = Object.entries(req.headers).filter(([k]) => !/^(proxy-|connection$)/i.test(k)).map(([k, v]) => `${k}: ${v}`).join('\r\n');
  const client = res.socket;
  try {
    let up, line;
    if (officeUp) {
      try { up = await tcp(UP_HOST, UP_PORT, 10_000); line = `${req.method} ${url.href} HTTP/1.1`; } catch { probe(); }
    }
    if (!up) { up = await tcp(url.hostname, url.port || 80); line = `${req.method} ${url.pathname}${url.search} HTTP/1.1`; }
    up.write(`${line}\r\n${headers}\r\nconnection: close\r\n\r\n`);
    req.pipe(up, { end: false });
    up.pipe(client);
    up.on('error', () => client.destroy());
    client.on('error', () => up.destroy());
    client.on('close', () => up.destroy());
  } catch { if (!res.headersSent) res.writeHead(502).end(); }
});

server.on('connect', async (req, client, head) => {
  client.on('error', () => {});
  try {
    const up = await open(req.url);
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) up.write(head);
    up.pipe(client); client.pipe(up);
    up.on('error', () => client.destroy());
    client.on('close', () => up.destroy());
    up.on('close', () => client.destroy());
  } catch { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); }
});

await probe();
setInterval(probe, CHECK_MS);
server.listen(PORT, '127.0.0.1', () => console.log(`[exitd] listening on 127.0.0.1:${PORT}`));
