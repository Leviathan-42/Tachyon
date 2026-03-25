const http = require('http');
const https = require('https');
const http2 = require('http2');
const { Transform } = require('stream');

const PORT = 8080;
const PROXY_BASE = `http://127.0.0.1:${PORT}`;

// headers that must never be forwarded to the target
const HOP_BY_HOP = [
  'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer',
  'upgrade', 'proxy-authorization', 'proxy-authenticate',
  'origin', 'referer', 'accept-encoding',
  'if-none-match', 'if-modified-since', 'if-range',
];

// headers to strip from responses
const STRIP_RESPONSE = [
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'x-content-type-options',
  'strict-transport-security',
  'permissions-policy',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'transfer-encoding',
  'content-encoding',
];

function enc(u) { return encodeURIComponent(u); }
function dec(s) { try { return decodeURIComponent(s); } catch { return s; } }

function resolve(base, rel) {
  try { return new URL(rel, base).href; } catch { return rel; }
}

function rewriteUrl(u, base) {
  if (!u) return u;
  u = u.trim();
  if (
    u.startsWith('data:') || u.startsWith('blob:') ||
    u.startsWith('javascript:') || u.startsWith('#') ||
    u.startsWith(`${PROXY_BASE}/`)
  ) return u;
  try {
    const resolved = resolve(base, u);
    if (!resolved.startsWith('http://') && !resolved.startsWith('https://')) return u;
    return `${PROXY_BASE}/${enc(resolved)}`;
  } catch { return u; }
}

