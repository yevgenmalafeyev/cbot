# cbot

Self-hosted personal assistant bots in Telegram, powered by Claude Code.

Each bot has its own Linux desktop with Chrome and works on it the way a
person would: it looks at the screen, clicks and types. You give it work in a
Telegram chat, it does the work in the background, and it comes back to you
when it needs a human: a captcha, a login code, a password, or your approval.

It runs on your own server, on your own Claude subscription, and answers to
exactly one Telegram account: yours.

## What it does

- **Tasks from chat.** Write or dictate what you need. The bot starts a
  background task, shows a live status line, and delivers a short result.
- **A real browser.** Logins persist in the bot's own Chrome profile, so it
  can work in sites that have no API.
- **Hands you the screen.** When only a person can get past something, you get
  a button that opens the bot's live desktop inside Telegram. You do the step,
  tap "I'm done, go on", and it continues.
- **Asks before it acts.** Spending money, sending anything in your name,
  posting publicly and deleting data all wait for an Approve / Deny tap. So do
  new schedules, mail watches and changes to a bot's standing instructions.
- **Secrets it never sees.** Passwords are entered on a one-time private page,
  stored encrypted, and typed into login forms by the control plane itself;
  the agent's machine is never handed the value.
- **Mail.** Gmail (API) and any IMAP/SMTP mailbox, any number per bot. A mail
  watch starts a task only when a matching message arrives.
- **Schedules.** Recurring (cron) and one-off tasks.
- **A fleet.** Ask the main bot for another bot with its own role. Each gets
  its own Telegram identity, memory, Chrome profile and screen.
- **Voice and files.** Voice messages are transcribed (optional, Groq); files
  go both ways.

## How it is built

Two containers, on purpose:

| Path | What |
|---|---|
| `core/` | Control plane (TypeScript): Telegram, task queue, approvals, encrypted secret store, the public link gateway. Holds every credential. |
| `box/` | The bots' computer (Debian, XFCE, Chrome, Claude CLI). `boxd/` is the daemon core talks to, `mcp/` the tool server each Claude session gets, `bin/cbot-display` the per-bot virtual screens. |
| `deploy/` | Host firewall, nginx vhost, deployment notes, optional exit proxy. |

Agents are root inside the box and read the open web, so the box is treated
as hostile: the bot tokens, the secret store and its key live in `core`, which
the box can only reach through a narrow, per-session API. A host firewall
keeps the box off your private network.

### How a message becomes work

1. A Telegram message reaches `core`, which runs one turn of the bot's chat
   session (`claude -p --resume`) in the box. That session cannot run
   commands; it answers or calls `start_task`.
2. A task is a separate Claude session with a shell and, if asked for, the
   bot's screen. `core` turns its event stream into one live-edited status
   message and delivers its final reply as the result.
3. Tools that need the owner (`ask_user`, `request_help`, `request_secret`,
   `request_approval`) block that task only, until you answer, tap or submit.

Screens are Xvnc displays started on first use and stopped after 15 idle
minutes. The browser is driven by screenshots, mouse and keyboard only.

### Links

Screen and secret links open inside Telegram, in the bot's own window.

- `/a/<slug>` the bot's Mini App: what it is waiting for, its tasks, its
  screen. Every call is checked against Telegram's signed launch data: this
  bot, the owner, at most 24 h old.
- `/h/<token>` screen view (noVNC). Inside Telegram the launch data proves the
  owner. In a plain browser it is bound to the first one that opens it.
  Valid 24 h or until Done.
- `/s/<token>` one field for a secret; works once. Values are AES-256-GCM
  encrypted with `MASTER_KEY`, which exists only in `core`'s environment.
- `/d/<token>` download for files over Telegram's 50 MB limit.

## Requirements

- A Linux server with Docker; 4 GB RAM and 2-3 CPU cores for the two
  containers.
- A Claude subscription (the bots run on the Claude CLI, logged in once inside
  the box).
- A Telegram bot token from @BotFather and your own Telegram user ID.
- A domain with HTTPS pointing at a reverse proxy in front of `core`.

## Quick start

```sh
mkdir -p /opt/cbot/data/core /opt/cbot/data/home
git clone https://github.com/yevgenmalafeyev/cbot.git /opt/cbot/src
cp /opt/cbot/src/.env.example /opt/cbot/.env && chmod 600 /opt/cbot/.env   # fill it in
echo "BOXD_TOKEN=<same value as in .env>" > /opt/cbot/box.env && chmod 600 /opt/cbot/box.env
cd /opt/cbot/src && docker compose build && docker compose up -d
docker exec -it -u bot cbot-box claude     # then /login
```

Then set up the firewall and the reverse proxy as described in
[`deploy/DEPLOY.md`](deploy/DEPLOY.md), and write to your bot.

Main settings (`.env.example` has them all): `TELEGRAM_BOT_TOKEN`,
`OWNER_TG_ID`, `PUBLIC_URL`, `MASTER_KEY`, `BOXD_TOKEN`. Optional:
`GROQ_API_KEY` (voice), `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (Gmail),
`TZ`, `FRONT_MODEL`, `TASK_MODEL`.

## Read this before you run it

This gives an AI agent a browser with your logins, your mailboxes and stored
passwords, and lets it read arbitrary web pages and email. That is the point,
and it is also the risk.

- A stored secret never leaves `core`: `core` types it on the bot's screen
  itself, and only for the task you entered it for, or after you approve that
  use with a button. An agent hijacked by something it read can still see
  whatever is typed on its own screen, so this protects the secret store, not
  a secret you have just let a hijacked task use.
- Sessions in the box are not isolated from each other, so `core` does not
  trust them: schedules, mail watches, changes to a bot's instructions,
  sending and trashing mail and deleting a bot all happen only after you
  approve the exact content with a button. Starting a one-off task does not.
- A screen-driven agent cannot be technically prevented from clicking "Send"
  on a web page; for actions in the browser, approvals are a rule the agent
  follows.
- Text the agent reads (pages, mail) can try to steer it. The prompts tell it
  to treat such text as data, and the firewall limits what a steered agent
  can reach, but neither is a guarantee.
- The firewall in `deploy/firewall` is part of the design, not an extra.
  Without it the box can reach your host and your private network.
- There are no backups. Everything is under `/opt/cbot/data` on the host.
- System packages installed by a bot do not survive an image rebuild unless
  it recorded them in `/home/bot/.cbot/setup.sh` (it is told to).

Use accounts and a server you can afford to have misused, and start with
low-stakes work. The software is provided as is, without warranty; see
[LICENSE](LICENSE).

## Status

A personal project that runs one person's bots every day. It is shared as is:
there is no installer, the setup assumes you are comfortable with Docker,
nginx and iptables, and things may change without notice. Issues and pull
requests are welcome.

Not affiliated with Anthropic or Telegram.

## Licence

MIT.
