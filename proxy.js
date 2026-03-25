const http = require('http');
const https = require('https');
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

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('Invalid URL');
    return;
  }

  console.log(`→ ${req.method} ${targetUrl}`);

  const isHttps = parsed.protocol === 'https:';
  const lib = isHttps ? https : http;
  const agent = isHttps ? httpsAgent : httpAgent;

  // build clean headers — strip all hop-by-hop and problematic ones
  const forwardHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.includes(k.toLowerCase())) {
      forwardHeaders[k] = v;
    }
  }
  forwardHeaders['host'] = parsed.hostname;
  forwardHeaders['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  forwardHeaders['accept'] = forwardHeaders['accept'] || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8';
  forwardHeaders['accept-language'] = 'en-US,en;q=0.9';
  forwardHeaders['connection'] = 'close';

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
    const headers = {};

    // copy response headers, stripping blocked ones
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      if (!STRIP_RESPONSE.includes(k.toLowerCase())) {
        headers[k] = v;
      }
    }

    // always allow cors from localhost
    headers['access-control-allow-origin'] = '*';
    headers['access-control-allow-credentials'] = 'true';

    // rewrite redirect location
    if (headers['location']) {
      try {
        const redirectUrl = new URL(headers['location'], targetUrl).href;
        headers['location'] = `${PROXY_BASE}/${enc(redirectUrl)}`;
      } catch {}
    }

    // fix cookies
    if (headers['set-cookie']) {
      const cookies = Array.isArray(headers['set-cookie'])
        ? headers['set-cookie']
        : [headers['set-cookie']];
      headers['set-cookie'] = cookies.map(c =>
        c.replace(/;\s*domain=[^;]*/gi, '')
         .replace(/;\s*secure/gi, '')
         .replace(/;\s*samesite=[^;]*/gi, '')
         .replace(/;\s*partitioned/gi, '')
      );
    }

    const contentType = (headers['content-type'] || '').toLowerCase();
    const isHtml = contentType.includes('text/html');
    const isCss = contentType.includes('text/css');
    const isJs = contentType.includes('javascript') || contentType.includes('ecmascript');

    if (isHtml || isCss || isJs) {
      const chunks = [];
      proxyRes.on('data', chunk => chunks.push(chunk));
      proxyRes.on('end', () => {
        let body = Buffer.concat(chunks).toString('utf8');

        if (isHtml) body = rewriteHtml(body, targetUrl);
        else if (isCss) body = rewriteCss(body, targetUrl);
        else if (isJs) body = rewriteJs(body, targetUrl);

        const buf = Buffer.from(body, 'utf8');
        headers['content-length'] = buf.length.toString();
        delete headers['transfer-encoding'];

        res.writeHead(proxyRes.statusCode, headers);
        res.end(buf);
      });
      proxyRes.on('error', err => {
        console.error(`Stream error: ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(502);
          res.end('Stream error');
        }
      });
    } else {
      // binary content — stream directly
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
      proxyRes.on('error', err => console.error(`Stream error: ${err.message}`));
    }
  });

  proxyReq.on('error', err => {
    console.error(`✗ ${err.message} — ${targetUrl}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`Proxy error: ${err.message}`);
    }
  });

  proxyReq.on('timeout', () => {
    console.error(`✗ timeout — ${targetUrl}`);
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
});
