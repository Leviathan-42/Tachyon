const http = require('http');
const https = require('https');
const PORT = 8080;
const PROXY_BASE = `http://127.0.0.1:${PORT}`;

// headers to strip from responses
const STRIP_HEADERS = [
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'x-content-type-options',
  'strict-transport-security',
  'permissions-policy',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
];

// encode a url for use as a proxy path
function enc(u) {
  return encodeURIComponent(u);
}

// decode a proxy path back to a url
function dec(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// resolve a url relative to a base
function resolve(base, rel) {
  try {
    return new URL(rel, base).href;
  } catch {
    return rel;
  }
}

// rewrite a url to go through the proxy
function rewriteUrl(u, base) {
  if (!u || u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('javascript:') || u.startsWith('#')) return u;
  try {
    const resolved = resolve(base, u);
    if (!resolved.startsWith('http://') && !resolved.startsWith('https://')) return u;
    return `${PROXY_BASE}/${enc(resolved)}`;
  } catch {
    return u;
  }
}

// rewrite all urls in html
function rewriteHtml(html, base) {
  // src and href attributes
  html = html.replace(/(src|href|action|data-src|data-href)=["']([^"']+)["']/gi, (match, attr, val) => {
    return `${attr}="${rewriteUrl(val, base)}"`;
  });

  // srcset attributes
  html = html.replace(/srcset=["']([^"']+)["']/gi, (match, val) => {
    const rewritten = val.split(',').map(part => {
      const [url, size] = part.trim().split(/\s+/);
      return size ? `${rewriteUrl(url, base)} ${size}` : rewriteUrl(url, base);
    }).join(', ');
    return `srcset="${rewritten}"`;
  });

  // inline style url()
  html = html.replace(/url\(["']?([^"')]+)["']?\)/gi, (match, val) => {
    return `url("${rewriteUrl(val, base)}")`;
  });

  // meta refresh
  html = html.replace(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["']([^"']+)["']/gi, (match, val) => {
    return match.replace(val, val.replace(/url=(.+)/i, (m, u) => `url=${rewriteUrl(u, base)}`));
  });

  // inject our runtime script right after <head> opens
  const runtime = `<script>
(function() {
  const PROXY = "${PROXY_BASE}";
  function enc(u) { return encodeURIComponent(u); }
  function rewrite(u) {
    if (!u || u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('javascript:') || u.startsWith('#') || u.startsWith(PROXY)) return u;
    try {
      const resolved = new URL(u, window.__tachyon_base || location.href).href;
      if (!resolved.startsWith('http://') && !resolved.startsWith('https://')) return u;
      return PROXY + '/' + enc(resolved);
    } catch { return u; }
  }

  // store the real origin base for relative url resolution
  window.__tachyon_base = "${base}";

  // patch fetch
  const _fetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === 'string') input = rewrite(input);
    else if (input instanceof Request) input = new Request(rewrite(input.url), input);
    return _fetch.call(this, input, init);
  };

  // patch XMLHttpRequest
  const _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    return _open.call(this, method, rewrite(url), ...rest);
  };

  // patch WebSocket
  const _WS = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    // cant proxy websockets without a ws server, just let them fail silently
    try { return new _WS(url, protocols); } catch(e) { console.warn('WebSocket blocked:', url); }
  };
  window.WebSocket.prototype = _WS.prototype;

  // patch window.open
  const _open2 = window.open;
  window.open = function(url, ...rest) {
    return _open2.call(this, rewrite(url), ...rest);
  };

  // patch history pushState/replaceState so navigation stays proxied
  const _push = history.pushState;
  const _replace = history.replaceState;
  history.pushState = function(state, title, url) {
    return _push.call(this, state, title, url ? rewrite(url) : url);
  };
  history.replaceState = function(state, title, url) {
    return _replace.call(this, state, title, url ? rewrite(url) : url);
  };

  // intercept all link clicks and form submits
  document.addEventListener('click', function(e) {
    const a = e.target.closest('a[href]');
    if (a) {
      const href = a.getAttribute('href');
      if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
        e.preventDefault();
        location.href = rewrite(href);
      }
    }
  }, true);

  document.addEventListener('submit', function(e) {
    const form = e.target;
    if (form.action) {
      form.action = rewrite(form.action);
    }
  }, true);
})();
<\/script>`;

  // inject after <head> or at the very start
  if (html.includes('<head>')) {
    html = html.replace('<head>', '<head>' + runtime);
  } else if (html.includes('<html>')) {
    html = html.replace('<html>', '<html>' + runtime);
  } else {
    html = runtime + html;
  }

  return html;
}

// rewrite all urls in css
function rewriteCss(css, base) {
  return css.replace(/url\(["']?([^"')]+)["']?\)/gi, (match, val) => {
    return `url("${rewriteUrl(val, base)}")`;
  });
}

// rewrite import statements and fetch calls in js (basic, not a full ast rewrite)
function rewriteJs(js, base) {
  const proxy = PROXY_BASE;
  // wrap in a self-executing scope that patches fetch/XHR
  // for js files we just rewrite obvious string urls
  js = js.replace(/(["'`])(https?:\/\/[^"'`\s]+)(["'`])/g, (match, q1, url, q2) => {
    return `${q1}${rewriteUrl(url, base)}${q2}`;
  });
  return js;
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // status page
  if (req.url === '/' || req.url === '') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<h2>Tachyon proxy running on port ' + PORT + '</h2>');
    return;
  }

  // decode target url from path
  let targetUrl = dec(req.url.slice(1));
  console.log(`→ ${req.method} ${targetUrl}`);

  if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('Bad request');
    return;
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('Invalid URL');
    return;
  }

  const isHttps = parsed.protocol === 'https:';
  const lib = isHttps ? https : http;

  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: req.method,
    headers: {
      ...req.headers,
      host: parsed.hostname,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
    timeout: 15000,
  };

  delete options.headers['origin'];
  delete options.headers['referer'];
  delete options.headers['accept-encoding'];
  delete options.headers['if-none-match'];
  delete options.headers['if-modified-since'];

  const proxyReq = lib.request(options, (proxyRes) => {
    const headers = { ...proxyRes.headers };

    // strip blocking headers
    for (const h of STRIP_HEADERS) delete headers[h];

    // rewrite location header on redirects
    if (headers['location']) {
      try {
        const redirectUrl = new URL(headers['location'], targetUrl).href;
        headers['location'] = `${PROXY_BASE}/${enc(redirectUrl)}`;
      } catch {}
    }

    // fix cookies — strip domain/secure so they work on localhost
    if (headers['set-cookie']) {
      headers['set-cookie'] = (Array.isArray(headers['set-cookie']) ? headers['set-cookie'] : [headers['set-cookie']])
        .map(c => c
          .replace(/;\s*domain=[^;]*/gi, '')
          .replace(/;\s*secure/gi, '')
          .replace(/;\s*samesite=[^;]*/gi, '')
        );
    }

    const contentType = (headers['content-type'] || '').toLowerCase();
    const isHtml = contentType.includes('text/html');
    const isCss = contentType.includes('text/css');
    const isJs = contentType.includes('javascript');

    if (isHtml || isCss || isJs) {
      // buffer the full body to rewrite it
      let body = '';
      proxyRes.setEncoding('utf8');
      proxyRes.on('data', chunk => body += chunk);
      proxyRes.on('end', () => {
        if (isHtml) body = rewriteHtml(body, targetUrl);
        else if (isCss) body = rewriteCss(body, targetUrl);
        else if (isJs) body = rewriteJs(body, targetUrl);

        headers['content-length'] = Buffer.byteLength(body, 'utf8').toString();
        res.writeHead(proxyRes.statusCode, headers);
        res.end(body);
      });
    } else {
      // stream binary content (images, fonts, video, etc.) directly
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
    }
  });

  proxyReq.on('error', (e) => {
    console.error(`✗ ${targetUrl} — ${e.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('Proxy error: ' + e.message);
    }
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (!res.headersSent) {
      res.writeHead(504, { 'content-type': 'text/plain' });
      res.end('Gateway timeout');
    }
  });

  req.pipe(proxyReq);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Tachyon proxy running at http://127.0.0.1:${PORT}`);
  console.log(`Usage: http://127.0.0.1:${PORT}/${enc('https://youtube.com')}`);
});
