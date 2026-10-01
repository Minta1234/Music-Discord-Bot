// ---------- Helpers ----------
const enc = new TextEncoder();
const SESSION_TTL_SEC = 12 * 3600;

function escHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function toB64Url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Constant-time string compare: both sides are HMAC'd first, so lengths are always equal
async function safeEqualStrings(a, b, secret) {
  const [x, y] = await Promise.all([hmac(secret, String(a)), hmac(secret, String(b))]);
  return bytesEqual(x, y);
}

async function makeSession(secret) {
  const exp = String(Math.floor(Date.now() / 1000) + SESSION_TTL_SEC);
  return `${exp}.${toB64Url(await hmac(secret, exp))}`;
}

async function verifySession(token, secret) {
  if (!token) return false;
  const i = token.indexOf(".");
  if (i < 1) return false;
  const exp = token.slice(0, i);
  const sig = token.slice(i + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return false;
  const expected = enc.encode(toB64Url(await hmac(secret, exp)));
  return bytesEqual(expected, enc.encode(sig));
}

function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

const SEC_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

function htmlResponse(body, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...SEC_HEADERS } });
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...SEC_HEADERS } });
}

async function loginAllowed(request, env) {
  // Optional Cloudflare Rate Limiting binding (see wrangler config)
  if (!env.LOGIN_LIMITER) return true;
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const { success } = await env.LOGIN_LIMITER.limit({ key: ip });
  return success;
}

const SESSION_COOKIE = "dash_session";
const cookieAttrs = "HttpOnly; Secure; Path=/; SameSite=Strict";

// ---------- Worker ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    const method = request.method;

    // Required config; BOT_SECRET and DASHBOARD_PASSWORD must be different values
    const BOT_API = env.BOT_API_URL;
    const PASSWORD = env.DASHBOARD_PASSWORD;
    const SESSION_SECRET = env.SESSION_SECRET;
    const BOT_SECRET = env.BOT_SECRET;
    if (!BOT_API || !PASSWORD || !SESSION_SECRET || !BOT_SECRET) {
      return new Response("Server misconfigured", { status: 500 });
    }

    // CSRF defense for state-changing requests: Origin must match when present
    if (method !== "GET" && method !== "HEAD") {
      const origin = request.headers.get("Origin");
      if (origin && origin !== url.origin) return new Response("Forbidden", { status: 403 });
    }

    if (p === "/") return Response.redirect(url.origin + "/dashboard", 302);

    if (p === "/login" && method === "GET") return htmlResponse(dashLoginPage());

    if (p === "/login" && method === "POST") {
      if (!(await loginAllowed(request, env))) {
        return htmlResponse(dashLoginPage("Too many attempts. Try again later."), 429);
      }
      const formData = await request.formData();
      const pass = String(formData.get("password") ?? "");
      if (await safeEqualStrings(pass, PASSWORD, SESSION_SECRET)) {
        return new Response(null, {
          status: 302,
          headers: {
            Location: "/dashboard",
            "Set-Cookie": `${SESSION_COOKIE}=${await makeSession(SESSION_SECRET)}; ${cookieAttrs}; Max-Age=${SESSION_TTL_SEC}`,
            ...SEC_HEADERS,
          },
        });
      }
      return htmlResponse(dashLoginPage("Invalid password"), 401);
    }

    if (p === "/logout") {
      return new Response(null, {
        status: 302,
        headers: { Location: "/login", "Set-Cookie": `${SESSION_COOKIE}=; ${cookieAttrs}; Max-Age=0`, ...SEC_HEADERS },
      });
    }

    // Protect remaining routes
    const isAuthed = await verifySession(getCookie(request, SESSION_COOKIE), SESSION_SECRET);
    if (!isAuthed) {
      if (p.startsWith("/api/")) return jsonResponse({ error: "unauthorized" }, 401);
      return Response.redirect(url.origin + "/login", 302);
    }

    // Proxy API requests to Railway (any method, body preserved, query string kept)
    if (p.startsWith("/api/") || p.startsWith("/cookies") || p === "/ytdlp-update") {
      const hasBody = method !== "GET" && method !== "HEAD";
      const headers = { "X-Bot-Secret": BOT_SECRET };
      const ct = request.headers.get("Content-Type");
      if (ct) headers["Content-Type"] = ct;
      try {
        const res = await fetch(BOT_API + p + url.search, {
          method,
          headers,
          body: hasBody ? await request.arrayBuffer() : undefined,
          redirect: "manual",
        });
        return new Response(res.body, {
          status: res.status,
          headers: { "Content-Type": res.headers.get("Content-Type") || "application/json", ...SEC_HEADERS },
        });
      } catch {
        return jsonResponse({ error: "bot unreachable" }, 502);
      }
    }

    if (p === "/dashboard") {
      try {
        const res = await fetch(BOT_API + "/api/status", { headers: { "X-Bot-Secret": BOT_SECRET } });
        if (!res.ok) throw new Error("Bot responded " + res.status);
        const status = await res.json();
        const msg = url.searchParams.get("msg") || "";
        return htmlResponse(dashPageTailwind(status, msg, false, escHtml));
      } catch {
        // Do not leak internal error details to the client
        return new Response("Cannot reach bot API", { status: 502, headers: SEC_HEADERS });
      }
    }

    if (p === "/web.html" || p === "/player") return htmlResponse(dashPlayerPageTailwind());

    return new Response("Not found", { status: 404, headers: SEC_HEADERS });
  },
};

