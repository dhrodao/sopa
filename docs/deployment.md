# Deployment (Nginx container behind a Cloudflare Tunnel)

This app is a static site (HTML/CSS/JS, no build step). It is served by Nginx
in a container. This repo does **not** run the Cloudflare Tunnel: the
`cloudflared` connector lives on a separate infrastructure host and forwards to
this container over the LAN. TLS is terminated by Cloudflare at the edge; the
last hop (connector → Nginx) is plain HTTP on the LAN.

```
Browser ──HTTPS──> Cloudflare edge ──Tunnel──> cloudflared (infra host) ──HTTP──> nginx (this host)
```

## Architecture notes (why it is set up this way)

- Nginx is published on **host port 8080** (all interfaces, configurable with
  `WEB_PORT`) so the connector on the infra host can reach it at
  `http://<this-host-ip>:8080`. Restrict that
  port to the infra host with your firewall if the LAN is not fully trusted.
- Nginx serves plain **HTTP on port 80** inside the container, published on
  host port 8080 above.

## Prerequisites

- A home server running 24/7 with **Docker** + the **Compose plugin**.
- Domain with DNS on Cloudflare, and **Zero Trust** enabled (free tier is fine).
- A `cloudflared` connector already running on another host.

## 1. Point the tunnel at this host

In **Zero Trust → Networks → Tunnels → (your tunnel) → Public Hostname**, add a
route:

- **Subdomain/Domain**: e.g. `sopa` . `dhrodao.me`
- **Service → Type**: `HTTP`
- **URL**: `<this-host-ip>:8080`

## 2. Configure the server

```bash
git clone git@github.com:dhrodao/sopa.git
cd sopa
```

No `.env` is needed unless you want a host port other than 8080: copy
`.env.example` to `.env` and set `WEB_PORT`. The tunnel's Public Hostname URL
must use the same port.

## 3. Build and run

```bash
docker compose up -d --build
```

One container starts: **web** — Nginx serving HTTP on port 80, published at
host port 8080.

## 4. Verify

```bash
# origin health over HTTP:
curl -I http://<this-host-ip>:8080/healthz    # -> HTTP/.. 200
```

Then open `https://sopa.dhrodao.me` in a browser.

## 5. Updating the app

```bash
git pull
docker compose up -d --build
```

`index.html` is served with `Cache-Control: no-cache`; other assets cache for
7 days. Hard-refresh (Ctrl/Cmd+Shift+R) if an asset looks stale.

## Files involved

| File                  | Purpose                                              |
| --------------------- | ---------------------------------------------------- |
| `Dockerfile`          | Builds the Nginx image with the static app           |
| `deploy/nginx.conf`   | Nginx config: HTTP 80, gzip, cache, headers, health  |
| `docker-compose.yml`  | `web` (host 8080→80)                                 |

## Troubleshooting

- **`tls: first record does not look like a TLS handshake`** or
  **`http: server gave HTTP response to HTTPS client`** in the connector: the
  Public Hostname service type is `HTTPS` but Nginx speaks plain HTTP. Set it to
  **HTTP** → `<this-host-ip>:8080`.
- **`Bind for 0.0.0.0:8080 failed: port is already allocated`**: another
  service uses 8080. Set `WEB_PORT` in `.env` to a free port and update the
  Public Hostname URL accordingly.
- **502 from Cloudflare**: the connector cannot reach `<this-host-ip>:8080`.
  Check the container is up, the IP/port in the route, and any firewall.
