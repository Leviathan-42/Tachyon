# Tachyon

A local web proxy and launcher. Strips `X-Frame-Options` and CSP headers so blocked sites can load in-page, and cloaks the URL using `about:blank`.

Named after tachyons — hypothetical particles that travel faster than light. Faster than Lightspeed.

---

## How It Works

Tachyon runs a local Node.js proxy server on `127.0.0.1:8080`. When you open a site through the launcher:

1. The browser requests the page from the local proxy instead of directly
2. The proxy fetches the real site on your behalf
3. It strips headers that block embedding (`X-Frame-Options`, `Content-Security-Policy`, etc.)
4. It rewrites all URLs in HTML, CSS, and JS to route through the proxy
5. It injects a runtime script that patches `fetch`, `XHR`, `window.open`, and history so all subsequent requests stay proxied
6. The page loads in an `about:blank` tab or inline iframe

Since the proxy makes the outbound requests (not the browser), browser-level filtering tools only see traffic to `127.0.0.1`.

---

## Requirements

- [Node.js](https://nodejs.org) (v18 or later)
- A network connection that isn't filtered at the network level (hotspot works)

---

## Setup

```powershell
git clone https://github.com/Leviathan-42/Tachyon
cd Tachyon
npm start
```

Then open `http://127.0.0.1:8080/` in your browser. The proxy status indicator at the top will turn green when the proxy is running.

---

## Usage

- Click a site card to open it
- Use the URL bar to enter any custom URL
- Toggle between **New tab (about:blank)** and **Inline** view modes
- The proxy must be running (`npm start`) for sites to load

---

## File Structure

```
index.html   — launcher UI
styles.css   — styles
app.js       — launcher logic, routes clicks through proxy
loader.html  — opened as about:blank tab, loads the proxied site in an iframe
proxy.js     — local Node.js proxy server
package.json — npm start script
```

---

## Docker / Cloudflare Tunnel

A `docker-compose.yml` is included for running Tachyon behind a Cloudflare Tunnel so it is accessible outside the local machine.

**Prerequisites:** a Cloudflare Tunnel already created via `cloudflared tunnel create <name>`.

1. Copy your tunnel credentials JSON to the project root:
   ```
   cp ~/.cloudflared/<tunnel-uuid>.json ./tunnel-credentials.json
   ```
2. Update the tunnel UUID in `docker-compose.yml` (the `run <uuid>` argument in the `command` field).
3. Start both services:
   ```
   docker compose up -d
   ```

`tunnel-credentials.json` is gitignored — never commit it.

---

## Limitations

- Complex single page apps (Spotify, Discord) may not work fully due to WebSocket and service worker requirements
- Sites that use HTTP/2 server push won't benefit from proxying
- WebSockets are not proxied — features relying on them may break
- Only works on the local machine — not a shared server (unless using the Cloudflare Tunnel setup above)