function rewriteHtml(html, base) {
  // attributes with urls
  html = html.replace(
    /((?:src|href|action|data-src|data-href|poster|background)=)(["'])([^"']*)\2/gi,
    (m, attr, q, val) => `${attr}${q}${rewriteUrl(val, base)}${q}`
  );

  // srcset
  html = html.replace(/srcset=(["'])([^"']+)\1/gi, (m, q, val) => {
    const rewritten = val.split(',').map(part => {
      const trimmed = part.trim();
      const spaceIdx = trimmed.search(/\s/);
      if (spaceIdx === -1) return rewriteUrl(trimmed, base);
      const u = trimmed.slice(0, spaceIdx);
      const descriptor = trimmed.slice(spaceIdx);
      return rewriteUrl(u, base) + descriptor;
    }).join(', ');
    return `srcset=${q}${rewritten}${q}`;
  });

  // inline style url()
  html = html.replace(/url\((["']?)([^"')]+)\1\)/gi,
    (m, q, val) => `url(${q}${rewriteUrl(val, base)}${q})`
  );

  // inject runtime before anything else in <head>
  const runtime = buildRuntime(base);
  if (/<head[\s>]/i.test(html)) {
    html = html.replace(/<head([\s>])/i, `<head$1>${runtime}`);
  } else {
    html = runtime + html;
  }

  return html;
}

function rewriteCss(css, base) {
  return css.replace(/url\((["']?)([^"')]+)\1\)/gi,
    (m, q, val) => `url(${q}${rewriteUrl(val, base)}${q})`
  );
}

function rewriteJs(js, base) {
  // rewrite string literals containing http(s) urls
  // skip already-proxied urls
  js = js.replace(/(["'`])(https?:\/\/(?!127\.0\.0\.1)[^"'`\s\\]{4,})(["'`])/g, (m, q1, u, q2) => {
    try {
      new URL(u);
      return `${q1}${rewriteUrl(u, base)}${q2}`;
    } catch { return m; }
  });
  return js;
}

function buildRuntime(base) {
  return `<script>
(function(){
  var P="${PROXY_BASE}";
  var base="${base}";

  function rewrite(u){
    if(!u||typeof u!=="string") return u;
    u=u.trim();
    if(u.startsWith("data:")||u.startsWith("blob:")||u.startsWith("javascript:")||u.startsWith("#")||u.startsWith(P+"/")) return u;
    try{
      var r=new URL(u,base).href;
      if(!r.startsWith("http://")&&!r.startsWith("https://")) return u;
      return P+"/"+encodeURIComponent(r);
    }catch(e){return u;}
  }

  // patch fetch
  var oFetch=window.fetch.bind(window);
  window.fetch=function(input,init){
    if(typeof input==="string") input=rewrite(input);
    else if(input&&input.url) input=new Request(rewrite(input.url),input);
    return oFetch(input,init);
  };

  // patch XHR
  var oOpen=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u){
    return oOpen.apply(this,[m,rewrite(u)].concat(Array.prototype.slice.call(arguments,2)));
  };

  // patch window.open
  var oWinOpen=window.open;
  window.open=function(u){
    return oWinOpen.apply(this,[rewrite(u)].concat(Array.prototype.slice.call(arguments,1)));
  };

  // patch history
  var oPS=history.pushState,oRS=history.replaceState;
  history.pushState=function(s,t,u){return oPS.call(this,s,t,u?rewrite(u):u);};
  history.replaceState=function(s,t,u){return oRS.call(this,s,t,u?rewrite(u):u);};

  // patch Image src
  var oImg=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,"src");
  if(oImg&&oImg.set){
    Object.defineProperty(HTMLImageElement.prototype,"src",{
      set:function(v){oImg.set.call(this,rewrite(v));},
      get:function(){return oImg.get.call(this);}
    });
  }

  // intercept link clicks
  document.addEventListener("click",function(e){
    var a=e.target.closest("a[href]");
    if(a){
      var h=a.getAttribute("href");
      if(h&&!h.startsWith("#")&&!h.startsWith("javascript:")){
        var rw=rewrite(h);
        if(rw!==h){e.preventDefault();location.href=rw;}
      }
    }
  },true);

  // intercept form submits
  document.addEventListener("submit",function(e){
    var f=e.target;
    if(f.action) f.action=rewrite(f.action);
  },true);

  // MutationObserver to rewrite dynamically added elements
  var mo=new MutationObserver(function(mutations){
    mutations.forEach(function(m){
      m.addedNodes.forEach(function(n){
        if(n.nodeType!==1) return;
        ["src","href","action","poster"].forEach(function(attr){
          if(n.hasAttribute&&n.hasAttribute(attr)){
            var v=n.getAttribute(attr);
            var rw=rewrite(v);
            if(rw!==v) n.setAttribute(attr,rw);
          }
        });
        // also check children
        var els=n.querySelectorAll&&n.querySelectorAll("[src],[href],[action]");
        if(els) els.forEach(function(el){
          ["src","href","action"].forEach(function(attr){
            if(el.hasAttribute(attr)){
              var v=el.getAttribute(attr);
              var rw=rewrite(v);
              if(rw!==v) el.setAttribute(attr,rw);
            }
          });
        });
      });
    });
  });
  mo.observe(document.documentElement,{childList:true,subtree:true});

})();
<\/script>`;
}

// shared https agent with keep-alive disabled to avoid socket reuse issues
const httpsAgent = new https.Agent({
  keepAlive: false,
  rejectUnauthorized: false, // needed for some sites with cert issues
  timeout: 20000,
});

const httpAgent = new http.Agent({
  keepAlive: false,
  timeout: 20000,
});


function buildForwardHeaders(req, parsed) {
  const forwardHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.includes(k.toLowerCase())) {
      forwardHeaders[k] = v;
    }
  }
  forwardHeaders['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  forwardHeaders['accept'] = forwardHeaders['accept'] || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';
  forwardHeaders['accept-language'] = 'en-US,en;q=0.9';
  forwardHeaders['sec-ch-ua'] = '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"';
  forwardHeaders['sec-ch-ua-mobile'] = '?0';
  forwardHeaders['sec-ch-ua-platform'] = '"Windows"';
  forwardHeaders['sec-fetch-dest'] = forwardHeaders['sec-fetch-dest'] || 'document';
  forwardHeaders['sec-fetch-mode'] = forwardHeaders['sec-fetch-mode'] || 'navigate';
  forwardHeaders['sec-fetch-site'] = 'none';
  forwardHeaders['sec-fetch-user'] = '?1';
  forwardHeaders['upgrade-insecure-requests'] = '1';
  return forwardHeaders;
}

function handleResponseBody(proxyRes, resHeaders, statusCode, targetUrl, res) {
  const contentType = (resHeaders['content-type'] || '').toLowerCase();
  const isHtml = contentType.includes('text/html');
  const isCss = contentType.includes('text/css');
  const isJs = contentType.includes('javascript') || contentType.includes('ecmascript');

  if (isHtml || isCss || isJs) {
    const chunks = [];
    proxyRes.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    proxyRes.on('end', () => {
      let body = Buffer.concat(chunks).toString('utf8');
      if (isHtml) body = rewriteHtml(body, targetUrl);
      else if (isCss) body = rewriteCss(body, targetUrl);
      else if (isJs) body = rewriteJs(body, targetUrl);
      const buf = Buffer.from(body, 'utf8');
      resHeaders['content-length'] = buf.length.toString();
      delete resHeaders['transfer-encoding'];
      if (!res.headersSent) {
        res.writeHead(statusCode, resHeaders);
        res.end(buf);
      }
    });
    proxyRes.on('error', err => {
      console.error(`Stream error: ${err.message}`);
      if (!res.headersSent) { res.writeHead(502); res.end('Stream error'); }
    });
  } else {
    if (!res.headersSent) res.writeHead(statusCode, resHeaders);
    proxyRes.pipe(res);
    proxyRes.on('error', err => console.error(`Stream error: ${err.message}`));
  }
}

function buildResponseHeaders(rawHeaders, targetUrl) {
  const headers = {};
  for (const [k, v] of Object.entries(rawHeaders)) {
    if (k.startsWith(':')) continue; // skip http2 pseudo-headers
    if (!STRIP_RESPONSE.includes(k.toLowerCase())) headers[k] = v;
  }
  headers['access-control-allow-origin'] = '*';
  headers['access-control-allow-credentials'] = 'true';
  if (headers['location']) {
    try {
      const redirectUrl = new URL(headers['location'], targetUrl).href;
      headers['location'] = `${PROXY_BASE}/${enc(redirectUrl)}`;
    } catch {}
  }
  if (headers['set-cookie']) {
    const cookies = Array.isArray(headers['set-cookie']) ? headers['set-cookie'] : [headers['set-cookie']];
    headers['set-cookie'] = cookies.map(c =>
      c.replace(/;\s*domain=[^;]*/gi, '')
       .replace(/;\s*secure/gi, '')
       .replace(/;\s*samesite=[^;]*/gi, '')
       .replace(/;\s*partitioned/gi, '')
    );
  }
  return headers;
}

function doRequestH2(targetUrl, parsed, req, res, bodyBuffer) {
  return new Promise((resolve, reject) => {
    const origin = `${parsed.protocol}//${parsed.hostname}${parsed.port ? ':' + parsed.port : ''}`;

    // connect fresh every time — no session caching, avoids stale session hangs
    const session = http2.connect(origin, { rejectUnauthorized: false });

    const cleanup = () => { try { session.destroy(); } catch {} };

    // if connection itself never succeeds, reject quickly
    const connectTimeout = setTimeout(() => {
      cleanup();
      reject(new Error('h2 connect timeout'));
    }, 5000);

    session.on('error', err => {
      clearTimeout(connectTimeout);
      cleanup();
      reject(err);
    });

    session.on('connect', () => {
      clearTimeout(connectTimeout);

      const forwardHeaders = buildForwardHeaders(req, parsed);
      const h2Headers = {
        [http2.constants.HTTP2_HEADER_METHOD]: req.method,
        [http2.constants.HTTP2_HEADER_PATH]: parsed.pathname + parsed.search,
        [http2.constants.HTTP2_HEADER_SCHEME]: 'https',
        [http2.constants.HTTP2_HEADER_AUTHORITY]: parsed.hostname,
        ...forwardHeaders,
      };
      delete h2Headers['host'];
      delete h2Headers['connection'];

      const stream = session.request(h2Headers);
      stream.setTimeout(15000, () => { cleanup(); reject(new Error('h2 stream timeout')); });
      stream.on('error', err => { cleanup(); reject(err); });

      stream.on('response', (headers) => {
        const status = headers[http2.constants.HTTP2_HEADER_STATUS];
        const resHeaders = buildResponseHeaders(headers, targetUrl);
        handleResponseBody(stream, resHeaders, status, targetUrl, res);
        stream.on('end', () => cleanup());
        resolve();
      });

      if (bodyBuffer && bodyBuffer.length) {
        stream.end(bodyBuffer);
      } else {
        stream.end();
      }
    });
  });
}

function doRequestH1(targetUrl, parsed, req, res, bodyBuffer) {
  return new Promise((resolve, reject) => {
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;
    const agent = isHttps ? httpsAgent : httpAgent;

    const forwardHeaders = buildForwardHeaders(req, parsed);
    forwardHeaders['host'] = parsed.hostname;
    forwardHeaders['connection'] = 'close';
    if (bodyBuffer) forwardHeaders['content-length'] = bodyBuffer.length.toString();

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: req.method,
      headers: forwardHeaders,
      agent,
      timeout: 20000,
    };

    const proxyReq = lib.request(options, (proxyRes) => {
      const resHeaders = buildResponseHeaders(proxyRes.headers, targetUrl);
      handleResponseBody(proxyRes, resHeaders, proxyRes.statusCode, targetUrl, res);
      resolve();
    });

    proxyReq.on('error', reject);
    proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('timeout')); });

    if (bodyBuffer) {
      proxyReq.end(bodyBuffer);
    } else {
      proxyReq.end();
    }
  });
}

async function doRequest(targetUrl, req, res, bodyBuffer) {
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    if (!res.headersSent) { res.writeHead(400); res.end('Invalid URL'); }
    return;
  }

  console.log(`→ ${req.method} ${targetUrl}`);

  // try HTTP/2 first for https, fall back to HTTP/1.1
  if (parsed.protocol === 'https:') {
    try {
      await doRequestH2(targetUrl, parsed, req, res, bodyBuffer);
      return;
    } catch (err) {
      console.log(`  h2 failed (${err.message}), falling back to h1...`);
    }
  }

  try {
    await doRequestH1(targetUrl, parsed, req, res, bodyBuffer);
  } catch (err) {
    console.error(`✗ ${err.message} — ${targetUrl}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`Proxy error: ${err.message}`);
    }
  }
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/' || req.url === '') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<h2>Tachyon proxy running</h2>');
    return;
  }

  let targetUrl = dec(req.url.slice(1));

  if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('Bad request: expected http(s) url');
    return;
  }

  // buffer request body so it can be replayed on h1 fallback
  const bodyChunks = [];
  req.on('data', chunk => bodyChunks.push(chunk));
  req.on('end', () => {
    const bodyBuffer = bodyChunks.length ? Buffer.concat(bodyChunks) : null;
    doRequest(targetUrl, req, res, bodyBuffer);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Tachyon proxy running at http://127.0.0.1:${PORT}`);
});
