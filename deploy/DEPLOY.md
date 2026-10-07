# Deploying cbot

Everything lives under `/opt/cbot` on a Linux host with Docker.

| Path | |
|---|---|
| `/opt/cbot/src` | this repository |
| `/opt/cbot/.env` | core's secrets (`.env.example`), mode 600 |
| `/opt/cbot/box.env` | `BOXD_TOKEN` only; the box must never see `.env` |
| `/opt/cbot/data/core` | SQLite database (tasks, links, encrypted secrets) |
| `/opt/cbot/data/home` | the bots' `/home/bot`: Claude login, Chrome profiles, files |

## First start

```sh
mkdir -p /opt/cbot/data/core /opt/cbot/data/home
git clone <this repository> /opt/cbot/src
cp /opt/cbot/src/.env.example /opt/cbot/.env && chmod 600 /opt/cbot/.env   # fill it in
echo "BOXD_TOKEN=<same value as in .env>" > /opt/cbot/box.env && chmod 600 /opt/cbot/box.env
cd /opt/cbot/src && docker compose build && docker compose up -d
docker exec -it -u bot cbot-box claude     # then /login with your Claude subscription
```

Then install the firewall and the reverse proxy below, and write to your bot.

## Update

```sh
cd /opt/cbot/src && git pull && docker compose build && docker compose up -d
```

Restarting `core` interrupts running tasks (the owner is told). Recreating
`box` additionally closes Chrome and drops system packages not listed in
`/home/bot/.cbot/setup.sh`. To update only the control plane:
`docker compose up -d --build core`.

## Firewall

Not optional. Copy `deploy/firewall/cbot-container-egress.sh` to
`/usr/local/sbin/` and `cbot-firewall.service` to `/etc/systemd/system/`, then
`systemctl enable --now cbot-firewall`. Site-specific addresses go into
`/etc/default/cbot-firewall` (see the comments in the script). After any
change to it, to docker, or to the compose network:

```sh
PRIVATE_TARGETS="<this host's private address> <a neighbour>" \
  /opt/cbot/src/deploy/firewall/verify-isolation.sh
```

## Public entry

`PUBLIC_URL` must be an HTTPS address that reaches core's port 8790 through a
reverse proxy; `deploy/nginx/cbot.conf` is a working nginx vhost. Core's port
is never exposed to the internet directly.

## Logs

```sh
docker logs -f cbot-core
docker logs -f cbot-box
docker exec cbot-box cat /run/cbot/display-11.log   # main bot's X server
```
