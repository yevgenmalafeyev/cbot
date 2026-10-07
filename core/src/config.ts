function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

export const config = {
  mainBotToken: required('TELEGRAM_BOT_TOKEN'),
  ownerId: Number(required('OWNER_TG_ID')),
  publicUrl: required('PUBLIC_URL').replace(/\/$/, ''),
  masterKey: Buffer.from(required('MASTER_KEY'), 'hex'),
  boxdUrl: process.env.BOXD_URL || 'http://box:7070',
  boxdToken: required('BOXD_TOKEN'),
  boxHost: process.env.BOX_HOST || 'box',
  // how the box reaches this process (the internal listener)
  coreUrlFromBox: process.env.CORE_URL_FROM_BOX || 'http://core:8791',
  groqKey: process.env.GROQ_API_KEY || '',
  // Google OAuth client (type: web application) used to connect Gmail accounts
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  dataDir: process.env.DATA_DIR || '/data',
  publicPort: Number(process.env.PUBLIC_PORT || 8790),
  internalPort: Number(process.env.INTERNAL_PORT || 8791),
  timezone: process.env.TZ || 'Europe/Lisbon',

  frontModel: process.env.FRONT_MODEL || 'opus',
  taskModel: process.env.TASK_MODEL || 'sonnet',
  // The chat session is resumed indefinitely; compacting it early keeps every
  // turn cheap. Durable facts live in the bot's memory file, not the transcript.
  frontCompactWindow: process.env.FRONT_COMPACT_WINDOW || '150000',
  maxParallelTasks: Number(process.env.MAX_PARALLEL_TASKS || 3),
  // 4 GB box: two Chromes at once is the ceiling
  maxScreens: Number(process.env.MAX_SCREENS || 2),
  remindAfterMs: Number(process.env.REMIND_HOURS || 3) * 3600_000,
  linkTtlMs: 24 * 3600_000,
  telegramFileLimit: 49 * 1024 * 1024,
};

if (config.masterKey.length !== 32) throw new Error('MASTER_KEY must be 32 bytes of hex');
