const http = require('http');
const https = require('https');
const http2 = require('http2');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream');

const PORT = 8080;
const PROXY_BASE = `http://127.0.0.1:${PORT}`;

// ─── Header lists ────────────────────────────────────────────────────────────

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer',
  'upgrade', 'proxy-authorization', 'proxy-authenticate',
  'origin', 'referer', 'accept-encoding',
  'if-none-match', 'if-modified-since', 'if-range',
]);

const STRIP_RESPONSE = new Set([
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
  'content-encoding', // we decompress manually
]);

// ─── URL helpers ─────────────────────────────────────────────────────────────

function enc(u) { return encodeURIComponent(u); }
function dec(s) { try { return decodeURIComponent(s); } catch { return s; } }

function resolve(base, rel) {
  try { return new URL(rel, base).href; } catch { return null; }
}

function rewriteUrl(u, base) {
  if (!u) return u;
  u = u.trim();
  if (
    u.startsWith('data:') || u.startsWith('blob:') ||
    u.startsWith('javascript:') || u.startsWith('#') ||
    u.startsWith('mailto:') || u.startsWith('tel:') ||
    u.startsWith(`${PROXY_BASE}/`)
  ) return u;
  const resolved = resolve(base, u);
  if (!resolved) return u;
  if (!resolved.startsWith('http://') && !resolved.startsWith('https://')) return u;
  return `${PROXY_BASE}/${enc(resolved)}`;
}

// ─── Content rewriting ───────────────────────────────────────────────────────

