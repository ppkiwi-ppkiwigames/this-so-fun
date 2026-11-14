/* funny.py service worker: proxies pages through libcurl.js + a Wisp server.
   Put this file next to index.html. It is registered as sw.js?wisp=wss%3A%2F%2F... */
const BASES = [
  'https://cdn.jsdelivr.net/npm/libcurl.js@0.7.1/',
  'https://fastly.jsdelivr.net/npm/libcurl.js@0.7.1/',
  'https://gcore.jsdelivr.net/npm/libcurl.js@0.7.1/',
  'https://unpkg.com/libcurl.js@0.7.1/'
];
const WISP = new URL(location.href).searchParams.get('wisp') || 'wss://wisp.mercurywork.shop/';
const SCOPE = new URL(self.registration.scope).pathname;       // e.g. /app/
const PREFIX = SCOPE + '~/';                                    // e.g. /app/~/
const enc = u => PREFIX + encodeURIComponent(u);

let ready = null;
function boot(){
  if (ready) return ready;
  ready = (async () => {
    let last = null;
    for (const b of BASES){
      try {
        if (!self.libcurl) importScripts(b + 'libcurl.js');
        await libcurl.load_wasm(b + 'libcurl.wasm');
        libcurl.set_websocket(WISP);
        return;
      } catch(e){ last = e; }
    }
    ready = null;
    throw last || new Error('Could not load libcurl.js from any mirror');
  })();
  return ready;
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

/* Work out which real address a request is meant for. */
function target(req){
  const u = new URL(req.url);
  if (u.origin !== location.origin) return null;
  if (u.pathname.startsWith(PREFIX)){
    const rest = u.pathname.slice(PREFIX.length) + u.search + u.hash;
    let dec = ''; try { dec = decodeURIComponent(rest.split(/[?#]/)[0]); } catch(e){}
    if (/^https?:\/\//i.test(dec)) return { url: dec, proxied: true };
    const ref = refTarget(req);
    if (ref) return { url: new URL(rest, ref).href, proxied: true };
    return null;
  }
  // Not under /~/ : only handle when the page asking is a proxied page (root-relative links)
  const ref = refTarget(req);
  if (ref && !isOwnFile(u.pathname)) return { url: new URL(u.pathname + u.search, ref).href, proxied: false };
  return null;
}
function refTarget(req){
  try {
    const r = new URL(req.referrer);
    if (r.origin !== location.origin || !r.pathname.startsWith(PREFIX)) return '';
    const d = decodeURIComponent(r.pathname.slice(PREFIX.length));
    return /^https?:\/\//i.test(d) ? d : '';
  } catch(e){ return ''; }
}
function isOwnFile(p){ return p === SCOPE || /\/(sw\.js|index\.html)$/.test(p); }

const STRIP = ['content-security-policy', 'content-security-policy-report-only', 'x-frame-options', 'content-encoding', 'content-length', 'transfer-encoding', 'strict-transport-security', 'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy', 'set-cookie'];

function absTo(v, base){ try { return new URL(v, base).href; } catch(e){ return null; } }

function rewriteHtml(html, base){
  const fix = (m, a, q, v) => {
    if (!/^(https?:)?\/\//i.test(v.trim())) return m;
    const ab = absTo(v.trim(), base); return ab ? a + q + enc(ab) + q : m;
  };
  html = html.replace(/(\s(?:href|src|action|poster|data-src)\s*=\s*)(["'])([^"']*)\2/gi, fix)
             .replace(/\sintegrity\s*=\s*(["'])[^"']*\1/gi, '')
             .replace(/\snonce\s*=\s*(["'])[^"']*\1/gi, '')
             .replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy[^>]*>/gi, '');
  const client = '(' + clientFn.toString() + ')(' + JSON.stringify(PREFIX) + ',' + JSON.stringify(base) + ')';
  const tag = '<script>' + client.replace(/<\/script/gi, '<\\/script') + '</script>';
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => m + tag) : tag + html;
}
function rewriteCss(css, base){
  return css.replace(/url\(\s*(["']?)((?:https?:)?\/\/[^)"']+)\1\s*\)/gi, (m, q, v) => { const ab = absTo(v, base); return ab ? 'url(' + q + enc(ab) + q + ')' : m; })
            .replace(/@import\s+(["'])((?:https?:)?\/\/[^"']+)\1/gi, (m, q, v) => { const ab = absTo(v, base); return ab ? '@import ' + q + enc(ab) + q : m; });
}

/* runs inside the proxied page: sends cross-origin fetch/XHR/open through the proxy as well */
function clientFn(PREFIX, BASE){
  const px = u => {
    try {
      const a = new URL(String(u), BASE);
      if (!/^https?:$/.test(a.protocol) || a.origin === location.origin) return u;
      return PREFIX + encodeURIComponent(a.href);
    } catch(e){ return u; }
  };
  const f = window.fetch;
  window.fetch = function(i, o){ return f.call(this, i instanceof Request ? i : px(i), o); };
  const xo = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(m, u){ arguments[1] = px(u); return xo.apply(this, arguments); };
  const wo = window.open;
  window.open = function(u){ if (u) arguments[0] = px(u); return wo.apply(this, arguments); };
}

self.addEventListener('fetch', e => {
  const t = target(e.request);
  if (!t) return;
  e.respondWith((async () => {
    const req = e.request;
    // a navigation that escaped the prefix: send it back inside
    if (!t.proxied && req.mode === 'navigate') return Response.redirect(enc(t.url), 302);
    try {
      await boot();
      const init = { method: req.method, redirect: 'follow', headers: {} };
      req.headers.forEach((v, k) => { if (!/^(host|origin|referer|cookie|sec-|accept-encoding|connection)/i.test(k)) init.headers[k] = v; });
      init.headers['Referer'] = t.url;
      if (req.method !== 'GET' && req.method !== 'HEAD') init.body = await req.arrayBuffer();
      const r = await libcurl.fetch(t.url, init);
      const finalUrl = r.url || t.url;
      const h = new Headers();
      r.headers.forEach((v, k) => { if (!STRIP.includes(k.toLowerCase())) h.set(k, v); });
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      if (req.mode === 'navigate' && finalUrl !== t.url) return Response.redirect(enc(finalUrl), 302);
      if (ct.includes('text/html')) {
        h.set('content-type', 'text/html; charset=utf-8');
        return new Response(rewriteHtml(await r.text(), finalUrl), { status: r.status, headers: h });
      }
      if (ct.includes('text/css')) return new Response(rewriteCss(await r.text(), finalUrl), { status: r.status, headers: h });
      return new Response(r.status === 204 || r.status === 304 ? null : await r.arrayBuffer(), { status: r.status, headers: h });
    } catch(err){
      return new Response('<!doctype html><meta charset=utf-8><body style="font:15px system-ui;padding:24px;background:#0b0d12;color:#fff"><h3>Could not load this page</h3><p>' + String(err && err.message || err).replace(/</g, '&lt;') + '</p><p>Wisp server: ' + WISP + '</p>', { status: 502, headers: { 'content-type': 'text/html' } });
    }
  })());
});
