// Spoken replies: a bot's text becomes a Telegram voice message.
//
// Two providers:
//   - Azure Speech (AZURE_SPEECH_KEY + AZURE_SPEECH_REGION): neural voices in
//     ~140 languages and accents, Ogg/Opus straight from the service. Used
//     whenever it is configured.
//   - Groq Orpheus (GROQ_API_KEY): English only, at most 200 characters a
//     request, WAV only. The text is cut into sentence-sized pieces, the PCM is
//     joined and ffmpeg packs it as Ogg/Opus.
// Telegram shows Ogg/Opus as a voice bubble with a waveform.
import { spawn } from 'node:child_process';
import { config } from './config.js';

const azure = () => !!config.azureSpeechKey && !!(config.azureSpeechRegion || config.azureSpeechEndpoint);
export const speechReady = () => azure() || !!config.groqKey;
/** false: only English can be spoken (Groq) */
export const multilingual = () => azure();

/** Markdown meant for the eye -> plain words for the ear. */
export function plainForSpeech(md: string): string {
  let s = md.replace(/```[^\n]*\n[\s\S]*?```/g, ' ');            // code blocks say nothing aloud
  s = s.replace(/`([^`\n]+)`/g, '$1');
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1');  // link text only
  s = s.replace(/https?:\/\/\S+/g, ' ');
  s = s.replace(/^#{1,6}\s+/gm, '');
  s = s.replace(/(\*\*|__|\*|_)(?=\S)([^*_\n]+?)(?<=\S)\1/g, '$2');
  s = s.replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '');
  s = s.replace(/\((?:\d+h )?(?:\d+m )?\d+[hms]\)/g, '');          // task durations like (3m 10s)
  s = s.replace(/#(\d+)/g, '$1');
  s = s.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]/gu, ' ');
  s = s.replace(/[|<>]/g, ' ');
  s = s.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  return s.replace(/([^.!?…:;,\n])\n/g, '$1.\n');                  // a line break is a pause
}

function budget(text: string): string {
  if (text.length <= config.ttsMaxChars) return text;
  const cut = text.lastIndexOf('. ', config.ttsMaxChars);
  return text.slice(0, cut > config.ttsMaxChars / 2 ? cut + 1 : config.ttsMaxChars);
}

async function post(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (res.ok) return res;
    const body = await res.text().catch(() => '');
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const wait = Number(res.headers.get('retry-after')) * 1000 || 1500 * (attempt + 1);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    throw Object.assign(new Error(`speech synthesis failed: ${res.status} ${body.slice(0, 200)}`), { status: res.status });
  }
}

// ===================================================================== Azure
/** One natural voice per common language; anything else goes to the multilingual voice. */
const VOICES: Record<string, string> = {
  'en': 'en-US-AvaMultilingualNeural', 'en-US': 'en-US-AvaMultilingualNeural', 'en-GB': 'en-GB-SoniaNeural',
  'pt': 'pt-PT-RaquelNeural', 'pt-PT': 'pt-PT-RaquelNeural', 'pt-BR': 'pt-BR-FranciscaNeural',
  'uk': 'uk-UA-PolinaNeural', 'uk-UA': 'uk-UA-PolinaNeural',
  'ru': 'ru-RU-SvetlanaNeural', 'ru-RU': 'ru-RU-SvetlanaNeural',
  'es': 'es-ES-ElviraNeural', 'es-ES': 'es-ES-ElviraNeural',
  'fr': 'fr-FR-DeniseNeural', 'fr-FR': 'fr-FR-DeniseNeural',
  'de': 'de-DE-KatjaNeural', 'de-DE': 'de-DE-KatjaNeural',
  'it': 'it-IT-ElsaNeural', 'it-IT': 'it-IT-ElsaNeural',
  'pl': 'pl-PL-ZofiaNeural', 'pl-PL': 'pl-PL-ZofiaNeural',
};
const VOICE_NAME = /^([a-z]{2,3}-[A-Z]{2,4}(?:-[A-Za-z]+)?)-\w+Neural$/;
const LOCALE = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;
/** A language setting the owner can give: "pt-PT", "uk", or a full Azure voice name. */
export const validVoiceSetting = (s: string) => LOCALE.test(s) || VOICE_NAME.test(s);

/** A rough guess from the letters and a few common words; null: let the multilingual voice decide. */
export function guessLanguage(text: string): string | null {
  const cyr = (text.match(/[Ѐ-ӿ]/g) ?? []).length;
  if (cyr > text.length / 10) return /[іїєґІЇЄҐ]/.test(text) ? 'uk-UA' : 'ru-RU';
  const t = ` ${text.toLowerCase()} `;
  const hits = (words: string[]) => words.reduce((n, w) => n + (t.split(` ${w} `).length - 1), 0);
  if (/[ãõ]|ção|ções/.test(t) || hits(['não', 'você', 'está', 'uma', 'para', 'com', 'que', 'os', 'as']) >= 4 && /[ãõçéá]/.test(t)) return 'pt-PT';
  if (/[ñ¿¡]/.test(t)) return 'es-ES';
  if (/ß/.test(t) || hits(['und', 'nicht', 'ist', 'der', 'die', 'das', 'ich']) >= 3) return 'de-DE';
  if (hits(['le', 'la', 'les', 'est', 'et', 'pas', 'vous', 'je', 'une']) >= 3 && /[éèêàç]/.test(t)) return 'fr-FR';
  if (/[ąęłńśźż]/.test(t)) return 'pl-PL';
  return null;
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function pickVoice(setting: string | null, text: string): { voice: string; locale: string | null } {
  if (setting && VOICE_NAME.test(setting)) return { voice: setting, locale: setting.match(VOICE_NAME)![1] };
  const locale = setting || guessLanguage(text);
  const voice = (locale && (VOICES[locale] ?? VOICES[locale.split('-')[0]])) || config.azureVoice;
  return { voice, locale };
}

async function azureSpeak(text: string, setting: string | null): Promise<Buffer> {
  const url = config.azureSpeechEndpoint
    ? `${config.azureSpeechEndpoint.replace(/\/$/, '')}/tts/cognitiveservices/v1`
    : `https://${config.azureSpeechRegion}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const call = (voice: string, locale: string | null) => {
    const voiceLocale = voice.match(VOICE_NAME)?.[1] ?? 'en-US';
    // a multilingual voice told which language it speaks keeps the right accent (pt-PT, not pt-BR)
    const body = locale && locale.includes('-') && locale !== voiceLocale && /Multilingual/.test(voice)
      ? `<lang xml:lang="${locale}">${xml(text)}</lang>` : xml(text);
    return post(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': config.azureSpeechKey,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'ogg-48khz-16bit-mono-opus',
        'User-Agent': 'cbot',
      },
      body: `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${voiceLocale}"><voice name="${voice}">${body}</voice></speak>`,
    });
  };
  const { voice, locale } = pickVoice(setting, text);
  let res: Response;
  try { res = await call(voice, locale); }
  catch (e: any) {
    // an unknown voice name: the multilingual default can still say it
    if (e.status !== 400 || voice === config.azureVoice) throw e;
    console.error(`[speech] voice ${voice} refused, using ${config.azureVoice}`);
    res = await call(config.azureVoice, locale);
  }
  return Buffer.from(await res.arrayBuffer());
}