function rewriteHtml(html, base) {
  // rewrite attribute URLs
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
      return rewriteUrl(trimmed.slice(0, spaceIdx), base) + trimmed.slice(spaceIdx);
    }).join(', ');
    return `srcset=${q}${rewritten}${q}`;
  });

  // inline style url()
  html = html.replace(/url\((["']?)([^"')]+)\1\)/gi,
    (m, q, val) => `url(${q}${rewriteUrl(val, base)}${q})`
  );

  // meta refresh
  html = html.replace(
    /(<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][0-9]+;\s*url=)([^"'>]+)/gi,
    (m, pre, url) => `${pre}${rewriteUrl(url.trim(), base)}`
  );

  // inject runtime at very start of <head>
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
  // Only rewrite clearly standalone URL string literals
  // Match quoted strings that look exactly like full URLs
  // Avoid touching minified code patterns like function(){return"https://..."}
  return js.replace(
    /(["'`])(https?:\/\/(?!127\.0\.0\.1)[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]{8,})\1/g,
    (m, q, u) => {
      try {
        new URL(u);
        // skip if it looks like it's inside a larger expression (concatenated etc)
        return `${q}${rewriteUrl(u, base)}${q}`;
      } catch { return m; }
    }
  );
}

// ─── Runtime script injected into every HTML page ────────────────────────────

function buildRuntime(base) {
  // escape base for embedding in JS string
  const safeBase = base.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `<script>
(function(){
"use strict";
var P="${PROXY_BASE}";
var B="${safeBase}";

function rw(u){
  if(!u||typeof u!=="string") return u;
  u=u.trim();
  if(u.startsWith("data:")||u.startsWith("blob:")||u.startsWith("javascript:")||
     u.startsWith("#")||u.startsWith("mailto:")||u.startsWith("tel:")||
     u.startsWith(P+"/")) return u;
  try{
    var r=new URL(u,B).href;
    if(r.startsWith("http://")||r.startsWith("https://"))
      return P+"/"+encodeURIComponent(r);
  }catch(e){}
  return u;
}

// ── fetch ──
var _fetch=window.fetch.bind(window);
window.fetch=function(input,init){
  try{
    if(typeof input==="string") input=rw(input);
    else if(input instanceof Request){
      var rwu=rw(input.url);
      if(rwu!==input.url) input=new Request(rwu,input);
    }
  }catch(e){}
  return _fetch(input,init);
};

// ── XHR ──
var _open=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(method,url){
  try{ url=rw(url); }catch(e){}
  return _open.apply(this,[method,url].concat([].slice.call(arguments,2)));
};

// ── WebSocket ──
var _WS=window.WebSocket;
if(_WS){
  window.WebSocket=function(url,protocols){
    try{
      // convert ws(s):// to http proxy path then back — just let it fail gracefully
      // Most WS on Spotify/Discord can't be proxied this way, but at least don't crash
    }catch(e){}
    return protocols!==undefined ? new _WS(url,protocols) : new _WS(url);
  };
  window.WebSocket.prototype=_WS.prototype;
  window.WebSocket.CONNECTING=_WS.CONNECTING;
  window.WebSocket.OPEN=_WS.OPEN;
  window.WebSocket.CLOSING=_WS.CLOSING;
  window.WebSocket.CLOSED=_WS.CLOSED;
}

// ── window.open ──
var _winOpen=window.open;
window.open=function(u,t,f){
  try{ if(u&&u!=="about:blank") u=rw(u); }catch(e){}
  return _winOpen.call(this,u,t,f);
};

// ── history ──
var _push=history.pushState,_replace=history.replaceState;
history.pushState=function(s,t,u){
  try{ if(u) u=rw(u); }catch(e){}
  return _push.call(this,s,t,u);
};
history.replaceState=function(s,t,u){
  try{ if(u) u=rw(u); }catch(e){}
  return _replace.call(this,s,t,u);
};

// ── HTMLElement src/href setters ──
function patchAttr(proto,attr){
  var desc=Object.getOwnPropertyDescriptor(proto,attr);
  if(desc&&desc.set){
    Object.defineProperty(proto,attr,{
      set:function(v){ desc.set.call(this,rw(v)); },
      get:function(){ return desc.get.call(this); },
      configurable:true
    });
  }
}
patchAttr(HTMLImageElement.prototype,"src");
patchAttr(HTMLScriptElement.prototype,"src");
patchAttr(HTMLIFrameElement.prototype,"src");
patchAttr(HTMLAnchorElement.prototype,"href");
patchAttr(HTMLLinkElement.prototype,"href");
patchAttr(HTMLFormElement.prototype,"action");
patchAttr(HTMLVideoElement.prototype,"src");
patchAttr(HTMLAudioElement.prototype,"src");
patchAttr(HTMLSourceElement.prototype,"src");
patchAttr(HTMLTrackElement.prototype,"src");

// ── setAttribute ──
var _setAttr=Element.prototype.setAttribute;
Element.prototype.setAttribute=function(name,value){
  try{
    var n=name.toLowerCase();
    if((n==="src"||n==="href"||n==="action"||n==="data-src"||n==="poster")&&value)
      value=rw(value);
  }catch(e){}
  return _setAttr.call(this,name,value);
};

// ── ServiceWorker — block registration (breaks proxy) ──
if(navigator.serviceWorker){
  Object.defineProperty(navigator,"serviceWorker",{
    get:function(){
      return {
        register:function(){ return Promise.resolve({}); },
        getRegistrations:function(){ return Promise.resolve([]); },
        ready:Promise.resolve({})
      };
    }
  });
}

// ── link click intercept ──
document.addEventListener("click",function(e){
  var a=e.target.closest("a[href]");
  if(!a) return;
  var h=a.getAttribute("href");
  if(!h||h.startsWith("#")||h.startsWith("javascript:")) return;
  var rwh=rw(h);
  if(rwh!==h){ e.preventDefault(); location.href=rwh; }
},true);

// ── form submit intercept ──
document.addEventListener("submit",function(e){
  var f=e.target;
  if(f.action){ try{ f.action=rw(f.action); }catch(e){} }
},true);

// ── MutationObserver for dynamic DOM changes ──
var WATCH_ATTRS=["src","href","action","poster","data-src"];
var mo=new MutationObserver(function(mutations){
  for(var i=0;i<mutations.length;i++){
    var mut=mutations[i];
    if(mut.type==="attributes"){
      var el=mut.target;
      var attr=mut.attributeName;
      if(WATCH_ATTRS.indexOf(attr)!==-1){
        var v=el.getAttribute(attr);
        if(v){var rw2=rw(v);if(rw2!==v)el.setAttribute(attr,rw2);}
      }
    } else {
      for(var j=0;j<mut.addedNodes.length;j++){
        var n=mut.addedNodes[j];
        if(n.nodeType!==1) continue;
        var all=[n].concat(Array.prototype.slice.call(n.querySelectorAll?n.querySelectorAll("[src],[href],[action],[data-src],[poster]"):[]));
        for(var k=0;k<all.length;k++){
          var el2=all[k];
          WATCH_ATTRS.forEach(function(a){
            if(el2.hasAttribute&&el2.hasAttribute(a)){
              var v2=el2.getAttribute(a);
              if(v2){var rw3=rw(v2);if(rw3!==v2)el2.setAttribute(a,rw3);}
            }
          });
        }
      }
    }
  }
});
mo.observe(document.documentElement,{
  childList:true,subtree:true,
  attributes:true,attributeFilter:WATCH_ATTRS
});

})();
<\/script>`;
}

// ─── Decompression ───────────────────────────────────────────────────────────

function decompress(stream, encoding) {
  encoding = (encoding || '').toLowerCase().trim();
  if (encoding === 'gzip' || encoding === 'x-gzip') return stream.pipe(zlib.createGunzip());
  if (encoding === 'deflate') return stream.pipe(zlib.createInflate());
  if (encoding === 'br') return stream.pipe(zlib.createBrotliDecompress());
  return stream; // identity / no encoding
}

// ─── Response header cleaning ────────────────────────────────────────────────

function buildResponseHeaders(rawHeaders, targetUrl) {
  const headers = {};
  for (const [k, v] of Object.entries(rawHeaders)) {
    const kl = k.toLowerCase();
    if (kl.startsWith(':')) continue; // http2 pseudo-headers
    if (STRIP_RESPONSE.has(kl)) continue;
    headers[kl] = v;
  }
  headers['access-control-allow-origin'] = '*';
  headers['access-control-allow-credentials'] = 'true';
  headers['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, PATCH, OPTIONS';
  headers['access-control-allow-headers'] = '*';

  if (headers['location']) {
    try {
      const redirectUrl = new URL(headers['location'], targetUrl).href;
      headers['location'] = `${PROXY_BASE}/${enc(redirectUrl)}`;
    } catch {}
  }

  if (headers['set-cookie']) {
    const cookies = Array.isArray(headers['set-cookie'])
      ? headers['set-cookie'] : [headers['set-cookie']];
    headers['set-cookie'] = cookies.map(c =>
      c.replace(/;\s*domain=[^;]*/gi, '')
       .replace(/;\s*secure\b/gi, '')
       .replace(/;\s*samesite=[^;]*/gi, '')
       .replace(/;\s*partitioned\b/gi, '')
    );
  }

  return headers;
}

// ─── Request headers ─────────────────────────────────────────────────────────

function buildForwardHeaders(req, parsed) {
  const h = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) h[k] = v;
  }
  h['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  h['accept'] = h['accept'] || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';
  h['accept-language'] = 'en-US,en;q=0.9';
  h['accept-encoding'] = 'gzip, deflate, br'; // request compression — we'll decompress
  h['sec-ch-ua'] = '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"';
  h['sec-ch-ua-mobile'] = '?0';
  h['sec-ch-ua-platform'] = '"Windows"';
  h['sec-fetch-dest'] = h['sec-fetch-dest'] || 'document';
  h['sec-fetch-mode'] = h['sec-fetch-mode'] || 'navigate';
  h['sec-fetch-site'] = 'none';
  h['sec-fetch-user'] = '?1';
  h['upgrade-insecure-requests'] = '1';
  return h;
}

// ─── Body processing ─────────────────────────────────────────────────────────

function processBody(rawStream, encoding, contentType, targetUrl, resHeaders, statusCode, res) {
  const ct = (contentType || '').toLowerCase();
  const isHtml = ct.includes('text/html');
  const isCss  = ct.includes('text/css');
  const isJs   = ct.includes('javascript') || ct.includes('ecmascript');
  const needsRewrite = isHtml || isCss || isJs;

  const stream = decompress(rawStream, encoding);

  if (needsRewrite) {
    const chunks = [];
    stream.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on('end', () => {
      let body = Buffer.concat(chunks).toString('utf8');
      if (isHtml)     body = rewriteHtml(body, targetUrl);
      else if (isCss) body = rewriteCss(body, targetUrl);
      else if (isJs)  body = rewriteJs(body, targetUrl);
      const buf = Buffer.from(body, 'utf8');
      resHeaders['content-length'] = String(buf.length);
      delete resHeaders['transfer-encoding'];
      if (!res.headersSent) {
        res.writeHead(statusCode, resHeaders);
        res.end(buf);
      }
    });
    stream.on('error', err => {
      console.error(`  decompress/rewrite error: ${err.message}`);
      if (!res.headersSent) { res.writeHead(502); res.end('Rewrite error'); }
    });
  } else {
    if (!res.headersSent) res.writeHead(statusCode, resHeaders);
    stream.pipe(res);
    stream.on('error', err => console.error(`  stream error: ${err.message}`));
  }
}

// ─── HTTP/2 request ──────────────────────────────────────────────────────────

// Reuse sessions per origin — but validate they're still alive
const h2Pool = new Map();

function getH2Session(origin) {
  const existing = h2Pool.get(origin);
  if (existing && !existing.destroyed && !existing.closed) return existing;
  if (existing) { try { existing.destroy(); } catch {} }

  const session = http2.connect(origin, {
    rejectUnauthorized: false,
    settings: { initialWindowSize: 65535 * 4 },
  });
  session.on('error', () => { try { session.destroy(); } catch {} h2Pool.delete(origin); });
  session.on('close', () => h2Pool.delete(origin));
  session.on('goaway', () => { try { session.destroy(); } catch {} h2Pool.delete(origin); });
  h2Pool.set(origin, session);
  return session;
}

function doRequestH2(targetUrl, parsed, forwardHeaders, bodyBuffer, res) {
  return new Promise((resolve, reject) => {
    const origin = `https://${parsed.hostname}${parsed.port ? ':' + parsed.port : ''}`;

    let session;
    try { session = getH2Session(origin); } catch(e) { return reject(e); }

    const h2Headers = {
      [http2.constants.HTTP2_HEADER_METHOD]:    forwardHeaders['method'] || 'GET',
      [http2.constants.HTTP2_HEADER_PATH]:      parsed.pathname + parsed.search,
      [http2.constants.HTTP2_HEADER_SCHEME]:    'https',
      [http2.constants.HTTP2_HEADER_AUTHORITY]: parsed.hostname,
    };

    // copy forward headers, skip http1-only ones
    const skip = new Set(['host','connection','upgrade-insecure-requests','method']);
    for (const [k, v] of Object.entries(forwardHeaders)) {
      if (!skip.has(k.toLowerCase())) h2Headers[k] = v;
    }

    const timeout = setTimeout(() => {
      reject(new Error('h2 timeout'));
    }, 10000);

    let stream;
    try {
      stream = session.request(h2Headers);
    } catch(e) {
      clearTimeout(timeout);
      h2Pool.delete(origin);
      return reject(e);
    }

    stream.on('error', err => {
      clearTimeout(timeout);
      h2Pool.delete(origin);
      reject(err);
    });

    stream.on('response', headers => {
      clearTimeout(timeout);
      const status = headers[http2.constants.HTTP2_HEADER_STATUS];
      const encoding = headers['content-encoding'] || '';
      const contentType = headers['content-type'] || '';
      const resHeaders = buildResponseHeaders(headers, targetUrl);
      broadcast('response', `${status} ${targetUrl}`, { status, url: targetUrl, proto: 'h2', contentType });
      processBody(stream, encoding, contentType, targetUrl, resHeaders, status, res);
      resolve();
    });

    if (bodyBuffer && bodyBuffer.length) stream.end(bodyBuffer);
    else stream.end();
  });
}

// ─── HTTP/1.1 request ────────────────────────────────────────────────────────

const httpsAgent = new https.Agent({ keepAlive: false, rejectUnauthorized: false });
const httpAgent  = new http.Agent({ keepAlive: false });

function doRequestH1(targetUrl, parsed, forwardHeaders, bodyBuffer, res) {
  return new Promise((resolve, reject) => {
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;
    const agent = isHttps ? httpsAgent : httpAgent;

    const headers = { ...forwardHeaders };
    headers['host'] = parsed.hostname;
    headers['connection'] = 'close';
    delete headers['method'];
    if (bodyBuffer) headers['content-length'] = String(bodyBuffer.length);

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: forwardHeaders['method'] || 'GET',
      headers,
      agent,
      timeout: 20000,
    };

    const proxyReq = lib.request(options, proxyRes => {
      const encoding = proxyRes.headers['content-encoding'] || '';
      const contentType = proxyRes.headers['content-type'] || '';
      const resHeaders = buildResponseHeaders(proxyRes.headers, targetUrl);
      broadcast('response', `${proxyRes.statusCode} ${targetUrl}`, { status: proxyRes.statusCode, url: targetUrl, proto: 'h1', contentType });
      processBody(proxyRes, encoding, contentType, targetUrl, resHeaders, proxyRes.statusCode, res);
      resolve();
    });

    proxyReq.on('error', reject);
    proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('h1 timeout')); });

    if (bodyBuffer && bodyBuffer.length) proxyReq.end(bodyBuffer);
    else proxyReq.end();
  });
}

// ─── Main request dispatcher ─────────────────────────────────────────────────

async function doRequest(targetUrl, method, reqHeaders, bodyBuffer, res) {
  let parsed;
  try { parsed = new URL(targetUrl); }
  catch { if (!res.headersSent) { res.writeHead(400); res.end('Invalid URL'); } return; }

  broadcast('request', `${method} ${targetUrl}`, { method, url: targetUrl });

  const forwardHeaders = buildForwardHeaders({ headers: reqHeaders }, parsed);
  forwardHeaders['method'] = method;

  if (parsed.protocol === 'https:') {
    try {
      await doRequestH2(targetUrl, parsed, forwardHeaders, bodyBuffer, res);
      return;
    } catch (err) {
      console.warn(`h2 failed (${err.message}) → h1 — ${targetUrl}`);
    }
  }

  try {
    await doRequestH1(targetUrl, parsed, forwardHeaders, bodyBuffer, res);
  } catch (err) {
    console.error(`✗ ${err.message} — ${targetUrl}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`Proxy error: ${err.message}`);
    }
  }
}

// ─── Log broadcaster (SSE) ───────────────────────────────────────────────────

const logClients = new Set();
const logHistory = []; // keep last 200 entries for new connections
const MAX_HISTORY = 200;

function broadcast(type, message, extra) {
  const entry = { type, message, extra, ts: Date.now() };
  logHistory.push(entry);
  if (logHistory.length > MAX_HISTORY) logHistory.shift();
  const data = `data: ${JSON.stringify(entry)}\n\n`;
  for (const client of logClients) {
    try { client.write(data); } catch { logClients.delete(client); }
  }
}

// override console methods to also broadcast
const _log   = console.log.bind(console);
const _error = console.error.bind(console);
const _warn  = console.warn.bind(console);

console.log = (...args) => {
  _log(...args);
  broadcast('info', args.join(' '));
};
console.error = (...args) => {
  _error(...args);
  broadcast('error', args.join(' '));
};
console.warn = (...args) => {
  _warn(...args);
  broadcast('warn', args.join(' '));
};

// ─── HTTP server ─────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Serve static frontend files ──────────────────────────────────────────────
  const STATIC_FILES = {
    '/':            { file: 'index.html',  mime: 'text/html' },
    '/index.html':  { file: 'index.html',  mime: 'text/html' },
    '/app.js':      { file: 'app.js',      mime: 'application/javascript' },
    '/styles.css':  { file: 'styles.css',  mime: 'text/css' },
    '/loader.html': { file: 'loader.html', mime: 'text/html' },
  };
  const reqPath = req.url.split('?')[0]; // strip query string for static file lookup
  const staticEntry = STATIC_FILES[reqPath];
  if (staticEntry) {
    const filePath = path.join(__dirname, staticEntry.file);
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(`Failed to read ${staticEntry.file}: ${err.message}`);
        return;
      }
      res.writeHead(200, { 'content-type': staticEntry.mime });
      res.end(data);
    });
    return;
  }

  // SSE log stream
  if (req.url === '/__tachyon_log__') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'access-control-allow-origin': '*',
    });
    res.write('retry: 1000\n\n');
    // send history to new client
    for (const entry of logHistory) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }
    logClients.add(res);
    req.on('close', () => logClients.delete(res));
    return;
  }

  const targetUrl = dec(req.url.slice(1));

  if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
    return;
  }

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const bodyBuffer = chunks.length ? Buffer.concat(chunks) : null;
    doRequest(targetUrl, req.method, req.headers, bodyBuffer, res);
  });
  req.on('error', err => {
    console.error(`Request error: ${err.message}`);
    if (!res.headersSent) { res.writeHead(400); res.end(); }
  });
});

// ─── WebSocket proxy ─────────────────────────────────────────────────────────

server.on('upgrade', (req, socket, head) => {
  const targetUrl = dec(req.url.slice(1));
  let parsed;
  try { parsed = new URL(targetUrl); }
  catch { socket.destroy(); return; }

  const isHttps = parsed.protocol === 'https:' || parsed.protocol === 'wss:';
  const wsProto = isHttps ? 'wss' : 'ws';
  const wsTarget = `${wsProto}://${parsed.hostname}${parsed.port ? ':' + parsed.port : ''}${parsed.pathname}${parsed.search}`;

  console.log(`↑ WS ${wsTarget}`);

  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.pathname + parsed.search,
    headers: {
      ...req.headers,
      host: parsed.hostname,
    },
    rejectUnauthorized: false,
  };
  delete options.headers['origin'];

  const lib = isHttps ? https : http;
  const proxyReq = lib.request(options);
  proxyReq.on('upgrade', (proxyRes, proxySocket) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      Object.entries(proxyRes.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
      '\r\n\r\n'
    );
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
    proxySocket.on('error', () => socket.destroy());
    socket.on('error', () => proxySocket.destroy());
  });
  proxyReq.on('error', () => socket.destroy());
  proxyReq.end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Tachyon proxy running at http://127.0.0.1:${PORT}`);
});
