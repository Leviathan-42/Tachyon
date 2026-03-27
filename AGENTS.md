# Tachyon

A local web proxy that strips X-Frame-Options and CSP headers so blocked sites load in-page, and cloaks the URL using about:blank.

## How to test your changes

The app has two parts that must both be running to test:

1. **The proxy server** — `node proxy.js` (runs on port 8080)
2. **The frontend** — open `index.html` in a browser (or serve it)

### Testing workflow

Use the Playwright MCP to test your changes end-to-end:

1. Start the proxy server in the background with bash: `node proxy.js &`
2. Use `browser_navigate` to open `file:///home/levi/Tachyon/index.html`
3. Use `browser_snapshot` to read the accessibility tree and verify the UI loaded correctly
4. Use `browser_console_messages` to check for JavaScript errors
5. Test a proxy URL by navigating to `http://127.0.0.1:8080/<encoded-url>` and checking it loads
6. After testing, kill the proxy: `pkill -f "node proxy.js"`

### Checking for errors

- JavaScript errors in the frontend: use `browser_console_messages` after navigating
- Proxy errors: check stderr output from `node proxy.js`
- Network errors: use `browser_navigate` to a proxied URL and check if it responds

## Architecture

- `proxy.js` — Node.js HTTP proxy server on port 8080. Strips blocking headers, rewrites URLs, injects a runtime script.
- `index.html` — Launcher UI
- `app.js` — Frontend logic. Sends URLs through the proxy using either about:blank or inline iframe mode.
- `loader.html` — Opened as an about:blank tab, loads the proxied site in an iframe
- `styles.css` — Styles

## Key implementation details

- The proxy rewrites all URLs in HTML/CSS/JS responses to route through `http://127.0.0.1:8080/<encoded-url>`
- It injects `injected.js` (inline script) that patches `fetch`, `XMLHttpRequest`, `window.open`, and `history` so navigation stays proxied
- The about:blank mode opens `loader.html` via a data URI trick to bypass the browser's about:blank restriction
- WebSockets are proxied but may not work for all sites (Discord, Spotify)