// ====================================================================== Groq
const PIECE = 200;

/** Cut into pieces of at most `max` characters, at sentence ends where possible, else at commas or spaces. */
export function pieces(text: string, max = PIECE): string[] {
  const out: string[] = [];
  let cur = '';
  const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
  for (const sentence of text.split(/(?<=[.!?…])\s+|\n+/)) {
    if (!sentence.trim()) continue;
    if (sentence.length > max) {
      push();
      let rest = sentence;
      while (rest.length > max) {
        let cut = rest.lastIndexOf(', ', max);
        if (cut < max / 2) cut = rest.lastIndexOf(' ', max);
        if (cut < max / 2) cut = max;
        out.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).replace(/^[,\s]+/, '');
      }
      cur = rest;
      continue;
    }
    if (cur && cur.length + 1 + sentence.length > max) push();
    cur = cur ? `${cur} ${sentence}` : sentence;
  }
  push();
  return out;
}

async function groqPiece(input: string): Promise<Buffer> {
  const res = await post('https://api.groq.com/openai/v1/audio/speech', {
    method: 'POST',
    headers: { authorization: `Bearer ${config.groqKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: config.ttsModel, voice: config.ttsVoice, input, response_format: 'wav' }),
  });
  return Buffer.from(await res.arrayBuffer());
}

/** The fmt chunk and the samples of a RIFF/WAVE file. */
function wavParts(wav: Buffer): { fmt: Buffer; pcm: Buffer } {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let fmt: Buffer | undefined, pcm: Buffer | undefined;
  for (let p = 12; p + 8 <= wav.length;) {
    const id = wav.toString('ascii', p, p + 4);
    let size = wav.readUInt32LE(p + 4);
    if (id === 'data' && (size === 0xffffffff || p + 8 + size > wav.length)) size = wav.length - p - 8;   // streamed: size unknown
    if (id === 'fmt ') fmt = wav.subarray(p + 8, p + 8 + size);
    if (id === 'data') pcm = wav.subarray(p + 8, p + 8 + size);
    p += 8 + size + (size & 1);
  }
  if (!fmt || !pcm) throw new Error('WAV without fmt or data chunk');
  return { fmt, pcm };
}

function wavJoin(parts: { fmt: Buffer; pcm: Buffer }[]): Buffer {
  const fmt = parts[0].fmt;
  const pcm = Buffer.concat(parts.map((p) => p.pcm));
  const head = Buffer.alloc(12 + 8 + fmt.length + 8);
  head.write('RIFF', 0); head.writeUInt32LE(4 + 8 + fmt.length + 8 + pcm.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(fmt.length, 16); fmt.copy(head, 20);
  head.write('data', 20 + fmt.length); head.writeUInt32LE(pcm.length, 24 + fmt.length);
  return Buffer.concat([head, pcm]);
}

function toOpus(wav: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-loglevel', 'error', '-i', 'pipe:0', '-vn', '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', '-f', 'ogg', 'pipe:1'],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = []; let err = '';
    ff.stdout.on('data', (d) => out.push(d));
    ff.stderr.on('data', (d) => { err += d; });
    ff.on('error', reject);
    ff.on('close', (code) => (code === 0 && out.length ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg: ${err.trim() || `exit ${code}`}`))));
    ff.stdin.on('error', () => {});
    ff.stdin.end(wav);
  });
}

async function groqSpeak(text: string): Promise<Buffer> {
  const list = pieces(text);
  // a few requests in flight at a time, results kept in order
  const wavs: Buffer[] = new Array(list.length);
  let i = 0;
  const worker = async () => { for (let k = i++; k < list.length; k = i++) wavs[k] = await groqPiece(list[k]); };
  await Promise.all(Array.from({ length: Math.min(3, list.length) }, worker));
  return toOpus(wavJoin(wavs.map(wavParts)));
}

/**
 * Speak a bot's message. `language`: the owner's choice ("pt-PT", "uk", or an
 * Azure voice name); null guesses from the text. Returns Ogg/Opus for
 * sendVoice, or null when there is nothing to say. Long texts are spoken up to
 * a budget; the text itself goes with the voice message, so nothing is lost.
 */
export async function speak(md: string, language: string | null = null): Promise<Buffer | null> {
  const text = budget(plainForSpeech(md));
  if (!/[\p{L}\p{N}]/u.test(text)) return null;
  return azure() ? azureSpeak(text, language) : groqSpeak(text);
}
