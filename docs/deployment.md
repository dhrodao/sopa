# Deployment (home server + Cloudflare Tunnel, end-to-end HTTPS)

This app is a static site (HTML/CSS/JS, no build step). It is served by Nginx
in a container and exposed through a **Cloudflare Tunnel**, so your home server
needs **no open ports, no public IP, and no router changes**. TLS is terminated
by Cloudflare at the edge *and* on the origin (Nginx), using a Cloudflare
**Origin CA** certificate — so the connection is encrypted end to end.

```
Browser ──HTTPS──> Cloudflare edge ──Tunnel(QUIC)──> cloudflared ──HTTPS──> nginx
```

## Architecture notes (why it is set up this way)

- **cloudflared runs with `network_mode: host`.** On some hosts (e.g. certain
  Proxmox/systemd-resolved setups) Docker's embedded DNS (`127.0.0.11`) fails to
  return the `argotunnel.com` SRV records cloudflared needs. Using the host
  network makes cloudflared use the host resolver, which works.
- Because cloudflared is on the host network, it cannot reach Nginx by the
  Compose service name. Nginx is therefore published on the **host loopback**
  at `127.0.0.1:8080` (not on the LAN), and the tunnel points to
  `https://localhost:8080`.
- Nginx serves **HTTPS on 443** inside the container using the Origin CA cert,
  mounted as a read-only volume from `deploy/certs/`.

## Prerequisites

- A home server running 24/7 with **Docker** + the **Compose plugin**.
- Domain with DNS on Cloudflare, and **Zero Trust** enabled (free tier is fine).

## 1. Create the Origin CA certificate

1. In the Cloudflare dashboard, pick your domain → **SSL/TLS → Origin Server**
   → **Create Certificate**.
2. Keep *Generate private key and CSR with Cloudflare*. Add the hostname
   (e.g. `sopa.dhrodao.me`, or `*.dhrodao.me`). Validity 15 years is fine.
3. Copy both blocks (the **private key is shown only once**).
4. On the server, save them under `deploy/certs/` with these exact names:
   ```bash
   mkdir -p deploy/certs
   # paste the Origin Certificate:
   nano deploy/certs/origin.pem
   # paste the Private Key:
   nano deploy/certs/origin.key
   chmod 600 deploy/certs/origin.key
   ```
   These files are secrets. They are gitignored and excluded from the Docker
   image; they are mounted as a volume at runtime.
5. Set **SSL/TLS → Overview → Full (strict)** for the domain, so Cloudflare
   validates the origin certificate.

## 2. Create the tunnel

1. **Zero Trust → Networks → Tunnels → Create a tunnel** → **Cloudflared** →
   name it (e.g. `sopa`).
2. On **Install connector**, copy the **token** (the long string after
   `--token`). You won't run that command; Compose uses the token.
3. In **Public Hostname**, add a route:
   - **Subdomain/Domain**: e.g. `sopa` . `dhrodao.me`
   - **Service → Type**: `HTTPS`
   - **URL**: `localhost:8080`
   - Leave **No TLS Verify** OFF (the Origin CA cert is trusted by Cloudflare).
4. Save. Cloudflare creates the DNS record automatically.

## 3. Configure the server

```bash
git clone git@github.com:dhrodao/sopa.git
cd sopa
cp .env.example .env
# edit .env and paste the tunnel token:
#   TUNNEL_TOKEN=eyJ....
```

`.env` is gitignored — the token never leaves the server.

## 4. Build and run

```bash
docker compose up -d --build
```

Two containers start:

- **web** — Nginx serving HTTPS on 443, published at `127.0.0.1:8080`.
- **cloudflared** — host network; connects the tunnel and forwards to
  `https://localhost:8080`.

Check the tunnel:

```bash
docker compose logs -f cloudflared   # look for "Registered tunnel connection"
```

## 5. Verify

```bash
# origin health over HTTPS (self-signed-to-localhost, so skip cert check):
curl -kI https://127.0.0.1:8080/healthz    # -> HTTP/.. 200
```

Then open `https://sopa.dhrodao.me` in a browser.

## 6. Updating the app

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
| `deploy/nginx.conf`   | Nginx config: 443 TLS, gzip, cache, headers, health  |
| `deploy/certs/`       | Origin CA `origin.pem` + `origin.key` (gitignored)   |
| `docker-compose.yml`  | `web` (loopback:8080→443) + `cloudflared` (host net) |
| `.env`                | `TUNNEL_TOKEN` (gitignored)                           |

## Troubleshooting

- **`tls: first record does not look like a TLS handshake`** in cloudflared:
  the Public Hostname service type is `HTTP` but Nginx now speaks HTTPS. Set it
  to **HTTPS** → `localhost:8080`.
- **`Bind for 0.0.0.0:8080 failed: port is already allocated`**: another
  service uses 8080. Change the host port in `docker-compose.yml`
  (`127.0.0.1:<port>:443`) and the Public Hostname URL accordingly.
- **DNS errors (`argotunnel.com ... server misbehaving`)**: ensure cloudflared
  is on `network_mode: host` (already set here).
- **526/525 from Cloudflare**: origin TLS problem — confirm the Origin CA cert
  is present in `deploy/certs/`, the hostname matches, and SSL/TLS mode is
  **Full (strict)**.
