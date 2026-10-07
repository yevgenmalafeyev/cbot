#!/usr/bin/python3
"""Exit proxy for cbot (see deploy/office-exit/README.md).

A minimal HTTP forward proxy. It exists so the bots' browsers can leave
through a connection of your choice. Deliberately narrow:
  - only the clients in ALLOWED_CLIENTS may use it;
  - only ports 80 and 443;
  - never to private, loopback or link-local addresses, so it cannot be used
    to reach the network it runs in;
  - never to the addresses in BLOCKED: list public servers that trust this
    connection's address there.
"""
import asyncio, ipaddress, socket, sys

LISTEN = ("0.0.0.0", 8888)
ALLOWED_CLIENTS = {"10.8.0.1"}   # the tunnel address of the cbot side
ALLOWED_PORTS = {80, 443}
# public addresses that must not be reachable through this proxy, e.g. "203.0.113.7/32"
BLOCKED = [ipaddress.ip_network(n) for n in ()]


async def resolve(host, port):
    """Resolve once, vet the address, and connect to exactly that address."""
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, port, family=socket.AF_INET, type=socket.SOCK_STREAM)
    for *_, sockaddr in infos:
        ip = ipaddress.ip_address(sockaddr[0])
        if ip.is_global and not any(ip in n for n in BLOCKED):
            return sockaddr[0]
    raise PermissionError("destination not allowed")


async def pipe(reader, writer):
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except Exception:
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def handle(reader, writer):
    peer = writer.get_extra_info("peername")[0]
    try:
        if peer not in ALLOWED_CLIENTS:
            return
        head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 15)
        lines = head.decode("latin1").split("\r\n")
        method, target, _ = lines[0].split(" ", 2)
        if method == "CONNECT":
            host, _, port = target.rpartition(":")
            port = int(port)
            first = b""
        else:
            # plain http://host[:port]/path request
            if not target.lower().startswith("http://"):
                raise ValueError("bad request")
            rest = target[7:]
            hostport, slash, path = rest.partition("/")
            host, _, p = hostport.partition(":")
            port = int(p or 80)
            keep = [l for l in lines[1:] if l and not l.lower().startswith(("proxy-", "connection:"))]
            first = ("%s /%s HTTP/1.1\r\n%s\r\nConnection: close\r\n\r\n" % (method, path, "\r\n".join(keep))).encode("latin1")
        if port not in ALLOWED_PORTS:
            raise PermissionError("port not allowed")
        ip = await resolve(host.strip("[]"), port)
        up_r, up_w = await asyncio.wait_for(asyncio.open_connection(ip, port), 15)
        if method == "CONNECT":
            writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            await writer.drain()
        else:
            up_w.write(first)
        await asyncio.gather(pipe(reader, up_w), pipe(up_r, writer))
    except PermissionError:
        writer.write(b"HTTP/1.1 403 Forbidden\r\n\r\n")
    except Exception:
        try:
            writer.write(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
        except Exception:
            pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def main():
    server = await asyncio.start_server(handle, *LISTEN)
    print("cbot exit proxy listening on %s:%d" % LISTEN, flush=True)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
