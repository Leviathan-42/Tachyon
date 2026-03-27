/**
 * Tachyon Cloudflare Worker
 *
 * Proxies any HTTP/HTTPS URL through Cloudflare's edge network.
 * Deploy with: npx wrangler deploy
 *
 * Usage: https://your-worker.workers.dev/<encoded-url>
 * Example: https://your-worker.workers.dev/https%3A%2F%2Fwww.youtube.com
 */

const STRIP_RESPONSE_HEADERS = new Set([
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
  "x-content-type-options",
  "strict-transport-security",
  "permissions-policy",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "alt-svc",
]);

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
  "origin",
  "referer",
  "accept-encoding",
  "if-none-match",
  "if-modified-since",
  "if-range",
  "host",
]);

function enc(u) {
  return encodeURIComponent(u);
}
function dec(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function resolve(base, rel) {
  try {
    return new URL(rel, base).href;
  } catch {
    return null;
  }
}

function rewriteUrl(u, base, workerBase) {
  if (!u) return u;
  u = u.trim();
  if (
    u.startsWith("data:") ||
    u.startsWith("blob:") ||
    u.startsWith("javascript:") ||
    u.startsWith("#") ||
    u.startsWith("mailto:") ||
    u.startsWith("tel:") ||
    u.startsWith(workerBase + "/")
  )
    return u;
  const resolved = resolve(base, u);
  if (!resolved) return u;
  if (!resolved.startsWith("http://") && !resolved.startsWith("https://"))
    return u;
  return `${workerBase}/${enc(resolved)}`;
}

function rewriteHtml(html, base, workerBase) {
  // attribute URLs
  html = html.replace(
    /((?:src|href|action|data-src|data-href|poster|background)=)(["'])([^"']*)\2/gi,
    (m, attr, q, val) => `${attr}${q}${rewriteUrl(val, base, workerBase)}${q}`,
  );

  // srcset
  html = html.replace(/srcset=(["'])([^"']+)\1/gi, (m, q, val) => {
    const rewritten = val
      .split(",")
      .map((part) => {
        const trimmed = part.trim();
        const spaceIdx = trimmed.search(/\s/);
        if (spaceIdx === -1) return rewriteUrl(trimmed, base, workerBase);
        return (
          rewriteUrl(trimmed.slice(0, spaceIdx), base, workerBase) +
          trimmed.slice(spaceIdx)
        );
      })
      .join(", ");
    return `srcset=${q}${rewritten}${q}`;
  });

  // inline style url()
  html = html.replace(
    /url\((["']?)([^"')]+)\1\)/gi,
    (m, q, val) => `url(${q}${rewriteUrl(val, base, workerBase)}${q})`,
  );

  // meta refresh
  html = html.replace(
    /(<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][0-9]+;\s*url=)([^"'>]+)/gi,
    (m, pre, url) => `${pre}${rewriteUrl(url.trim(), base, workerBase)}`,
  );

  // inject runtime
  const runtime = buildRuntime(base, workerBase);
  if (/<head[\s>]/i.test(html)) {
    html = html.replace(/<head([\s>])/i, `<head$1>${runtime}`);
  } else {
    html = runtime + html;
  }

  return html;
}

function rewriteCss(css, base, workerBase) {
  return css.replace(
    /url\((["']?)([^"')]+)\1\)/gi,
    (m, q, val) => `url(${q}${rewriteUrl(val, base, workerBase)}${q})`,
  );
}

function buildRuntime(base, workerBase) {
  const safeBase = base.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const safeWorker = workerBase.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `<script>
(function(){
"use strict";
var P="${safeWorker}";
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

var _fetch=window.fetch.bind(window);
window.fetch=function(input,init){
  try{
    if(typeof input==="string"){
      input=rw(input);
    } else if(input instanceof Request){
      var rwu=rw(input.url);
      if(rwu!==input.url){
        init=Object.assign({
          method:input.method,headers:input.headers,body:input.body,
          mode:input.mode,credentials:input.credentials,cache:input.cache,
          redirect:input.redirect,referrer:input.referrer,
          referrerPolicy:input.referrerPolicy,integrity:input.integrity,
        },init||{});
        delete init.keepalive;
        input=rwu;
      }
    }
  }catch(e){}
  return _fetch(input,init);
};

var _open=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(method,url){
  try{ url=rw(url); }catch(e){}
  return _open.apply(this,[method,url].concat([].slice.call(arguments,2)));
};

var _winOpen=window.open;
window.open=function(u,t,f){
  try{ if(u&&u!=="about:blank") u=rw(u); }catch(e){}
  return _winOpen.call(this,u,t,f);
};

var _push=history.pushState,_replace=history.replaceState;
history.pushState=function(s,t,u){ try{ if(u) u=rw(u); }catch(e){} return _push.call(this,s,t,u); };
history.replaceState=function(s,t,u){ try{ if(u) u=rw(u); }catch(e){} return _replace.call(this,s,t,u); };

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

var _setAttr=Element.prototype.setAttribute;
Element.prototype.setAttribute=function(name,value){
  try{
    var n=name.toLowerCase();
    if((n==="src"||n==="href"||n==="action"||n==="data-src"||n==="poster")&&value)
      value=rw(value);
  }catch(e){}
  return _setAttr.call(this,name,value);
};

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

(function(){
  var _Worker=window.Worker;
  if(!_Worker) return;
  window.Worker=function(url,opts){
    try{ url=rw(url); }catch(e){}
    return new _Worker(url,opts);
  };
  window.Worker.prototype=_Worker.prototype;
})();

document.addEventListener("click",function(e){
  var a=e.target.closest("a[href]");
  if(!a) return;
  var h=a.getAttribute("href");
  if(!h||h.startsWith("#")||h.startsWith("javascript:")) return;
  var rwh=rw(h);
  if(rwh!==h){ e.preventDefault(); location.href=rwh; }
},true);

document.addEventListener("submit",function(e){
  var f=e.target;
  if(f.action){ try{ f.action=rw(f.action); }catch(e){} }
},true);

var WATCH_ATTRS=["src","href","action","poster","data-src"];
var mo=new MutationObserver(function(mutations){
  for(var i=0;i<mutations.length;i++){
    var mut=mutations[i];
    if(mut.type==="attributes"){
      var el=mut.target,attr=mut.attributeName;
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
mo.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:WATCH_ATTRS});

})();
</script>`;
}

function needsTextRewrite(ct) {
  return (
    ct.includes("text/html") ||
    ct.includes("text/css") ||
    ct.includes("javascript") ||
    ct.includes("ecmascript")
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods":
            "GET, POST, PUT, DELETE, PATCH, OPTIONS",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(
        JSON.stringify({ status: "ok", service: "tachyon-worker" }),
        {
          headers: {
            "content-type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    // Decode target URL from path: /https%3A%2F%2Fyoutube.com → https://youtube.com
    const rawTarget = dec(url.pathname.slice(1));
    if (!rawTarget.startsWith("http://") && !rawTarget.startsWith("https://")) {
      return new Response(
        "Invalid or missing target URL. Use: /https%3A%2F%2Fexample.com",
        {
          status: 400,
          headers: { "Access-Control-Allow-Origin": "*" },
        },
      );
    }

    // Preserve query string from the original request
    let targetUrl = rawTarget;
    if (url.search && !rawTarget.includes("?")) {
      targetUrl = rawTarget + url.search;
    }

    const workerBase = `${url.protocol}//${url.host}`;

    // Build forwarded request headers
    const forwardHeaders = new Headers();
    for (const [k, v] of request.headers.entries()) {
      const kl = k.toLowerCase();
      if (!HOP_BY_HOP.has(kl)) forwardHeaders.set(k, v);
    }
    forwardHeaders.set(
      "user-agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    );
    forwardHeaders.set(
      "accept",
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    );
    forwardHeaders.set("accept-language", "en-US,en;q=0.9");
    forwardHeaders.set(
      "sec-fetch-dest",
      forwardHeaders.get("sec-fetch-dest") || "document",
    );
    forwardHeaders.set(
      "sec-fetch-mode",
      forwardHeaders.get("sec-fetch-mode") || "navigate",
    );
    forwardHeaders.set("sec-fetch-site", "cross-site");

    let upstreamResp;
    try {
      upstreamResp = await fetch(targetUrl, {
        method: request.method,
        headers: forwardHeaders,
        body: ["GET", "HEAD"].includes(request.method)
          ? undefined
          : request.body,
        redirect: "manual", // handle redirects ourselves so we can rewrite Location
      });
    } catch (err) {
      return new Response(`Proxy fetch error: ${err.message}`, {
        status: 502,
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }

    // Handle redirects — rewrite Location header
    if (upstreamResp.status >= 300 && upstreamResp.status < 400) {
      const location = upstreamResp.headers.get("location");
      if (location) {
        let resolved;
        try {
          resolved = new URL(location, targetUrl).href;
        } catch {
          resolved = location;
        }
        return new Response(null, {
          status: upstreamResp.status,
          headers: {
            Location: `${workerBase}/${enc(resolved)}`,
            "Access-Control-Allow-Origin": "*",
          },
        });
      }
    }

    // Build response headers
    const respHeaders = new Headers();
    for (const [k, v] of upstreamResp.headers.entries()) {
      const kl = k.toLowerCase();
      if (STRIP_RESPONSE_HEADERS.has(kl)) continue;
      if (kl === "set-cookie") {
        // Strip cookie domain/secure/samesite so cookies work on the worker domain
        const cleaned = v
          .replace(/;\s*domain=[^;]*/gi, "")
          .replace(/;\s*secure\b/gi, "")
          .replace(/;\s*samesite=[^;]*/gi, "")
          .replace(/;\s*partitioned\b/gi, "");
        respHeaders.append("set-cookie", cleaned);
        continue;
      }
      if (kl === "location") continue; // already handled above
      respHeaders.set(k, v);
    }
    respHeaders.set("Access-Control-Allow-Origin", "*");
    respHeaders.set("Access-Control-Allow-Credentials", "true");

    const contentType = (
      upstreamResp.headers.get("content-type") || ""
    ).toLowerCase();

    if (needsTextRewrite(contentType)) {
      const text = await upstreamResp.text();
      let body = text;
      if (contentType.includes("text/html")) {
        body = rewriteHtml(text, targetUrl, workerBase);
      } else if (contentType.includes("text/css")) {
        body = rewriteCss(text, targetUrl, workerBase);
      }
      // Remove content-length since we may have changed the size
      respHeaders.delete("content-length");
      respHeaders.delete("content-encoding");
      return new Response(body, {
        status: upstreamResp.status,
        headers: respHeaders,
      });
    }

    // Binary/other — stream through as-is
    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      headers: respHeaders,
    });
  },
};
