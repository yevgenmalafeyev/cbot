// Client for boxd, the daemon inside the box container.
import { Readable } from 'node:stream';
import { config } from './config.js';

const auth = { authorization: `Bearer ${config.boxdToken}` };

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(config.boxdUrl + path, {
    method,
    headers: { ...auth, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `boxd ${path}: ${res.status}`);
  return json;
}

export interface RunExit { code: number | null; signal: string | null; error?: string; stderr: string }

export const box = {
  health: () => call('GET', '/health'),
  kill: (id: string) => call('POST', '/kill', { id }),
  killAll: () => call('POST', '/kill-all', {}),
  ensureDisplay: (n: number, home: string) => call('POST', '/display/ensure', { n, home }),
  touchDisplay: (n: number) => call('POST', '/display/touch', { n }).catch(() => {}),
  stat: (path: string): Promise<{ size: number; isFile: boolean }> => call('GET', `/stat?path=${encodeURIComponent(path)}`),

  async putFile(path: string, data: Buffer): Promise<void> {
    const res = await fetch(`${config.boxdUrl}/file?path=${encodeURIComponent(path)}`, { method: 'PUT', headers: auth, body: new Uint8Array(data) });
    if (!res.ok) throw new Error(`boxd put ${path}: ${res.status}`);
  },

  async getFile(path: string): Promise<Readable> {
    const res = await fetch(`${config.boxdUrl}/file?path=${encodeURIComponent(path)}`, { headers: auth });
    if (!res.ok || !res.body) throw new Error(`boxd get ${path}: ${res.status}`);
    return Readable.fromWeb(res.body as any);
  },

  // Run a command in the box and hand each stdout line (Claude's stream-json)
  // to onLine. Resolves when the process is gone.
  async run(
    spec: { id: string; cmd?: string; args: string[]; cwd: string; env: Record<string, string>; stdin: string },
    onLine: (obj: any) => void,
  ): Promise<RunExit> {
    const res = await fetch(config.boxdUrl + '/run', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(spec),
    });
    if (!res.ok || !res.body) throw new Error(`boxd run: ${res.status} ${await res.text().catch(() => '')}`);
    let exit: RunExit = { code: null, signal: null, error: 'stream ended without exit record', stderr: '' };
    let buf = '';
    const handle = (line: string) => {
      if (!line.trim()) return;
      let obj: any;
      try { obj = JSON.parse(line); } catch { return; }
      if (obj.type === 'cbot_exit') exit = obj; else onLine(obj);
    };
    const decoder = new TextDecoder();
    try {
      for await (const chunk of res.body as any) {
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
      }
      handle(buf);
    } catch (e: any) {
      exit = { code: null, signal: null, error: `connection to the box lost: ${e.message}`, stderr: '' };
    }
    return exit;
  },
};
