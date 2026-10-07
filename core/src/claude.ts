// Starts Claude CLI sessions in the box and interprets their output stream.
import crypto from 'node:crypto';
import { box, RunExit } from './box.js';
import { BotRow, bots, newToken } from './db.js';
import { config } from './config.js';

export interface RunContext { botId: number; role: 'front' | 'task'; taskId: number | null }
/** token -> who is calling; lives exactly as long as the Claude process */
export const runTokens = new Map<string, RunContext>();

export interface ClaudeSpec {
  runId: string;
  role: 'front' | 'task';
  bot: BotRow;
  taskId?: number;
  model: string;
  systemPrompt: string;
  prompt: string;
  sessionId: string | null;   // with resume=false: null starts a new session
  resume: boolean;
  screen: boolean;
  onEvent?: (ev: any) => void;
}

export interface ClaudeResult {
  ok: boolean;
  text: string;
  sessionId: string | null;
  limitHit: boolean;
  limitResetAt: number | null;
  sessionMissing: boolean;
  exit: RunExit;
}

// The chat-facing session only dispatches; work happens in tasks.
const FRONT_DISALLOWED = 'Bash,BashOutput,KillShell,Task,Agent,NotebookEdit';

const LIMIT_RE = /usage limit|hit your limit|limit reached|rate limit|out of extra usage/i;

function parseLimitReset(text: string): number | null {
  const epoch = text.match(/\|(\d{10})\b/);
  if (epoch) return Number(epoch[1]) * 1000;
  return null;
}

export async function runClaude(spec: ClaudeSpec): Promise<ClaudeResult> {
  const token = newToken();
  runTokens.set(token, { botId: spec.bot.id, role: spec.role, taskId: spec.taskId ?? null });
  const home = bots.home(spec.bot);
  const display = bots.display(spec.bot);
  const sessionId = spec.sessionId ?? crypto.randomUUID();

  const mcp = {
    mcpServers: {
      cbot: {
        command: 'node',
        args: ['/opt/cbot/mcp/server.mjs'],
        env: {
          CBOT_CORE_URL: config.coreUrlFromBox,
          CBOT_RUN_TOKEN: token,
          CBOT_ROLE: spec.role,
          CBOT_SCREEN: spec.screen ? '1' : '0',
          CBOT_DISPLAY_N: String(display),
          CBOT_BOT_HOME: home,
        },
      },
    },
  };

  const args = [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--model', spec.model,
    '--dangerously-skip-permissions',
    '--strict-mcp-config', '--mcp-config', JSON.stringify(mcp),
    '--append-system-prompt', spec.systemPrompt,
    ...(spec.role === 'front' ? ['--disallowedTools', FRONT_DISALLOWED] : []),
    ...(spec.resume ? ['--resume', sessionId] : ['--session-id', sessionId]),
  ];

  let resultEv: any = null;
  let seenSession: string | null = null;
  let lastText = '';
  try {
    const exit = await box.run({
      id: spec.runId,
      args,
      cwd: home,
      env: {
        CBOT_BOT_HOME: home,
        ...(spec.screen ? { DISPLAY: `:${display}` } : {}),
        // Some tools wait for the owner for hours (help, approval, questions).
        MCP_TOOL_TIMEOUT: String(7 * 24 * 3600_000),
        MCP_TIMEOUT: '60000',
        ...(spec.role === 'front' ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: config.frontCompactWindow } : {}),
      },
      stdin: spec.prompt,
    }, (ev) => {
      if (ev.session_id) seenSession = ev.session_id;
      if (ev.type === 'result') resultEv = ev;
      if (ev.type === 'assistant') {
        for (const block of ev.message?.content ?? []) if (block.type === 'text' && block.text?.trim()) lastText = block.text;
      }
      spec.onEvent?.(ev);
    });

    const text: string = (resultEv?.result ?? '').toString();
    const failed = !resultEv || resultEv.is_error || resultEv.subtype !== 'success';
    const errText = `${text}\n${exit.stderr}\n${exit.error ?? ''}`;
    const limitHit = failed && LIMIT_RE.test(errText);
    return {
      ok: !failed,
      text: failed ? (text || lastText || exit.error || exit.stderr.trim().split('\n').pop() || 'Claude exited without a result') : text,
      sessionId: seenSession ?? (spec.resume ? sessionId : null),
      limitHit,
      limitResetAt: limitHit ? parseLimitReset(errText) : null,
      sessionMissing: failed && /No conversation found/i.test(errText),
      exit,
    };
  } finally {
    runTokens.delete(token);
  }
}

// One-line description of what a session is doing, for the live status message.
const site = (url: unknown): string => { try { return new URL(String(url)).hostname.replace(/^www\./, ''); } catch { return 'opening a page'; } };

export function describeEvent(ev: any): string | null {
  if (ev.type !== 'assistant') return null;
  let line: string | null = null;
  for (const b of ev.message?.content ?? []) {
    if (b.type === 'text' && b.text?.trim()) line = '💬 ' + b.text.trim().split('\n')[0];
    if (b.type !== 'tool_use') continue;
    const i = b.input ?? {};
    const name: string = b.name.replace(/^mcp__cbot__/, '');
    // The owner reads this on their phone: say what is happening, not the command behind it.
    switch (name) {
      case 'Read': case 'Edit': case 'Write': line = '📄 working with files'; break;
      case 'WebSearch': line = `🔎 ${i.query ?? ''}`; break;
      case 'WebFetch': case 'open_url': line = `🌐 ${site(i.url)}`; break;
      case 'screenshot': case 'wait': line = '👀 looking at the screen'; break;
      case 'click': case 'move_mouse': case 'drag': case 'scroll': line = '🖱 working on the screen'; break;
      case 'type_text': case 'press_key': line = '⌨️ typing'; break;
      case 'type_secret': line = `🔑 entering ${i.name ?? 'a secret'}`; break;
      case 'request_help': case 'ask_user': case 'request_approval': case 'request_secret': line = '⏸ waiting for you'; break;
      default: line = name.startsWith('mail_') ? '✉️ working with mail' : '⚙️ working';
    }
  }
  return line && (line.length > 160 ? line.slice(0, 157) + '…' : line);
}
