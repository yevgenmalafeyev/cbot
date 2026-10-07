import { bots } from './db.js';
import { box } from './box.js';
import { startBot, stopAll } from './telegram.js';
import { startGateway } from './gateway.js';
import { startInternal } from './internal.js';
import { recoverAfterRestart, startRequestLoops } from './agent.js';
import { startScheduler } from './schedule.js';
import { startMailWatcher } from './mail.js';

async function waitForBox(): Promise<void> {
  for (let i = 0; ; i++) {
    try { await box.health(); return; }
    catch { if (i % 10 === 0) console.log('[core] waiting for the box…'); await new Promise((r) => setTimeout(r, 3000)); }
  }
}

async function main() {
  bots.ensureMain();
  startInternal();
  startGateway();
  for (const b of bots.all()) await startBot(b);
  await waitForBox();
  await recoverAfterRestart();
  startRequestLoops();
  startScheduler();
  startMailWatcher();
  console.log('[core] ready');
}

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => { await stopAll(); process.exit(0); });
}
process.on('unhandledRejection', (e) => console.error('[core] unhandled rejection', e));

main().catch((e) => { console.error('[core] fatal', e); process.exit(1); });
