// Listener for the box only (never published): the bots' tool server calls in
// here. Every call carries the token of the Claude run it belongs to, which
// fixes the bot, the role and the task; nothing in the request body can widen it.
import http from 'node:http';
import { config } from './config.js';
import { runTokens } from './claude.js';
import { exitChanged, toolCall, waitRequest } from './agent.js';

function body(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 4e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

export function startInternal(): void {
  http.createServer(async (req, res) => {
    const reply = (code: number, obj: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    try {
      // the box's exit switch reporting a change of route (authenticated as the box, not as a run)
      if (req.method === 'POST' && req.url === '/internal/exit') {
        if (req.headers.authorization !== `Bearer ${config.boxdToken}`) return reply(401, { error: 'unauthorized' });
        exitChanged(!!(await body(req)).office);
        return reply(200, {});
      }
      const ctx = runTokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (!ctx) return reply(401, { error: 'unknown run token' });
      const b = await body(req);
      if (req.method === 'POST' && req.url === '/internal/call') return reply(200, await toolCall(ctx, String(b.tool), b.args ?? {}));
      if (req.method === 'POST' && req.url === '/internal/wait') return reply(200, (await waitRequest(String(b.id))) ?? { wait: b.id });
      reply(404, { error: 'not found' });
    } catch (e: any) {
      console.error('[internal]', e);
      reply(200, { error: e.message });
    }
  }).listen(config.internalPort, '0.0.0.0', () => console.log(`[internal] listening on :${config.internalPort}`));
}
