const http = require('http');
const https = require('https');
const url = require('url');

const PORT = 8080;

// headers to strip from responses so iframes work
const BLOCKED_HEADERS = [
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'x-content-type-options',
];

function rewriteUrls(body, baseUrl, proxyBase) {
  const base = new URL(baseUrl);
  const origin = base.origin;

  // rewrite absolute urls pointing to the same origin
  body = body.replace(/https?:\/\/[^\s"'`)]+/g, (match) => {
    try {
      new URL(match); // valid url
      return `${proxyBase}${encodeURIComponent(match)}`;
    } catch {
      return match;
    }
  });

  return body;
}

const server = http.createServer((req, res) => {
  // serve CORS headers so the browser doesn't block localhost responses
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // root request — serve a simple status page
  if (req.url === '/' || req.url === '') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<h2>Tachyon Proxy running on port ' + PORT + '</h2>');
    return;
  }

  // expected format: /https%3A%2F%2Fyoutube.com or /https://youtube.com
  let targetUrl = req.url.slice(1); // strip leading /
  try {
    targetUrl = decodeURIComponent(targetUrl);
  } catch {
    // already decoded
  }

  // make sure it's a valid url
  if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('Bad request: URL must start with http:// or https://');
    return;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
  } catch (e) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('Bad request: invalid URL');
    return;
  }

  const isHttps = parsedUrl.protocol === 'https:';
  const lib = isHttps ? https : http;

  const options = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (isHttps ? 443 : 80),
    path: parsedUrl.pathname + parsedUrl.search,
    method: req.method,
    headers: {
      ...req.headers,
      host: parsedUrl.hostname, // important: set correct host header
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  };

  // don't forward these headers to the target
  delete options.headers['origin'];
  delete options.headers['referer'];
  delete options.headers['accept-encoding']; // prevent compressed responses we can't decode

  const proxyReq = lib.request(options, (proxyRes) => {
    // strip headers that block iframes
    const headers = { ...proxyRes.headers };
    for (const h of BLOCKED_HEADERS) {
      delete headers[h];
    }

    // handle redirects — rewrite location header to go through proxy
    if (headers['location']) {
      try {
        const redirectUrl = new URL(headers['location'], targetUrl).href;
        headers['location'] = `http://localhost:${PORT}/${encodeURIComponent(redirectUrl)}`;
      } catch {
        // leave as is
      }
    }

    const contentType = (headers['content-type'] || '').toLowerCase();
    const isHtml = contentType.includes('text/html');

    res.writeHead(proxyRes.statusCode, headers);

    if (isHtml) {
      // collect full body to rewrite urls
      let body = '';
      proxyRes.setEncoding('utf8');
      proxyRes.on('data', chunk => body += chunk);
      proxyRes.on('end', () => {
        const proxyBase = `http://localhost:${PORT}/`;
        // rewrite relative links to go through proxy
        body = body
          .replace(/(href|src|action)="\/([^"]*?)"/g, `$1="${proxyBase}${encodeURIComponent(parsedUrl.origin + '/')}$2"`)
          .replace(/(href|src|action)='\/([^']*?)'/g, `$1='${proxyBase}${encodeURIComponent(parsedUrl.origin + '/')}$2'`);
        res.end(body);
      });
    } else {
      // stream everything else directly
      proxyRes.pipe(res);
    }
  });

  proxyReq.on('error', (e) => {
    console.error('Proxy error:', e.message);
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('Proxy error: ' + e.message);
  });

  // pipe request body (for POST etc)
  req.pipe(proxyReq);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Tachyon proxy running at http://127.0.0.1:${PORT}`);
  console.log(`Usage: http://127.0.0.1:${PORT}/https://youtube.com`);
});