// ---------- HTML Templates ----------
function dashLoginPage(msg = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Music Bot · Sign in</title>
<script src="https://cdn.tailwindcss.com"></script><link href="https://unpkg.com/aos@2.3.4/dist/aos.css" rel="stylesheet">
<style>body{background:radial-gradient(ellipse at 15% 15%,rgba(232,179,76,.1),transparent 38%),#0b0f14}input:focus{outline:2px solid #e8b34c;outline-offset:2px}</style></head>
<body class="min-h-screen text-zinc-100 antialiased"><main class="mx-auto flex min-h-screen max-w-6xl items-center justify-center px-5 py-12">
<section data-aos="fade-up" class="w-full max-w-md border border-white/10 bg-[#121a24] p-7 shadow-2xl shadow-black/30 sm:p-9">
<div class="mb-8 flex items-center gap-3"><span class="grid h-11 w-11 place-items-center bg-amber-400 text-xl font-black text-[#17140d]">♪</span><div><p class="text-xs font-semibold uppercase tracking-[.18em] text-amber-300">Control desk</p><p class="text-xs text-zinc-500">Music bot</p></div></div>
<h1 class="text-2xl font-semibold tracking-tight">Sign in</h1><p class="mt-2 text-sm text-zinc-400">Use the dashboard credentials configured for this bot.</p>
${msg ? `<div role="alert" class="mt-5 border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-sm text-rose-200">${escHtml(msg)}</div>` : ""}
<form method="POST" action="/login" class="mt-7 space-y-4">
<label class="block text-xs font-medium text-zinc-400">Password<input name="password" type="password" required autocomplete="current-password" class="mt-2 w-full border border-white/10 bg-[#0b0f14] px-3 py-3 text-sm text-zinc-100 placeholder:text-zinc-600" placeholder="Password"></label><button class="w-full bg-amber-300 px-4 py-3 text-sm font-bold text-[#19150c] transition hover:bg-amber-200" type="submit">Continue</button></form>
</section></main><script src="https://unpkg.com/aos@2.3.4/dist/aos.js"></script><script>AOS.init({once:true,duration:500,disable:window.matchMedia('(prefers-reduced-motion: reduce)').matches});</script></body></html>`;
}

function dashPageTailwind(status, msg, isErr, escHtml) {
  const queues = status.queues.map((guild) => {
    const nowLine = guild.nowPlaying ? `<p class="mb-2 text-xs font-semibold text-amber-300/80">&#9654;&#65039; Now playing: ${escHtml(guild.nowPlaying)}</p>` : `<p class="mb-2 text-xs text-zinc-600">&#8212; idle &#8212;</p>`;
    const nextLines = guild.next.length ? `<ol class="space-y-1">${guild.next.map((t, i) => `<li class="flex gap-2 text-xs text-zinc-400"><span class="font-mono text-zinc-600 w-5 shrink-0">${i + 1}.</span><span class="truncate">${escHtml(t)}</span></li>`).join("")}</ol>` : `<p class="text-xs text-zinc-600">No upcoming tracks</p>`;
    const idleBadge = guild.nowPlaying ? `<span class="hidden max-w-[180px] truncate text-xs text-zinc-400 sm:block group-open:hidden">&#9654; ${escHtml(guild.nowPlaying)}</span>` : `<span class="text-xs text-zinc-600">Idle</span>`;
    return `<li class="border-b border-white/5 last:border-0"><details class="group"><summary class="flex cursor-pointer list-none items-center gap-3 py-3 select-none hover:text-amber-200"><span class="font-mono text-amber-300 transition-transform duration-200 group-open:rotate-90 inline-block">&#9654;</span><div class="min-w-0 flex-1"><strong class="text-sm">${escHtml(guild.name)}</strong><span class="ml-2 font-mono text-[10px] text-zinc-500">${guild.queueCount} queued</span></div>${idleBadge}</summary><div class="pb-3 pl-6">${nowLine}${nextLines}</div></details></li>`;
  }).join("") || `<li class="py-3 text-sm text-zinc-500">No servers connected</li>`;
  
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bocchi · Control Desk</title>
<script src="https://cdn.tailwindcss.com"></script><link href="https://unpkg.com/aos@2.3.4/dist/aos.css" rel="stylesheet">
<style>body{background-color:#090c10;background-image:linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px);background-size:32px 32px}input:focus,select:focus,textarea:focus{outline:2px solid #e8b34c;outline-offset:2px}button:focus-visible,a:focus-visible{outline:2px solid #e8b34c;outline-offset:3px} [data-aos]{will-change:transform,opacity}::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:#27272a;border-radius:3px}::-webkit-scrollbar-thumb:hover{background:#3f3f46}</style></head>
<body class="min-h-screen text-zinc-100 antialiased"><div class="mx-auto max-w-7xl px-4 pb-16 sm:px-6 lg:px-8">
<header class="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 py-5" data-aos="fade-down"><div class="flex items-center gap-3"><span class="grid h-10 w-10 place-items-center bg-amber-300 text-xl font-black text-zinc-950">♪</span><div><p class="text-sm font-semibold">${escHtml(status.tag)}</p><p class="font-mono text-[11px] text-zinc-500">BOT CONTROL DESK</p></div></div><div class="flex items-center gap-4"><span class="inline-flex items-center gap-2 text-xs text-emerald-300"><i class="h-2 w-2 rounded-full bg-emerald-400"></i>Online</span><span class="font-mono text-xs text-zinc-400">${status.guilds} servers</span></div><nav class="flex gap-4 text-xs text-zinc-400"><a class="hover:text-amber-200" href="/web.html">Web player</a><a class="hover:text-rose-300" href="/logout">Logout</a></nav></header>
<main><section class="flex flex-wrap items-end justify-between gap-4 py-8" data-aos="fade-up"><div><p class="font-mono text-xs uppercase text-amber-300">Music operations / Overview</p><h1 class="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Control room<span class="text-amber-300">.</span></h1></div><div class="font-mono text-xs text-zinc-500">LIVE SYSTEM · ${escHtml(status.tag)}</div></section>
${msg ? `<div role="alert" class="mb-5 border px-4 py-3 text-sm ${isErr ? "border-rose-400/30 bg-rose-400/10 text-rose-200" : "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"}">${escHtml(msg)}</div>` : ""}
<section class="mb-8 border border-white/10 bg-[#10151b]/95 p-5 sm:p-6" data-aos="fade-up"><div class="mb-5 flex items-center justify-between"><div><p class="font-mono text-[11px] uppercase text-zinc-500">01 / Transport</p><h2 class="mt-1 text-lg font-semibold">Playback controls</h2></div><span class="border border-amber-300/20 px-2 py-1 font-mono text-[10px] text-amber-200">REMOTE</span></div>
<div class="grid gap-4 md:grid-cols-[1fr_1fr_auto_auto]"><label class="text-xs text-zinc-400">Server<select id="ctlGuild" class="mt-2 w-full border border-white/10 bg-[#090c10] px-3 py-3 text-sm text-zinc-100"></select></label><label class="text-xs text-zinc-400">Voice channel<select id="ctlChan" class="mt-2 w-full border border-white/10 bg-[#090c10] px-3 py-3 text-sm text-zinc-100"></select></label><button class="self-end bg-amber-300 px-5 py-3 text-sm font-semibold text-zinc-950 hover:bg-amber-200" onclick="ctlJoin()">Join voice</button><button class="self-end border border-white/15 px-5 py-3 text-sm text-zinc-200 hover:border-rose-300 hover:text-rose-200" onclick="ctlLeave()">Leave</button></div>
<div class="mt-4 flex flex-wrap gap-2"><input id="ctlQuery" type="text" placeholder="Song name or URL" class="min-w-[220px] flex-1 border border-white/10 bg-[#090c10] px-3 py-3 text-sm text-white placeholder:text-zinc-600"><button class="bg-amber-300 px-5 py-3 text-sm font-semibold text-zinc-950 hover:bg-amber-200" onclick="ctlPlay()">Add to queue</button></div>
<div class="mt-4 flex flex-wrap items-center gap-2"><div class="flex gap-2"><button class="h-11 w-12 border border-white/10 text-lg hover:border-amber-300" onclick="ctlDo('prev')" title="Previous">⏮</button><button class="h-11 w-12 border border-white/10 text-lg hover:border-amber-300" onclick="ctlDo('pause')" title="Pause">Ⅱ</button><button class="h-11 w-12 border border-white/10 text-lg hover:border-amber-300" onclick="ctlDo('resume')" title="Resume">▶</button><button class="h-11 w-12 border border-white/10 text-lg hover:border-amber-300" onclick="ctlDo('skip')" title="Skip">⏭</button><button class="h-11 w-12 border border-rose-400/30 text-lg text-rose-300 hover:bg-rose-400/10" onclick="ctlDo('stop')" title="Stop">■</button><button class="h-11 w-12 border border-white/10 text-lg hover:border-amber-300" onclick="window.scrollTo({top: document.body.scrollHeight, behavior: 'smooth'})" title="List">📋</button></div><button class="h-11 border border-white/10 px-4 text-sm hover:border-amber-300" onclick="ctlDo('shuffle')">Shuffle</button><div class="ml-auto flex flex-wrap items-end gap-3"><label class="text-xs text-zinc-500">Volume %<input id="ctlVol" type="number" min="0" max="10000" step="10" class="mt-1 block w-24 border border-white/10 bg-[#090c10] px-2 py-2 text-sm text-white"></label><button class="h-10 border border-white/10 px-3 text-xs hover:border-amber-300" onclick="ctlVolSet()">Set</button><label class="text-xs text-zinc-500">Loop<select id="ctlLoop" class="mt-1 block border border-white/10 bg-[#090c10] px-3 py-2 text-sm text-white"><option value="off">Off</option><option value="track">Track</option><option value="queue">Queue</option></select></label><button class="h-10 border border-white/10 px-3 text-xs hover:border-amber-300" onclick="ctlLoopSet()">Set</button></div></div>
<div id="ctlNow" class="mt-5 border-l-2 border-amber-300 bg-black/20 px-4 py-3 text-sm leading-6 text-zinc-300"></div><p id="ctlMsg" class="mt-2 min-h-5 text-xs text-zinc-500"><small></small></p></section>
<div class="grid gap-6 lg:grid-cols-[1.1fr_.9fr]"><section class="border border-white/10 bg-[#10151b]/95 p-5 sm:p-6" data-aos="fade-up"><div class="mb-4 flex items-end justify-between"><div><p class="font-mono text-[11px] uppercase text-zinc-500">02 / Queue</p><h2 class="mt-1 text-lg font-semibold">Server activity</h2></div><span class="font-mono text-xs text-zinc-500">${status.queues.length} active</span></div><ul class="divide-y divide-white/5">${queues}</ul></section>
</div>
</main><footer class="mt-10 border-t border-white/10 pt-4 font-mono text-[10px] text-zinc-600">BOCCHI AUDIO SYSTEM · DASHBOARD (Cloudflare Edition)</footer></div>
<script src="https://unpkg.com/aos@2.3.4/dist/aos.js"></script><script>
var CTL_G = [];
function ctlSay(t){ var el = document.querySelector('#ctlMsg small'); if (el) el.textContent = t; }
function ctlGid(){ var s = document.getElementById('ctlGuild'); return s && s.value ? s.value : ''; }
async function ctlCall(path, data){var r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data||{})});var j=null;try{j=await r.json()}catch(e){throw new Error('bad response')}if(!r.ok||(j&&j.error))throw new Error((j&&j.error)||('HTTP '+r.status));return j;}
async function ctlLoad(){try{var gs=await(await fetch('/api/guilds')).json();CTL_G=gs;var gsel=document.getElementById('ctlGuild');gsel.innerHTML='';gs.forEach(function(g){var o=document.createElement('option');o.value=g.id;o.textContent=g.name+(g.botVC?' · in voice':'');gsel.appendChild(o)});ctlGuildChanged();ctlRefresh()}catch(e){ctlSay('load failed: '+e.message)}}
function ctlGuildChanged(){var id=ctlGid();var g=CTL_G.find(function(x){return x.id===id});var csel=document.getElementById('ctlChan');csel.innerHTML='';if(g)g.voice.forEach(function(c){var o=document.createElement('option');o.value=c.id;o.textContent=c.name+' · '+c.members+' members';csel.appendChild(o)})}
async function ctlJoin(){try{var j=await ctlCall('/api/join',{guildId:ctlGid(),channelId:document.getElementById('ctlChan').value});ctlSay('Joined '+j.channel);ctlLoad()}catch(e){ctlSay('Join failed: '+e.message)}}
async function ctlLeave(){try{await ctlCall('/api/leave',{guildId:ctlGid()});ctlSay('Left voice');ctlLoad()}catch(e){ctlSay('Leave failed: '+e.message)}}
async function ctlPlay(){var q=document.getElementById('ctlQuery').value;if(!q){ctlSay('Enter a song first.');return}try{var j=await ctlCall('/api/play',{guildId:ctlGid(),query:q});ctlSay('Queued: '+j.title);document.getElementById('ctlQuery').value='';ctlRefresh()}catch(e){ctlSay('Play failed: '+e.message)}}
async function ctlDo(a){try{var j=await ctlCall('/api/ctl',{guildId:ctlGid(),action:a});ctlSay(a+': '+j.result);ctlRefresh()}catch(e){ctlSay(a+' failed: '+e.message)}}
async function ctlVolSet(){try{var j=await ctlCall('/api/volume',{guildId:ctlGid(),value:Number(document.getElementById('ctlVol').value)});ctlSay('Volume: '+j.result+'%');ctlRefresh()}catch(e){ctlSay('Volume failed: '+e.message)}}
async function ctlLoopSet(){try{var j=await ctlCall('/api/loop',{guildId:ctlGid(),mode:document.getElementById('ctlLoop').value});ctlSay('Loop: '+j.result);ctlRefresh()}catch(e){ctlSay('Loop failed: '+e.message)}}
function ctlEsc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
async function ctlRefresh(){var id=ctlGid();if(!id)return;try{var gs=await(await fetch('/api/guilds')).json();CTL_G=gs;var g=CTL_G.find(function(x){return x.id===id});if(!g)return;var h='<b>Now:</b> '+ctlEsc(g.nowPlaying?g.nowPlaying.title:'— idle —')+' · 🔊 '+g.volume+'% · 🔁 '+ctlEsc(g.loop)+' · '+ctlEsc(g.player);if(g.queue&&g.queue.length){h+='<br><b>Queue:</b><ol style="margin:4px 0 0;padding-left:22px">'+g.queue.map(function(x){return '<li>'+ctlEsc(x.title)+'</li>'}).join('')+'</ol>';}document.getElementById('ctlNow').innerHTML=h;var v=document.getElementById('ctlVol');if(v&&document.activeElement!==v)v.value=g.volume;var l=document.getElementById('ctlLoop');if(l)l.value=g.loop}catch(e){}}
document.getElementById('ctlGuild').addEventListener('change',function(){ctlGuildChanged();ctlRefresh()});
if(window.AOS)AOS.init({once:true,duration:520,offset:22,disable:window.matchMedia('(prefers-reduced-motion: reduce)').matches});ctlLoad();setInterval(ctlRefresh,10000);
</script></body></html>`;
}

function dashPlayerPageTailwind() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bocchi · Web Player</title>
<script src="https://cdn.tailwindcss.com"></script><link href="https://unpkg.com/aos@2.3.4/dist/aos.css" rel="stylesheet">
<style>body{background-color:#090c10;background-image:linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px);background-size:32px 32px}input:focus,select:focus{outline:2px solid #e8b34c;outline-offset:2px}::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:#27272a;border-radius:3px}::-webkit-scrollbar-thumb:hover{background:#3f3f46}@keyframes live-pulse{0%,100%{opacity:1}50%{opacity:.4}}#live-dot{animation:live-pulse 1.5s ease-in-out infinite}</style></head><body class="min-h-screen text-zinc-100 antialiased">
<main class="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-10"><header class="mb-8 flex flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-5" data-aos="fade-down"><div class="flex items-center gap-3"><span class="grid h-10 w-10 place-items-center bg-amber-300 text-xl font-black text-zinc-950">♪</span><div><p class="text-sm font-semibold">Bocchi player</p><p class="font-mono text-[10px] text-zinc-500">LISTENING ROOM</p></div></div><div class="flex flex-wrap items-center gap-2"><a class="px-3 py-2 text-xs text-zinc-400 hover:text-amber-200" href="/dashboard">← Control desk</a><select id="srv" class="border border-white/10 bg-[#10151b] px-3 py-2 text-sm"></select><select id="chn" class="border border-white/10 bg-[#10151b] px-3 py-2 text-sm"></select><button class="border border-white/15 px-3 py-2 text-xs hover:border-amber-300" onclick="P.join()">Join voice</button><button class="border border-white/15 px-3 py-2 text-xs hover:border-rose-300" onclick="P.leave()">Leave</button></div></header>
<section class="grid gap-6 md:grid-cols-[minmax(0,1.2fr)_minmax(280px,.8fr)] items-start" data-aos="fade-up"><div class="border border-white/10 bg-[#10151b] p-4 sm:p-6"><div id="cover-wrap" class="mb-5 aspect-video w-full overflow-hidden border border-white/10 bg-gradient-to-br from-zinc-900 via-zinc-800 to-zinc-900 flex items-center justify-center"><img id="cover" class="h-full w-full object-cover hidden" alt="Album art" onerror="this.classList.add('hidden');document.getElementById('cover-ph').classList.remove('hidden')"><div id="cover-ph" class="flex flex-col items-center gap-2 text-zinc-600"><span class="text-5xl">♪</span><span class="text-xs font-mono">NO ART</span></div></div><p class="font-mono text-[10px] uppercase text-amber-300">Now playing</p><h1 id="ttl" class="mt-2 break-words text-2xl font-semibold sm:text-3xl">— idle —</h1><p id="by" class="mt-2 text-sm text-zinc-400"></p>
<div id="lyrics-container" class="mt-6 h-56 overflow-y-auto scroll-smooth rounded bg-[#090c10] p-4 text-center font-medium leading-loose text-zinc-400 hidden shadow-inner border border-white/5" style="-webkit-mask-image: linear-gradient(transparent, black 15%, black 85%, transparent); mask-image: linear-gradient(transparent, black 15%, black 85%, transparent);"></div>
<div class="mt-5"><div id="timebar" class="h-2 cursor-pointer rounded-full bg-white/10" title="Click to seek"><div id="tfill" class="h-full w-0 rounded-full bg-amber-300"></div></div><div class="mt-1 flex justify-between font-mono text-[11px] text-zinc-500"><span id="tcur">0:00</span><span id="tdur">• LIVE</span></div></div>
<div class="mt-6 flex flex-wrap items-center gap-2"><button class="h-11 w-12 border border-white/10 text-lg hover:border-amber-300" onclick="P.ctl('prev')" title="Previous">⏮</button><button id="pp" class="h-11 w-12 bg-amber-300 text-lg text-zinc-950 hover:bg-amber-200" onclick="P.toggle()" title="Play or pause">▶️</button><button class="h-11 w-12 border border-white/10 text-lg hover:border-amber-300" onclick="P.ctl('skip')" title="Skip">⏭</button><button class="h-11 w-12 border border-rose-400/30 text-lg text-rose-300 hover:bg-rose-400/10" onclick="P.ctl('stop')" title="Stop">■</button><div class="ml-auto flex items-center gap-2"><button class="h-11 w-12 border border-white/10 text-lg hover:border-amber-300" onclick="document.getElementById('q').scrollIntoView({behavior:'smooth'})" title="List">📋</button><button id="loopb" class="h-11 border border-white/10 px-3 text-xs hover:border-amber-300" onclick="P.loop()">Loop · Off</button></div></div>
<div class="mt-5 flex flex-wrap items-center gap-3 border-t border-white/5 pt-5"><label class="font-mono text-xs text-zinc-500" for="vol">VOLUME</label><input id="vol" class="min-w-32 flex-1 accent-amber-300" type="range" min="0" max="200" value="100"><button class="border border-white/10 px-3 py-2 text-xs hover:border-amber-300" onclick="P.vol()">Apply</button></div><div class="mt-5 flex gap-2"><input id="q2" type="text" placeholder="Search or paste a link" class="min-w-0 flex-1 border border-white/10 bg-[#090c10] px-3 py-3 text-sm placeholder:text-zinc-600"><button class="bg-amber-300 px-4 py-3 text-sm font-semibold text-zinc-950 hover:bg-amber-200" onclick="P.play()">Queue</button></div><p id="msg" class="mt-3 min-h-5 text-xs text-zinc-500 truncate" title=""></p></div>
<aside class="border border-white/10 bg-[#10151b] p-4 sm:p-6 md:sticky md:top-6 md:max-h-[calc(100vh-3rem)] md:overflow-y-auto" data-aos="fade-up" data-aos-delay="100"><div class="mb-4 flex items-end justify-between"><div><p class="font-mono text-[10px] uppercase text-zinc-500">Next tracks</p><h2 class="mt-1 text-lg font-semibold">Up next</h2></div><span class="text-amber-300">☷</span></div><ol id="q" class="divide-y divide-white/5 text-sm text-zinc-300"></ol></aside></section></main>
<script src="https://unpkg.com/aos@2.3.4/dist/aos.js"></script><script>
var PG={g:[],id:"",snap:null,snapAt:0};
function say(t){document.getElementById("msg").textContent=t;}
function gid(){var s=document.getElementById("srv");return s&&s.value?s.value:"";}
async function api(p,d){var r=await fetch(p,{method:d?"POST":"GET",headers:{"Content-Type":"application/json"},body:d?JSON.stringify(d):undefined});var j=null;try{j=await r.json();}catch(e){}if(!r.ok||(j&&j.error))throw new Error((j&&j.error)||("HTTP "+r.status));return j;}
async function load(){try{var g=await(await fetch("/api/guilds")).json();PG.g=g;var s=document.getElementById("srv");var keep=s.value;s.innerHTML="";g.forEach(function(x){var o=document.createElement("option");o.value=x.id;o.textContent=x.name;if(x.id===keep)o.selected=true;s.appendChild(o);});if(!s.value&&g.length)s.value=g[0].id;chans();refresh();}catch(e){say("load failed: "+e.message);}}
function cur(){var id=gid();for(var i=0;i<PG.g.length;i++)if(PG.g[i].id===id)return PG.g[i];return null;}
function chans(){var g=cur();var c=document.getElementById("chn");c.innerHTML="";if(!g)return;(g.voice||[]).forEach(function(x){var o=document.createElement("option");o.value=x.id;o.textContent=x.name+" · "+x.members;if(g.botVC===x.id)o.selected=true;c.appendChild(o);});}
var P={
join:async function(){try{var j=await api("/api/join",{guildId:gid(),channelId:document.getElementById("chn").value});say("Joined "+j.channel);load();}catch(e){say("Join failed: "+e.message);}},
leave:async function(){try{await api("/api/leave",{guildId:gid()});say("Left voice");load();}catch(e){say(e.message);}},
play:async function(){var q=document.getElementById("q2").value;if(!q){say("Enter a song first.");return;}try{var j=await api("/api/play",{guildId:gid(),query:q});say("Queued: "+j.title);document.getElementById("q2").value="";refresh();}catch(e){say("Queue failed: "+e.message);}},
ctl:async function(a){try{var j=await api("/api/ctl",{guildId:gid(),action:a});say(j.result);refresh();}catch(e){say(e.message);}},
toggle:async function(){var g=cur();var paused=g&&g.player==="paused";try{var j=await api("/api/ctl",{guildId:gid(),action:paused?"resume":"pause"});say(j.result);refresh();}catch(e){say(e.message);}},
loop:async function(){var g=cur();var nx=g&&g.loop==="off"?"track":(g&&g.loop==="track"?"queue":"off");try{await api("/api/loop",{guildId:gid(),mode:nx});refresh();}catch(e){say(e.message);}},
vol:async function(){try{var j=await api("/api/volume",{guildId:gid(),value:Number(document.getElementById("vol").value)});say("Volume "+j.result+"%");refresh();}catch(e){say(e.message);}}
};
async function refresh(){if(!gid())return;try{PG.g=await(await fetch("/api/guilds")).json();PG.snap=cur();PG.snapAt=Date.now();paint();}catch(e){}}
function paint(){var g=PG.snap;if(!g)return;var n=g.nowPlaying;document.getElementById("ttl").textContent=n?n.title:"\\u2014 idle \\u2014";document.getElementById("by").textContent=n?"Requested by "+n.by:"Choose a server and queue a track.";var c=document.getElementById("cover");var ph=document.getElementById("cover-ph");if(n&&n.thumb){c.classList.remove("hidden");ph.classList.add("hidden");if(c.getAttribute("src")!==n.thumb)c.src=n.thumb;}else{c.classList.add("hidden");ph.classList.remove("hidden");}
var lc=document.getElementById("lyrics-container");if(n&&n.lyrics&&n.lyrics.synced&&n.lyrics.synced.length){lc.classList.remove("hidden");if(lc.dataset.title!==n.title){lc.innerHTML="";lc.dataset.title=n.title;n.lyrics.synced.forEach(function(l){var p=document.createElement("p");p.className="lyric-line transition-all duration-300";p.dataset.time=l.t;p.textContent=l.text||"♪";lc.appendChild(p);});}var sp=n.speed||1;var base=n.posBase||0;var t0=n.startedAt||PG.snapAt;var el=base+Math.max(0,(Date.now()-t0)/1000)*sp;var lines=Array.from(lc.children);var aIdx=-1;for(var i=0;i<lines.length;i++){if(parseFloat(lines[i].dataset.time)<=el)aIdx=i;else break;}lines.forEach(function(p,i){if(i===aIdx){if(!p.classList.contains("active")){p.classList.add("active");p.style.color="#fcd34d";p.style.transform="scale(1.1)";lc.scrollTop=p.offsetTop-lc.offsetTop-(lc.clientHeight/2)+(p.clientHeight/2);}}else{p.classList.remove("active");p.style.color="";p.style.transform="";}});}else{lc.classList.add("hidden");lc.dataset.title="";}
var dur=n&&n.durationSec?n.durationSec:null;var spp=(n&&n.speed)||1;var bs=(n&&n.posBase)||0;var t0b=(n&&n.startedAt)?n.startedAt:PG.snapAt;var elb=bs+Math.max(0,(Date.now()-t0b)/1000)*spp;document.getElementById("tcur").textContent=fmtT(elb);if(dur){document.getElementById("tdur").textContent=fmtT(dur);var pct=Math.max(0,Math.min(100,elb/dur*100));document.getElementById("tfill").style.width=pct+"%";document.getElementById("timebar").title="Click to seek";}else{document.getElementById("tdur").innerHTML="<span id=\\'live-dot\\' style=\\'display:inline-block;width:8px;height:8px;border-radius:50%;background:#fcd34d;margin-right:4px;animation:live-pulse 1.5s ease-in-out infinite\\'></span>LIVE";document.getElementById("tfill").style.width="100%";document.getElementById("tfill").style.opacity="0.25";document.getElementById("timebar").title="Live stream — cannot seek";}
document.getElementById("pp").textContent=g.player==="paused"?"▶️":"⏸️";document.getElementById("loopb").textContent="Loop · "+g.loop;var v=document.getElementById("vol");if(document.activeElement!==v)v.value=g.volume;var q=document.getElementById("q");q.innerHTML="";(g.queue||[]).forEach(function(x){var li=document.createElement("li");li.className="flex gap-3 py-3";var index=document.createElement("span");index.className="font-mono text-xs text-amber-300";index.textContent=String(q.children.length+1).padStart(2,"0");var title=document.createElement("span");title.className="min-w-0 truncate";title.textContent=x.title||"";li.appendChild(index);li.appendChild(title);q.appendChild(li);});if(!q.children.length){var empty=document.createElement("li");empty.className="py-4 text-sm text-zinc-500";empty.textContent="Queue is empty";q.appendChild(empty);}}
function fmtT(s){if(s==null||!isFinite(s)||s<0)return"• LIVE";s=Math.floor(s);var m=Math.floor(s/60);s=s%60;return m+":"+(s<10?"0":"")+s;}
document.getElementById("timebar").addEventListener("click",async function(ev){var g=cur();if(!g||!g.nowPlaying||!g.nowPlaying.durationSec){say("Live stream — cannot seek");return;}var r=this.getBoundingClientRect();var ratio=Math.max(0,Math.min(1,(ev.clientX-r.left)/r.width));var sec=Math.floor(ratio*g.nowPlaying.durationSec);try{await api("/api/seek",{guildId:gid(),seconds:sec});say("Seek → "+fmtT(sec));refresh();}catch(e){say(e.message);}});
document.getElementById("srv").addEventListener("change",function(){chans();refresh();});if(window.AOS)AOS.init({once:true,duration:520,offset:22,disable:window.matchMedia("(prefers-reduced-motion: reduce)").matches});setInterval(refresh,5000);setInterval(paint,500);load();
</script></body></html>`;
}