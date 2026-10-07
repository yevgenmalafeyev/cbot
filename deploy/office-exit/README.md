# Exit proxy (optional)

Sites treat traffic from datacenter addresses with suspicion: more captchas,
more blocked logins. This makes the bots' browsers leave through an ordinary
connection you control (an office or home line) instead, with automatic
fallback to the server's own address.

```
Chrome (box) -> exitd 127.0.0.1:3128 (box/boxd/exitd.mjs)
   proxy up:   -> OFFICE_PROXY host:port -> your tunnel -> proxy.py -> internet
   proxy down: -> internet directly, from the server's address
```

- `proxy.py` is a minimal forward proxy to run on a machine behind that
  connection. It only serves the clients listed in `ALLOWED_CLIENTS`, only
  ports 80/443, and never private or loopback addresses, so it cannot be used
  to reach the network it sits in. Put any public addresses that trust that
  connection (servers that whitelist it) into `BLOCKED`.
- How the box reaches it is up to you; a WireGuard tunnel that the proxy
  machine dials out on keeps it free of inbound ports. Whatever sits in
  between, the firewall must let the box reach exactly that one host and port
  (`EXIT_PROXY_HOST` / `EXIT_PROXY_PORT` in `deploy/firewall`).
- `exitd` probes the route every 30 s. Two failures in a row switch to direct,
  one success switches back; core tells the owner in Telegram.
- Enable with `OFFICE_PROXY=host:port` in `/opt/cbot/box.env`. Without it the
  browsers simply go out directly.
