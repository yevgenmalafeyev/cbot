import net from 'node:net';
import { config } from './config.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// X keysyms: Latin-1 maps to itself, everything else is Unicode + 0x01000000
const keysym = (ch: string): number => { const cp = ch.codePointAt(0)!; return cp === 10 ? 0xff0d : cp < 0x100 ? cp : 0x01000000 | cp; };
function keyEvent(sym: number, down: boolean): Buffer {
  const b = Buffer.alloc(8);
  b[0] = 4; b[1] = down ? 1 : 0;
  b.writeUInt32BE(sym, 4);
  return b;
}

/**
 * Type text on a bot's screen as key presses, from here. This is how stored
 * secrets reach a login form: the value goes from core straight to the X
 * server and is never handed to anything an agent can ask for it.
 * Speaks just enough RFB (3.8, no authentication) for that.
 */
export function typeOnDisplay(display: number, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(5900 + display, config.boxHost);
    let buf: Buffer = Buffer.alloc(0);
    let step = 0;
    let settled = false;
    const finish = (e?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      if (e) reject(e); else resolve();
    };
    const timer = setTimeout(() => finish(new Error('The screen did not answer.')), 15_000);
    const take = (n: number): Buffer | null => {
      if (buf.length < n) return null;
      const head = buf.subarray(0, n);
      buf = buf.subarray(n);
      return head;
    };
    const press = async () => {
      for (const ch of text) {
        const sym = keysym(ch);
        sock.write(keyEvent(sym, true));
        sock.write(keyEvent(sym, false));
        await sleep(15);
      }
      await sleep(250);   // let the last keys reach the application before the connection goes
      finish();
    };
    sock.on('error', (e) => finish(e));
    sock.on('close', () => finish(new Error('The screen closed the connection.')));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (step === 0) {                       // server version
          if (!take(12)) return;
          sock.write('RFB 003.008\n');
          step = 1;
        } else if (step === 1) {                // security types
          if (buf.length < 1 || buf.length < 1 + buf[0]) return;
          const types = take(1 + buf[0])!.subarray(1);
          if (!types.includes(1)) return finish(new Error('The screen does not accept this connection.'));
          sock.write(Buffer.from([1]));
          step = 2;
        } else if (step === 2) {                // security result
          const r = take(4);
          if (!r) return;
          if (r.readUInt32BE(0) !== 0) return finish(new Error('The screen refused the connection.'));
          sock.write(Buffer.from([1]));         // shared: do not disconnect whoever is watching
          step = 3;
        } else if (step === 3) {                // server init: 24 bytes + the desktop name
          if (buf.length < 24 || buf.length < 24 + buf.readUInt32BE(20)) return;
          take(24 + buf.readUInt32BE(20));
          step = 4;
          clearTimeout(timer);
          void press();
        } else {
          buf = Buffer.alloc(0);                // nothing was requested; ignore whatever arrives
          return;
        }
      }
    });
  });
}
