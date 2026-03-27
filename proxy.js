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
  // Strip alt-svc to prevent Chrome from upgrading video requests to HTTP/3
  // (QUIC) directly, which would bypass the proxy and cause ERR_ALPN_NEGOTIATION_FAILED.
  'alt-svc',
  // NOTE: content-encoding is NOT stripped here anymore — we only decompress
  // text content (HTML/CSS/JS). Binary content (video/audio/images) is passed
  // through as-is with original encoding and content-length intact.
]);

// Content types that need text rewriting (decompress + rewrite)
function needsTextRewrite(ct) {
  return ct.includes('text/html') || ct.includes('text/css') ||
    ct.includes('javascript') || ct.includes('ecmascript');
}

// Content types that should be piped through without decompression
// Video/audio need range request support; decompressing breaks content-length
function isBinaryPassthrough(ct) {
  return ct.startsWith('video/') || ct.startsWith('audio/') ||
    ct.startsWith('image/') || ct.includes('application/vnd.yt-ump') ||
    ct.includes('application/octet-stream') || ct.includes('font/') ||
    ct.startsWith('application/wasm');
}

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

// ─── Worker runtime — injected as preamble into proxied worker scripts ───────

// Returns the JS preamble string (NOT wrapped in <script>) to inject into workers.
// Workers use `self` instead of `window`, and have no DOM APIs.
function buildWorkerRuntime(base) {
  const safeBase = base.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `
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

// ── fetch (worker) ──
var _fetch=(typeof self!=="undefined"?self:globalThis).fetch;
if(_fetch){
  var _fetchBound=_fetch.bind(typeof self!=="undefined"?self:globalThis);
  (typeof self!=="undefined"?self:globalThis).fetch=function(input,init){
    try{
      if(typeof input==="string"){
        input=rw(input);
      } else if(input&&typeof input.url==="string"){
        var rwu=rw(input.url);
        if(rwu!==input.url){
          init=Object.assign({
            method:input.method,
            headers:input.headers,
            body:input.body,
            mode:input.mode,
            credentials:input.credentials,
            cache:input.cache,
            redirect:input.redirect,
            referrer:input.referrer,
            referrerPolicy:input.referrerPolicy,
            integrity:input.integrity,
          },init||{});
          delete init.keepalive;
          input=rwu;
        }
      }
    }catch(e){}
    try{
      var tUrl=typeof input==="string"?input:(input&&input.url?input.url:"");
      if(tUrl.startsWith(P+"/")){
        if(init&&init.keepalive){ init=Object.assign({},init); delete init.keepalive; }
      }
    }catch(e){}
    return _fetchBound(input,init);
  };
}

// ── XHR (worker) ──
if(typeof XMLHttpRequest!=="undefined"){
  var _open=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(method,url){
    try{ url=rw(url); }catch(e){}
    return _open.apply(this,[method,url].concat([].slice.call(arguments,2)));
  };
}

})();
`;
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
// Chrome enforces HTTP/2 for keepalive fetch requests to localhost, which our
// HTTP/1.1 proxy can't handle (ERR_ALPN_NEGOTIATION_FAILED). We strip
// keepalive and proxy all URLs through this server.
var _fetch=window.fetch.bind(window);
window.fetch=function(input,init){
  try{
    if(typeof input==="string"){
      input=rw(input);
    } else if(input instanceof Request){
      var rwu=rw(input.url);
      // Always replace URL if it needs proxying, even if body read fails.
      // Use a string URL + merged init so we don't have to clone the body.
      if(rwu!==input.url){
        // Merge the Request's properties into init so the body stream is
        // consumed only once. If init already has these, it takes precedence.
        init=Object.assign({
          method:input.method,
          headers:input.headers,
          body:input.body,
          mode:input.mode,
          credentials:input.credentials,
          cache:input.cache,
          redirect:input.redirect,
          referrer:input.referrer,
          referrerPolicy:input.referrerPolicy,
          integrity:input.integrity,
          // keepalive intentionally omitted to prevent Chrome H2 enforcement
        },init||{});
        delete init.keepalive;
        input=rwu; // use plain string now that init carries all options
      }
    }
  }catch(e){}
  // Strip keepalive from init when URL goes through the proxy
  try{
    var tUrl=typeof input==="string"?input:(input&&input.url?input.url:"");
    if(tUrl.startsWith(P+"/")){
      if(init&&init.keepalive){
        init=Object.assign({},init);
        delete init.keepalive;
      }
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

// ── sendBeacon ──
// YouTube player uses navigator.sendBeacon for QoE stats. Without proxying,
// these go directly to www.youtube.com and return 400 (wrong origin/no cookies).
var _sendBeacon=navigator.sendBeacon.bind(navigator);
navigator.sendBeacon=function(url,data){
  try{ url=rw(url); }catch(e){}
  return _sendBeacon(url,data);
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

// ── Worker patching — inject URL rewriting into web workers ──
// YouTube's SABR video downloader runs in a dedicated worker.
// We route the worker script through /__tachyon_worker__?url=... which
// prepends fetch/XHR proxy patching code before the original worker script,
// so all network requests from the worker are proxied.
(function(){
  var _Worker=window.Worker;
  if(!_Worker) return;
  window.Worker=function(url,opts){
    try{
      var rwu=rw(url);
      // Route through worker wrapper endpoint that injects proxy patching preamble
      url=P+"/__tachyon_worker__?url="+encodeURIComponent(rwu)+"&base="+encodeURIComponent(B);
    }catch(e){ try{ url=rw(url); }catch(e2){} }
    return new _Worker(url,opts);
  };
  window.Worker.prototype=_Worker.prototype;
})();

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
    const kl = k.toLowerCase();
    if (!HOP_BY_HOP.has(kl)) h[kl] = v;
  }
  h['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  h['accept'] = h['accept'] || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';
  h['accept-language'] = 'en-US,en;q=0.9';
  h['accept-encoding'] = 'gzip, deflate, br'; // request compression — we'll decompress text
  h['sec-ch-ua'] = '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"';
  h['sec-ch-ua-mobile'] = '?0';
  h['sec-ch-ua-platform'] = '"Windows"';
  // Don't override sec-fetch-* if the client already sent them (e.g. video/xhr requests)
  h['sec-fetch-dest'] = h['sec-fetch-dest'] || 'document';
  h['sec-fetch-mode'] = h['sec-fetch-mode'] || 'navigate';
  // sec-fetch-site: use 'cross-site' since requests from the proxy origin to
  // third-party hosts are cross-site. 'none' was incorrect and may cause 403s.
  h['sec-fetch-site'] = h['sec-fetch-site'] || 'cross-site';
  h['upgrade-insecure-requests'] = '1';
  // sec-fetch-user only valid for navigations triggered by user activation
  if (h['sec-fetch-mode'] === 'navigate') h['sec-fetch-user'] = '?1';
  else delete h['sec-fetch-user'];
  return h;
}

// ─── Body processing ─────────────────────────────────────────────────────────

function processBody(rawStream, encoding, contentType, targetUrl, resHeaders, statusCode, res) {
  const ct = (contentType || '').toLowerCase();
  const isHtml = ct.includes('text/html');
  const isCss  = ct.includes('text/css');
  const isJs   = ct.includes('javascript') || ct.includes('ecmascript');
  const textRewrite = isHtml || isCss || isJs;
  const binaryPassthrough = isBinaryPassthrough(ct);

  if (binaryPassthrough) {
    // Pass binary content (video/audio/images) through without decompression.
    // This preserves content-encoding and content-length, allowing range requests
    // and streaming to work correctly with YouTube's video delivery.
    if (!res.headersSent) res.writeHead(statusCode, resHeaders);
    rawStream.pipe(res);
    rawStream.on('error', err => console.error(`  binary stream error: ${err.message}`));
    return;
  }

  // Decompress text content for rewriting
  const stream = decompress(rawStream, encoding);

  if (textRewrite) {
    const chunks = [];
    stream.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on('end', () => {
      let body = Buffer.concat(chunks).toString('utf8');
      if (isHtml)     body = rewriteHtml(body, targetUrl);
      else if (isCss) body = rewriteCss(body, targetUrl);
      else if (isJs)  body = rewriteJs(body, targetUrl);
      const buf = Buffer.from(body, 'utf8');
      // Strip content-encoding since we decompressed, set correct length
      delete resHeaders['content-encoding'];
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
    // Non-binary, non-text-rewrite content (JSON, XML, etc.): decompress and stream.
    // Must delete content-length since decompressed size differs from compressed size,
    // and delete content-encoding since we've already decompressed.
    delete resHeaders['content-encoding'];
    delete resHeaders['content-length']; // size unknown after decompression
    if (!res.headersSent) res.writeHead(statusCode, resHeaders);
    stream.pipe(res);
    stream.on('error', err => console.error(`  stream error: ${err.message}`));
  }
}

// ─── HTTP/2 request ──────────────────────────────────────────────────────────

// Reuse sessions per origin — but validate they're still alive.
// Sessions are not shared across requests to CDN hostnames that use many IPs
// (like rr*.googlevideo.com) because a session tied to one IP may fail for
// a different resource path on the same logical hostname.
const h2Pool = new Map();

function getH2Session(origin) {
  const existing = h2Pool.get(origin);
  // Check .destroyed AND that the session hasn't received GOAWAY
  if (existing && !existing.destroyed && !existing.closed) return existing;
  if (existing) { try { existing.destroy(); } catch {} h2Pool.delete(origin); }

  const session = http2.connect(origin, {
    rejectUnauthorized: false,
    settings: { initialWindowSize: 65535 * 16 },
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
      // Don't evict the pool entry on timeout — the session may still be alive
      reject(new Error('h2 timeout'));
    }, 15000);

    let stream;
    try {
      stream = session.request(h2Headers);
    } catch(e) {
      clearTimeout(timeout);
      // Session failed to open a stream — evict so a fresh session is created next time
      h2Pool.delete(origin);
      try { session.destroy(); } catch {}
      return reject(e);
    }

    stream.on('error', err => {
      clearTimeout(timeout);
      // Protocol errors (RST_STREAM, GOAWAY, etc.) indicate the session is broken
      if (err.code === 'ERR_HTTP2_STREAM_ERROR' || err.code === 'ERR_HTTP2_SESSION_ERROR' ||
          err.message.includes('Protocol error') || err.message.includes('GOAWAY')) {
        h2Pool.delete(origin);
        try { session.destroy(); } catch {}
      }
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

// ─── Worker script fetcher ───────────────────────────────────────────────────

// Fetches a JS worker script by URL and returns its content as a Buffer.
// Handles both H2 and H1, and decompresses gzip/br/deflate responses.
// Used by the /__tachyon_worker__ endpoint to inject the proxy preamble.
function fetchWorkerScript(targetUrl, reqHeaders) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(targetUrl); }
    catch (e) { return reject(new Error(`Invalid worker URL: ${targetUrl}`)); }

    const forwardHeaders = buildForwardHeaders({ headers: reqHeaders }, parsed);
    forwardHeaders['method'] = 'GET';
    forwardHeaders['accept'] = 'application/javascript, */*';

    function tryH1() {
      const isHttps = parsed.protocol === 'https:';
      const lib = isHttps ? https : http;
      const agent = isHttps ? httpsAgent : httpAgent;
      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: { ...forwardHeaders, host: parsed.hostname, connection: 'close' },
        agent,
        timeout: 15000,
      };
      delete options.headers['method'];
      const proxyReq = lib.request(options, proxyRes => {
        const chunks = [];
        const enc = proxyRes.headers['content-encoding'] || '';
        let stream = proxyRes;
        stream = decompress(stream, enc);
        stream.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
      });
      proxyReq.on('error', reject);
      proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('worker h1 timeout')); });
      proxyReq.end();
    }

    if (parsed.protocol === 'https:') {
      // Try H2 first, fall back to H1
      const origin = `https://${parsed.hostname}${parsed.port ? ':' + parsed.port : ''}`;
      let session;
      try { session = getH2Session(origin); } catch { tryH1(); return; }
      const h2Headers = {
        [http2.constants.HTTP2_HEADER_METHOD]: 'GET',
        [http2.constants.HTTP2_HEADER_PATH]: parsed.pathname + parsed.search,
        [http2.constants.HTTP2_HEADER_SCHEME]: 'https',
        [http2.constants.HTTP2_HEADER_AUTHORITY]: parsed.hostname,
      };
      const skip = new Set(['host', 'connection', 'upgrade-insecure-requests', 'method']);
      for (const [k, v] of Object.entries(forwardHeaders)) {
        if (!skip.has(k.toLowerCase())) h2Headers[k] = v;
      }
      const timeout = setTimeout(() => { reject(new Error('worker h2 timeout')); }, 15000);
      let stream;
      try { stream = session.request(h2Headers); }
      catch { clearTimeout(timeout); tryH1(); return; }
      stream.on('error', err => { clearTimeout(timeout); tryH1(); });
      stream.on('response', headers => {
        clearTimeout(timeout);
        const enc = headers['content-encoding'] || '';
        const chunks = [];
        let bodyStream = decompress(stream, enc);
        bodyStream.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        bodyStream.on('end', () => resolve(Buffer.concat(chunks)));
        bodyStream.on('error', reject);
      });
      stream.end();
    } else {
      tryH1();
    }
  });
}

// ─── HTTP server ─────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const reqPath = req.url.split('?')[0]; // strip query string for path matching

  // ── Favicon — served inline to eliminate 404 console noise ──────────────────
  // A simple lightning bolt SVG matching the ⚡ tab icon used in the UI.
  const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><polygon points="9,1 3,9 8,9 7,15 13,7 8,7" fill="#a78bfa"/></svg>';
  if (reqPath === '/favicon.svg') {
    res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' });
    res.end(FAVICON_SVG);
    return;
  }
  if (reqPath === '/favicon.ico') {
    // Redirect to the SVG favicon — all modern browsers support SVG favicons.
    res.writeHead(302, { location: '/favicon.svg' });
    res.end();
    return;
  }

  // ── Serve static frontend files ──────────────────────────────────────────────
  const STATIC_FILES = {
    '/':            { file: 'index.html',  mime: 'text/html' },
    '/index.html':  { file: 'index.html',  mime: 'text/html' },
    '/app.js':      { file: 'app.js',      mime: 'application/javascript' },
    '/styles.css':  { file: 'styles.css',  mime: 'text/css' },
    '/loader.html': { file: 'loader.html', mime: 'text/html' },
  };
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

  // ── Worker wrapper — fetches a worker script and prepends proxy patching preamble ──
  // Workers don't inherit the page's patched fetch/XHR; they need their own patch.
  // YouTube's SABR video worker makes fetch() calls to rr*.googlevideo.com directly
  // without this patch, so video never loads.
  if (reqPath === '/__tachyon_worker__') {
    const params = new URLSearchParams(req.url.slice(req.url.indexOf('?')));
    const workerUrl = params.get('url');
    const workerBase = params.get('base') || workerUrl || '';
    if (!workerUrl) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('Missing url param');
      return;
    }
    // Decode the proxied URL to get the real target URL.
    // workerUrl is like http://127.0.0.1:8080/https%3A%2F%2F... (already proxied)
    let targetWorkerUrl;
    try {
      const parsedWorkerUrl = new URL(workerUrl);
      if (parsedWorkerUrl.hostname === '127.0.0.1' && String(parsedWorkerUrl.port) === String(PORT)) {
        targetWorkerUrl = dec(parsedWorkerUrl.pathname.slice(1));
      } else {
        targetWorkerUrl = workerUrl;
      }
    } catch {
      targetWorkerUrl = workerUrl;
    }
    fetchWorkerScript(targetWorkerUrl, req.headers).then(scriptBuf => {
      const preamble = Buffer.from(buildWorkerRuntime(workerBase), 'utf8');
      const combined = Buffer.concat([preamble, scriptBuf]);
      res.writeHead(200, {
        'content-type': 'application/javascript',
        'access-control-allow-origin': '*',
        'content-length': String(combined.length),
      });
      res.end(combined);
    }).catch(err => {
      console.error(`Worker fetch error for ${targetWorkerUrl}: ${err.message}`);
      if (!res.headersSent) { res.writeHead(502, { 'content-type': 'text/plain' }); res.end(`Worker fetch error: ${err.message}`); }
    });
    return;
  }

  let targetUrl = dec(req.url.slice(1));

  // When YouTube's JS uses history.pushState (e.g. /watch?v=...) the page URL
  // changes to http://127.0.0.1:8080/watch?v=... and relative fetch/XHR calls
  // like /youtubei/v1/... come here without a proxy prefix. Forward them to
  // YouTube automatically by recognising well-known YouTube API paths.
  if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    const rawPath = req.url; // still has leading /
    if (
      rawPath.startsWith('/youtubei/') ||
      rawPath.startsWith('/api/') ||
      rawPath.startsWith('/generate_204') ||
      rawPath.startsWith('/embed/') ||
      rawPath.startsWith('/shorts/') ||
      rawPath.startsWith('/watch') ||
      rawPath.startsWith('/s/') ||
      rawPath.startsWith('/channel/') ||
      rawPath.startsWith('/hashtag/')
    ) {
      // Treat as a YouTube-relative path
      targetUrl = 'https://www.youtube.com' + rawPath;
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
      return;
    }
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

// ─── WebSocket proxy (HTTP/1.1 upgrade only) ─────────────────────────────────

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

const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
server.listen(PORT, BIND_HOST, () => {
  console.log(`Tachyon proxy running at http://${BIND_HOST}:${PORT}`);
});
