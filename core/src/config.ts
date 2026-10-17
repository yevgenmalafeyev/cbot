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
  // Spoken replies (Telegram voice messages): Azure Speech when configured
  // (many languages), else Groq (English only); see speech.ts.
  azureSpeechKey: process.env.AZURE_SPEECH_KEY || '',
  azureSpeechRegion: process.env.AZURE_SPEECH_REGION || '',
  /** only for a resource with a custom domain, e.g. https://name.cognitiveservices.azure.com */
  azureSpeechEndpoint: process.env.AZURE_SPEECH_ENDPOINT || '',
  /** for languages without a voice of their own in speech.ts */
  azureVoice: process.env.AZURE_TTS_VOICE || 'en-US-AvaMultilingualNeural',
  ttsModel: process.env.TTS_MODEL || 'canopylabs/orpheus-v1-english',
  ttsVoice: process.env.TTS_VOICE || 'hannah',
  ttsMaxChars: Number(process.env.TTS_MAX_CHARS || 2000),
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

  // A bot's memory file is loaded into every session: keep it short. Past the
  // limit the bot is told to consolidate, and the review pass does it too.
  memoryCharLimit: Number(process.env.MEMORY_CHAR_LIMIT || 8000),
  // After a task, a cheap model replays its session and saves what should be
  // remembered (memory file, skills) without touching the chat session.
  memoryReview: process.env.MEMORY_REVIEW !== '0',
  memoryReviewModel: process.env.MEMORY_REVIEW_MODEL || 'haiku',
  // A run nobody asked for (schedule, mail watch) does not wait on the owner
  // forever: an unanswered approval is denied, an unanswered question dropped.
  unattendedAnswerMs: Number(process.env.UNATTENDED_ANSWER_HOURS || 12) * 3600_000,
  // A task waiting on the owner for longer than this gives up its slot when
  // other tasks are queued; it is resumed with the answer when it arrives.
  parkAfterMs: Number(process.env.PARK_AFTER_SECONDS || 60) * 1000,
  // Longer texts handed to a chat session are cut here and written to a file in full.
  spillChars: Number(process.env.SPILL_CHARS || 2500),
};

if (config.masterKey.length !== 32) throw new Error('MASTER_KEY must be 32 bytes of hex');
