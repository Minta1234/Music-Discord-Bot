// index.js
require("dotenv").config();
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// --- Spotify link support (no direct Spotify audio streaming) ---
// Accept Spotify TRACK/EPISODE URLs/URIs and convert to a YouTube search query.
function isSpotifyUrl(s) {
  return typeof s === "string" && (s.includes("open.spotify.com/") || s.startsWith("spotify:"));
}
function normalizeSpotifyUrl(input) {
  if (!input || typeof input !== "string") return null;
  const m = input.match(/^spotify:(track|album|playlist|episode):([A-Za-z0-9]+)$/);
  if (m) return `https://open.spotify.com/${m[1]}/${m[2]}`;
  return input.replace(/^<|>$/g, "");
}
function spotifyKind(url) {
  const u = normalizeSpotifyUrl(url);
  if (!u) return null;
  const m = u.match(/open\.spotify\.com\/(track|album|playlist|episode)\/([A-Za-z0-9]+)/i);
  return m ? m[1].toLowerCase() : null;
}
async function fetchJsonWithTimeout(url, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "Accept": "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}
async function spotifyTitle(input) {
  const url = normalizeSpotifyUrl(input);
  const kind = spotifyKind(url);
  if (!kind) return null;
  const oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`;
  const data = await fetchJsonWithTimeout(oembedUrl, 8000);
  return data?.title ? String(data.title) : null;
}
async function spotifyTrackToSearchQuery(input) {
  const url = normalizeSpotifyUrl(input);
  const kind = spotifyKind(url);
  if (kind !== "track" && kind !== "episode") return null;
  const t = await spotifyTitle(url);
  if (!t) return null;
  return `${t} audio`;
}
// --- end Spotify support ---

// --- TikTok via TikWM (metadata + direct audio stream, no yt-dlp) ---
function aiSystemInstruction(persona = "") {
  const identity = "Your name is Bocchi (ぼっち). You are the AI assistant in this Discord music bot. If asked your name, say Bocchi (ぼっち).";
  return persona ? `${identity}\n\nChat-specific persona:\n${persona}` : identity;
}
const GEMINI_QUOTA_COOLDOWN_MS = 15 * 60 * 1000;
let geminiQuotaCooldownUntil = 0;
async function askOpenRouter(question, history = [], persona = "") {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const messages = [{ role: "system", content: aiSystemInstruction(persona) }];
    for (const entry of history) {
      const content = Array.isArray(entry?.parts) ? entry.parts.map((part) => part?.text || "").join("") : "";
      if (content) messages.push({ role: entry.role === "model" ? "assistant" : "user", content });
    }
    messages.push({ role: "user", content: question });
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${config.openRouterApiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://discord.com",
        "X-Title": "Discord Music Bot",
      },
      body: JSON.stringify({ model: config.openRouterModel, messages, max_tokens: 1024 }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = data?.error?.message;
      throw new Error(`OpenRouter request failed (HTTP ${response.status})${detail ? `: ${String(detail).slice(0, 500)}` : ""}`);
    }
    const answer = data?.choices?.[0]?.message?.content;
    if (typeof answer !== "string" || !answer.trim()) throw new Error("OpenRouter returned no answer.");
    const text = answer.trim();
    return text.length > 1900 ? text.slice(0, 1897) + "..." : text;
  } finally {
    clearTimeout(timeout);
  }
}
async function askGemini(question, history = [], persona = "") {
  if (!config.geminiApiKey) return askOpenRouter(question, history, persona);
  if (Date.now() < geminiQuotaCooldownUntil) {
    if (config.openRouterApiKey) return askOpenRouter(question, history, persona);
    throw new Error("Gemini quota limit reached. Please try again after the cooldown.");
  }
  const models = ["gemini-3.8-flash", "gemini-3.5-flash-lite"];
  let geminiError = null;
  for (let i = 0; i < models.length; i++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${models[i]}:generateContent`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": config.geminiApiKey,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: aiSystemInstruction(persona) }] },
          contents: [...history, { role: "user", parts: [{ text: question }] }],
          generationConfig: { maxOutputTokens: 1024 },
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const detail = data?.error?.message;
        const error = new Error(`Gemini request failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 500)}` : ""}`);
        error.status = response.status;
        throw error;
      }
      const answer = data?.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || "")
        .join("")
        .trim();
      if (!answer) throw new Error("Gemini returned no answer. Try rephrasing your question.");
      return answer.length > 1900 ? answer.slice(0, 1897) + "..." : answer;
    } catch (error) {
      geminiError = error;
      if (error?.status === 429) {
        geminiQuotaCooldownUntil = Date.now() + GEMINI_QUOTA_COOLDOWN_MS;
        logPretty("WARN", "Gemini returned HTTP 429; pausing Gemini requests for 15 minutes");
        break;
      }
      if (i === 0 && [500, 502, 503, 504].includes(error?.status)) {
        logPretty("WARN", `Gemini ${models[i]} unavailable (HTTP ${error.status}); trying ${models[i + 1]}`);
        continue;
      }
      break;
    } finally {
      clearTimeout(timeout);
    }
  }
  if (config.openRouterApiKey) {
    logPretty("WARN", `Gemini unavailable; falling back to OpenRouter (${config.openRouterModel})`);
    return askOpenRouter(question, history, persona);
  }
  throw geminiError || new Error("Gemini request failed. Please try again later.");
}
function aiHistoryPath() { return path.join(config.dataDir, "ai-chat-history.json"); }
function aiPersonasPath() { return path.join(config.dataDir, "ai-chat-personas.json"); }
function loadAiHistories() {
  try {
    const data = JSON.parse(fs.readFileSync(aiHistoryPath(), "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}
function loadAiPersonas() {
  try {
    const data = JSON.parse(fs.readFileSync(aiPersonasPath(), "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}
function saveAiPersonas(personas) {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(aiPersonasPath(), JSON.stringify(personas), "utf8");
  } catch (error) {
    logPretty("WARN", "Could not persist AI chat personas: " + (error?.message || error));
  }
}
function getAiPersona(sessionKey) {
  const persona = loadAiPersonas()[sessionKey];
  return typeof persona === "string" ? persona : "";
}
function setAiPersona(sessionKey, persona) {
  const personas = loadAiPersonas();
  if (persona) personas[sessionKey] = persona;
  else delete personas[sessionKey];
  saveAiPersonas(personas);
}
function saveAiHistories(histories) {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(aiHistoryPath(), JSON.stringify(histories), "utf8");
  } catch (error) {
    logPretty("WARN", "Could not persist AI chat history: " + (error?.message || error));
  }
}
async function askGeminiWithHistory(question, sessionKey) {
  const histories = loadAiHistories();
  const previous = Array.isArray(histories[sessionKey])
    ? histories[sessionKey].filter((entry) =>
      ["user", "model"].includes(entry?.role) && Array.isArray(entry.parts) && entry.parts.every((part) => typeof part?.text === "string"))
    : [];
  const answer = await askGemini(question, previous, getAiPersona(sessionKey));
  histories[sessionKey] = [...previous, { role: "user", parts: [{ text: question }] }, { role: "model", parts: [{ text: answer }] }].slice(-20);
  saveAiHistories(histories);
  return answer;
}
async function clearGuildAiChats(guildId) {
  const histories = loadAiHistories();
  let clearedHistories = 0;
  for (const key of Object.keys(histories)) {
    if (key === `slash:${guildId}` || key.startsWith(`slash:${guildId}:`) || key.startsWith(`channel:${guildId}:`)) {
      delete histories[key];
      clearedHistories++;
    }
  }
  saveAiHistories(histories);
  const personas = loadAiPersonas();
  for (const key of Object.keys(personas)) {
    if (key === `slash:${guildId}` || key.startsWith(`slash:${guildId}:`) || key.startsWith(`channel:${guildId}:`) || key.startsWith(`private:${guildId}:`)) delete personas[key];
  }
  saveAiPersonas(personas);

  let closedPrivateChats = 0;
  for (const [threadId, session] of privateAiSessions) {
    if (session.guildId !== guildId) continue;
    privateAiSessions.delete(threadId);
    aiChatBusy.delete(`private:${threadId}`);
    try { await session.thread.delete("AI chats cleared by a server admin"); } catch { }
    closedPrivateChats++;
  }
  return { clearedHistories, closedPrivateChats };
}
const API_URL = 'https://www.tikwm.com/api/';
function isTikTokUrl(s) {
  return typeof s === "string" && (s.includes("tiktok.com") || s.includes("vt.tiktok.com"));
}
// Fetch ONLY song metadata + stream link from TikWM.
async function tiktokMeta(pageUrl, retries = 1) {
  try {
    return await tiktokMetaOnce(pageUrl);
  } catch (e) {
    // TikWM free tier: 1 request/second — wait and retry once.
    if (retries > 0 && /1 request\/second|429|rate/i.test(String(e?.message || e))) {
      await new Promise((r) => setTimeout(r, 1300));
      return await tiktokMetaOnce(pageUrl);
    }
    throw e;
  }
}
async function tiktokMetaOnce(pageUrl) {
  const data = await fetchJsonWithTimeout(API_URL + '?url=' + encodeURIComponent(pageUrl), 12000);
  const d = data && data.data;
  if (!d) throw new Error('tikwm: ' + ((data && data.msg) || 'bad response'));
  const music = typeof d.music === "string" ? d.music
    : (d.music && (d.music.play || d.music.url)) || (d.music_info && (d.music_info.play || d.music_info.url));
  if (!music) throw new Error('tikwm: no audio stream in response');
  const title = d.title || (d.music_info && d.music_info.title) || pageUrl;
  const thumb = d.cover || d.origin_cover || d.ai_dynamic_cover || null;
  const author = (d.author && (d.author.nickname || d.author.unique_id)) || null;
  const videoId = d.id ? String(d.id) : null;
  // TikWM proxy URL works from any IP (incl. cloud/Railway);
  // TikTok CDN URL (music) is blocked on datacenter IPs.
  const proxyAudioUrl = videoId ? `https://www.tikwm.com/video/music/${videoId}.mp3` : null;
  return { title: String(title), thumb, audioUrl: String(music), proxyAudioUrl, videoId, duration: d.duration || null, author };
}
function tiktokHeaders() {
  return "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36\r\n"
    + "Referer: https://www.tiktok.com/\r\n";
}
// --- end TikTok support ---

/* Clamp negative or invalid timer delays to 1 ms to avoid TimeoutNegativeWarning. */

(() => {
  // Convert delay into a non‑negative integer; invalid values are clamped to 1 ms.
  function sanitizeDelay(delay) {
    const n = Number(delay);
    return Number.isFinite(n) && n >= 0 ? n : 1;
  }
  const _setTimeout = global.setTimeout;
  const _setInterval = global.setInterval;
  global.setTimeout = function (fn, delay, ...args) {
    return _setTimeout(fn, sanitizeDelay(delay), ...args);
  };
  global.setInterval = function (fn, delay, ...args) {
    return _setInterval(fn, sanitizeDelay(delay), ...args);
  };
})();

/* Configuration: read settings from environment variables with sensible defaults. */
const config = {
  // Port for the HTTP keep‑alive server
  port: Number(process.env.PORT) || 3000,
  // Discord bot token – MUST be set in the environment; if missing, the bot
  // will still attempt to start but login will fail.
  token: process.env.TOKEN || "",
  // Gemini API key used by the /ai command.
  geminiApiKey: process.env.GEMINI_API_KEY || process.env.Gemini_api_key || process.env.Gemini_api_kei || "",
  // Optional OpenRouter fallback for Gemini errors/quota exhaustion.
  openRouterApiKey: process.env.OPENROUTER_API_KEY || process.env.OpenRouter_API || "",
  openRouterModel: (process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini").trim(),
  // Optional explicit path to ffmpeg; if empty, ffmpeg-static or system ffmpeg is used
  ffmpegPath: process.env.FFMPEG_PATH || null,
  // Path to a yt-dlp cookies file; used for age/region restricted videos
  cookieFile: process.env.YTDLP_COOKIES_PATH || null,
  // Directory to store log files; relative paths are resolved from cwd
  logDir: process.env.LOG_DIR || path.join(process.cwd(), "logs"),
  // Directory to store data files (e.g., yt-dlp update marker)
  dataDir: process.env.DATA_DIR || path.join(process.cwd(), "data"),
  // Whether to show detailed ffmpeg logs in the console
  debugFfmpeg: (process.env.DEBUG_FFMPEG || "false").toLowerCase() === "true",
  // Default volume percentage when a guild state is created (0–1000)
  defaultVolume: Math.max(0, Math.min(1000, Number(process.env.DEFAULT_VOLUME) || 100)),
  // Default loop mode: off | track | queue
  defaultLoop: (() => {
    const raw = (process.env.DEFAULT_LOOP_MODE || "off").toLowerCase();
    return ["off", "track", "queue"].includes(raw) ? raw : "off";
  })(),
  // Timezone offset for scheduling yt-dlp updates, in hours (e.g. 7 for Bangkok)
  timezoneOffsetHours: Number(process.env.TIMEZONE_OFFSET_HOURS) || 7,
  // Force yt-dlp to use IPv4 instead of IPv6
  ytdlpForceIpv4: (process.env.YTDLP_FORCE_IPV4 || "true").toLowerCase() === "true",
  // Whether to automatically update yt-dlp at midnight local time
  ytdlpAutoUpdate: (process.env.YTDLP_AUTO_UPDATE || "true").toLowerCase() === "true",

  // Hard cap for /playlist to prevent excessive memory/time usage
  playlistHardCap: Math.max(1, Number(process.env.PLAYLIST_HARD_CAP) || 5000),

  // ===== Audio quality controls (.env) =====
  audioChannels: Math.min(2, Math.max(1, Number(process.env.AUDIO_CHANNELS) || 2)),
  audioSampleRate: Number(process.env.AUDIO_SAMPLE_RATE) || 48000,
  opusBitrate: (process.env.OPUS_BITRATE || "128k").toLowerCase(),
  opusVbr: (process.env.OPUS_VBR || "on").toLowerCase(),
  opusApplication: (process.env.OPUS_APPLICATION || "audio").toLowerCase(),
  opusFrameDuration: Number(process.env.OPUS_FRAME_DURATION) || 20,
  opusComplexity: Math.max(0, Math.min(10, Number(process.env.OPUS_COMPLEXITY) || 8)),
  audioFilter: process.env.AUDIO_FILTER || "",
  ffmpegLowLatency: (process.env.FFMPEG_LOW_LATENCY || "true").toLowerCase() === "true",
  ffmpegInputAnalyzeMs: Math.max(0, Number(process.env.FFMPEG_INPUT_ANALYZE_MS) || 0),
  ffmpegReconnectDelayMax: Math.max(1, Number(process.env.FFMPEG_RECONNECT_DELAY_MAX) || 10),
  ffmpegExtraArgs: process.env.FFMPEG_EXTRA_ARGS || "",
  // ===== Web dashboard login (.env) =====
  dashboardUser: (process.env.DASHBOARD_USER || "admin").trim() || "admin",
  dashboardPassword: process.env.DASHBOARD_PASSWORD || "",
  // Seconds to stay in voice after queue ends before disconnecting (new songs cancel it)
  disconnectDelaySec: Math.max(10, Number(process.env.DISCONNECT_DELAY_SEC) || 300),
  // YouTube player clients for yt-dlp. "web,web_creator" is strictest (often
  // demands sign-in); "android" usually works WITHOUT cookies. The bot
  // auto-retries a failed song with the other client, so cookies are optional.
  ytdlpPlayerClient: (process.env.YTDLP_PLAYER_CLIENT || "web,web_creator").trim() || "web,web_creator",
  // Pre-buffer before handing audio to Discord: smoother start, survives yt-dlp slow-start.
  // KB of opus audio to cushion (≈16KB ≈ 1s at 128k) + max wait before playing anyway.
  prebufferKB: Math.max(0, Number(process.env.PREBUFFER_KB) || 64),
  prebufferWaitMs: Math.max(500, Number(process.env.PREBUFFER_WAIT_MS) || 4000),
};

// Print out a summary of the configuration and environment variables. Sensitive
// values such as the bot token are not printed directly; instead we indicate
// whether they are set. This runs immediately so users can verify their
// `.env` settings when starting the bot.
function logConfiguration() {
  const entries = [
    { key: "port", env: "PORT" },
    { key: "token", env: "TOKEN", mask: true },
    { key: "geminiApiKey", env: "GEMINI_API_KEY", mask: true },
    { key: "openRouterApiKey", env: "OPENROUTER_API_KEY", mask: true },
    { key: "openRouterModel", env: "OPENROUTER_MODEL" },
    { key: "ffmpegPath", env: "FFMPEG_PATH" },
    { key: "cookieFile", env: "YTDLP_COOKIES_PATH" },
    { key: "logDir", env: "LOG_DIR" },
    { key: "dataDir", env: "DATA_DIR" },
    { key: "debugFfmpeg", env: "DEBUG_FFMPEG" },
    { key: "defaultVolume", env: "DEFAULT_VOLUME" },
    { key: "defaultLoop", env: "DEFAULT_LOOP_MODE" },
    { key: "timezoneOffsetHours", env: "TIMEZONE_OFFSET_HOURS" },
    { key: "ytdlpForceIpv4", env: "YTDLP_FORCE_IPV4" },
    { key: "ytdlpAutoUpdate", env: "YTDLP_AUTO_UPDATE" },
    { key: "audioChannels", env: "AUDIO_CHANNELS" },
    { key: "audioSampleRate", env: "AUDIO_SAMPLE_RATE" },
    { key: "opusBitrate", env: "OPUS_BITRATE" },
    { key: "opusVbr", env: "OPUS_VBR" },
    { key: "opusApplication", env: "OPUS_APPLICATION" },
    { key: "opusFrameDuration", env: "OPUS_FRAME_DURATION" },
    { key: "opusComplexity", env: "OPUS_COMPLEXITY" },
    { key: "audioFilter", env: "AUDIO_FILTER" },
    { key: "ffmpegLowLatency", env: "FFMPEG_LOW_LATENCY" },
    { key: "ffmpegInputAnalyzeMs", env: "FFMPEG_INPUT_ANALYZE_MS" },
    { key: "ffmpegReconnectDelayMax", env: "FFMPEG_RECONNECT_DELAY_MAX" },
    { key: "ffmpegExtraArgs", env: "FFMPEG_EXTRA_ARGS" },
    { key: "dashboardUser", env: "DASHBOARD_USER" },
    { key: "dashboardPassword", env: "DASHBOARD_PASSWORD", mask: true },
    { key: "disconnectDelaySec", env: "DISCONNECT_DELAY_SEC" },
    { key: "ytdlpPlayerClient", env: "YTDLP_PLAYER_CLIENT" },
    { key: "prebufferKB", env: "PREBUFFER_KB" },
    { key: "prebufferWaitMs", env: "PREBUFFER_WAIT_MS" },
  ];
  // We want to simulate loading the .env file by printing a message
  // and waiting a short time before outputting the configuration.  Using
  // an Atomics.wait call lets us block synchronously without complicating
  // the asynchronous flow elsewhere in the program.  This approach
  // guarantees that the loading message appears before the variables
  // themselves, and avoids interleaving logs due to unresolved promises.
  console.log("--------------------------------");
  // Thai text explains the wait – it will show up in the console to
  // indicate a brief pause while reading the .env file.
  console.log(
    "[BOT] loading .env"
  );
  console.log("--------------------------------");
  // Block for 1000ms to simulate reading the .env file
  try {
    const sab = new SharedArrayBuffer(4);
    const ia = new Int32Array(sab);
    // Atomics.wait returns 'timed-out' when the timeout expires
    Atomics.wait(ia, 0, 0, 1000);
  } catch {
    // Fall back to a non-blocking setTimeout if Atomics.wait is unavailable
    const end = Date.now() + 1000;
    while (Date.now() < end) {
      // busy loop
    }
  }
  for (const entry of entries) {
    const used = config[entry.key];
    let displayValue;
    if (entry.mask) {
      displayValue = used ? "[set]" : "[not set]";
    } else {
      displayValue = used;
    }
    // Print in the form "<ENV_NAME>:<value>" with a single leading space
    console.log(` ${entry.env}:${displayValue}`);
    console.log("--------------------------------");
  }
}
// Invoke the configuration logger early so users see settings on startup
logConfiguration();
console.log("[BOT] Starting now");
console.log("--------------------------------")
const http = require("http");
const { spawn, spawnSync } = require("child_process");
const { PassThrough, Readable } = require("stream");

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  InviteTargetType,
  MessageFlags,
  ChannelType,
} = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  getVoiceConnection,
  demuxProbe,
  VoiceConnectionStatus,
} = require("@discordjs/voice");

try { require("@snazzah/davey"); } catch { /* optional */ }

// Web dashboard (login + YouTube sign-in via cookies) starts at bottom of file
// after guildStates/client are defined — see startDashboard().
// ffmpeg setup and availability
let FFMPEG = null;
let FFMPEG_AVAILABLE = false;
// Determine the ffmpeg binary. If the user specifies a custom path via
// configuration, prefer that. Otherwise fall back to ffmpeg-static and
// finally to the system ffmapeg.
try {
  if (config.ffmpegPath) {
    // Use the explicit path provided in config
    FFMPEG = config.ffmpegPath;
    FFMPEG_AVAILABLE = true;
  } else {
    // Attempt to load the ffmpeg-static module
    FFMPEG = require("ffmpeg-static");
    if (FFMPEG) FFMPEG_AVAILABLE = true;
  }
} catch { }

// yt-dlp and cookie configuration
const ytdlp = require("yt-dlp-exec");
// Resolve the actual yt-dlp binary path so we can spawn it as a child process.
// spawn("yt-dlp") fails on most hosts because the binary lives inside node_modules,
// not on the system PATH.
const YTDLP_BIN = (() => {
  try {
    const m = require("yt-dlp-exec");
    if (m && typeof m.raw === "string") return m.raw;
    if (m && typeof m.path === "string") return m.path;
  } catch { }
  for (const rel of ["yt-dlp-exec/yt-dlp", "yt-dlp-exec/bin/yt-dlp"]) {
    try { return require.resolve(rel); } catch { }
  }
  return "yt-dlp"; // last resort — hope it's on PATH
})();
// Build yt-dlp option defaults based off of the configuration. Cookies and
// force-ipv4 can be toggled via .env.
function ytdlpOpts(extra = {}) {
  const base = {
    // Skip certificate validation; yt-dlp defaults to secure connections but this avoids SSL errors
    noCheckCertificates: true,
    // Retry endlessly for robust downloads
    retries: "infinite",
    "fragment-retries": "infinite",
    // Respect configured IPv4 forcing
    "force-ipv4": config.ytdlpForceIpv4,
    "js-runtimes": "node",
  };
  const ck = effectiveCookieFile();
  if (ck) base.cookies = ck;
  // Never expand playlists from a single video URL (huge slowdown on long videos)
  base["no-playlist"] = true;
  return { ...base, ...extra };
}

// Logging setup
// Ensure log directory exists based on configuration
const LOG_DIR = config.logDir;
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
// Log files:
//   bot.log        — general activity (COMMAND, MUSIC, INFO, SYSTEM)
//   bot-error.log  — ERROR and WARN only → check when troubleshooting
//   bot-debug.log  — everything incl. ffmpeg output → for deep debugging
const LOG_FILE_MAIN = path.join(LOG_DIR, "bot.log");
const LOG_FILE_ERROR = path.join(LOG_DIR, "bot-error.log");
const LOG_FILE_DEBUG = path.join(LOG_DIR, "bot-debug.log");

// ─── ANSI colour palette ────────────────────────────────────────────────────
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  // foreground
  white: "\x1b[97m",
  gray: "\x1b[90m",
  cyan: "\x1b[96m",
  green: "\x1b[92m",
  yellow: "\x1b[93m",
  red: "\x1b[91m",
  magenta: "\x1b[95m",
  blue: "\x1b[94m",
  // background
  bgBlue: "\x1b[44m",
  bgGreen: "\x1b[42m",
  bgRed: "\x1b[41m",
  bgYellow: "\x1b[43m",
  bgCyan: "\x1b[46m",
  bgMagenta: "\x1b[45m",
  bgGray: "\x1b[100m",
};
const R = C.reset;

// ─── Timestamp ───────────────────────────────────────────────────────────────
function nowStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function nowStrShort() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ─── WS ping helper ──────────────────────────────────────────────────────────
let _clientForPing = null;
function wsPing() {
  try { return Math.round(_clientForPing?.ws?.ping || 0); } catch { return 0; }
}

// ─── File logger (plain text, no ANSI) ───────────────────────────────────────
function writeLog(plain, isDebug = false, type = "") {
  // bot-debug.log — always receives everything (incl. ffmpeg)
  try { fs.appendFileSync(LOG_FILE_DEBUG, plain + "\n", "utf8"); } catch { }

  // bot-error.log — ERROR and WARN only
  if (type === "ERROR" || type === "WARN") {
    try { fs.appendFileSync(LOG_FILE_ERROR, plain + "\n", "utf8"); } catch { }
  }

  // bot.log — everything except ffmpeg debug
  if (!isDebug) {
    try { fs.appendFileSync(LOG_FILE_MAIN, plain + "\n", "utf8"); } catch { }
  }
}

// ─── Log type config ─────────────────────────────────────────────────────────
//  Each entry: { icon, label, labelColor, bgColor }
const LOG_TYPES = {
  COMMAND: { icon: "❯", label: "CMD", fg: C.cyan, bg: C.bgCyan },
  PREFIX: { icon: "❯", label: "PREFIX", fg: C.blue, bg: C.bgBlue },
  NOWPLAY: { icon: "♪", label: "MUSIC", fg: C.green, bg: C.bgGreen },
  ERROR: { icon: "✖", label: "ERROR", fg: C.red, bg: C.bgRed },
  WARN: { icon: "!", label: "WARN", fg: C.yellow, bg: C.bgYellow },
  INFO: { icon: "i", label: "INFO", fg: C.magenta, bg: C.bgMagenta },
  LOG: { icon: "·", label: "DEBUG", fg: C.gray, bg: C.bgGray },
  SYSTEM: { icon: "⚙", label: "SYSTEM", fg: C.white, bg: C.bgGray },
};

// ─── Main pretty logger ───────────────────────────────────────────────────────
//
//  Output format (one line):
//  HH:MM:SS  ▌ TYPE ▌  message details
//
//  extra fields (all optional):
//    user    – Discord username
//    guild   – server name
//    rtt     – round-trip time ms (slash commands)
//    tail    – free-form suffix appended after the details
//
function logPretty(type, msg, extra = {}) {
  const cfg = LOG_TYPES[type] || LOG_TYPES.INFO;
  const isDebug = (type === "LOG");

  const ws = wsPing();
  const ts = `${C.dim}${C.gray}${nowStrShort()}${R}`;

  // ── badge ──  e.g.  ❯ CMD
  const badge = `${C.bold}${cfg.bg}\x1b[30m ${cfg.icon} ${cfg.label.padEnd(6)} ${R}`;

  // ── message body ──
  const body = `${C.bold}${cfg.fg}${msg}${R}`;

  // ── meta row: ping / rtt / user / guild ──
  const parts = [];
  parts.push(`${C.gray}ping ${C.white}${ws}ms${R}`);
  if (extra.rtt !== undefined) parts.push(`${C.gray}rtt ${C.white}${extra.rtt}ms${R}`);
  if (extra.user) parts.push(`${C.gray}user ${C.cyan}${extra.user}${R}`);
  if (extra.guild) parts.push(`${C.gray}srv ${C.white}${extra.guild}${R}`);
  if (extra.tail) parts.push(`${C.dim}${extra.tail}${R}`);
  const meta = parts.join(`  ${C.gray}·${R}  `);

  // ── assemble ──
  const sep = `${C.gray}│${R}`;
  const line = `${ts}  ${badge}  ${body}  ${sep}  ${meta}`;

  // plain version for file (strip ANSI)
  const plain = (`[${nowStr()}] [${cfg.label}] ${msg}` +
    ` | ping=${ws}ms` +
    (extra.rtt ? ` rtt=${extra.rtt}ms` : "") +
    (extra.user ? ` user=${extra.user}` : "") +
    (extra.guild ? ` srv=${extra.guild}` : "") +
    (extra.tail ? ` | ${extra.tail}` : "")
  ).replace(/\x1b\[[0-9;]*m/g, "");

  writeLog(plain, isDebug, type);
  if (!isDebug || DEBUG_FFMPEG) {
    console.log(line);
  }
}
function swallowPipeError(err) {
  const msg = String(err?.message || err || "");
  if (msg.includes("EPIPE") || msg.includes("ERR_STREAM_DESTROYED") || msg.includes("Premature close")) return;
  logPretty("ERROR", "pipe error: " + msg);
}
// Use the configured debug flag for ffmpeg logging
const DEBUG_FFMPEG = config.debugFfmpeg;

function checkFfmpegAvailability() {
  if (FFMPEG_AVAILABLE) return;
  try {
    const res = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
    if (!res.error && res.status === 0) {
      FFMPEG_AVAILABLE = true;
      return;
    }
  } catch { }
  logPretty("ERROR", "ffmpeg binary not found. Please install ffmpeg or add it to PATH.");
}

checkFfmpegAvailability();

// yt-dlp automatic update scheduling (Bangkok midnight)
const DATA_DIR = config.dataDir;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const UPDATE_MARK_FILE = path.join(DATA_DIR, "yt-dlp.last");
// Calculate timezone offset in milliseconds based on configuration (hours → ms)
const BKK_OFFSET_MS = config.timezoneOffsetHours * 60 * 60 * 1000;
let isUpdatingYtDlp = false;
function readLastUpdateTs() { try { return Number(fs.readFileSync(UPDATE_MARK_FILE, "utf8")); } catch { return 0; } }
function writeLastUpdateTs(ts = Date.now()) { try { fs.writeFileSync(UPDATE_MARK_FILE, String(ts), "utf8"); } catch { } }
async function runYtDlpUpdate(replyFn) {
  if (isUpdatingYtDlp) { replyFn?.("⏳ Update already in progress"); return; }
  isUpdatingYtDlp = true;
  const started = Date.now();
  try {
    try { await ytdlp("--version"); } catch { }
    const out = await ytdlp("-U").catch(err => ({ error: err }));
    if (out?.error) {
      logPretty("ERROR", `yt-dlp update failed: ${out.error.message || out.error}`);
      replyFn?.("❌ Update failed");
    } else {
      const stdout = typeof out === "string" ? out : (out?.stdout || "");
      logPretty("SYSTEM", `yt-dlp updated  ${stdout.toString().trim().split("\n").pop()}`);
      writeLastUpdateTs(started);
      replyFn?.("✅ Update finished");
    }
  } finally { isUpdatingYtDlp = false; }
}
function msUntilNextBangkokMidnight() {
  const now = new Date();
  const bkkNow = new Date(now.getTime() + BKK_OFFSET_MS);
  const nextMidnightBkkUTCms = Date.UTC(bkkNow.getUTCFullYear(), bkkNow.getUTCMonth(), bkkNow.getUTCDate() + 1, 0, 0, 0) - BKK_OFFSET_MS;
  return Math.max(1, nextMidnightBkkUTCms - now.getTime());
}
function scheduleDailyBangkokMidnight(fn) {
  const delay = msUntilNextBangkokMidnight();
  setTimeout(async () => {
    try {
      await fn();
    } finally {
      scheduleDailyBangkokMidnight(fn);
    }
  }, delay);
}

// Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});
_clientForPing = client;

// ================= Discord UI (buttons + YouTube sign-in) =================
function ytCookiesPath() {
  return config.cookieFile || path.join(config.dataDir, "cookies.txt");
}
function ytCookiesStatus() {
  const p = ytCookiesPath();
  try {
    const st = fs.statSync(p);
    return { path: p, exists: true, size: st.size, mtime: st.mtime.toISOString() };
  } catch { return { path: p, exists: false, size: 0, mtime: null }; }
}
function saveYTCookies(text) {
  const t = String(text || "").trim();
  if (!t || t.length < 100) throw new Error("cookies too short — paste full cookies.txt");
  if (!t.includes("youtube.com") && !t.includes("youtu.be")) throw new Error("no youtube.com entries found");
  // Must look like a Netscape cookies file, or yt-dlp rejects EVERYTHING.
  const lines = t.split("\n").filter((l) => l && !l.trim().startsWith("#"));
  if (!lines.length || !lines.some((l) => l.includes("\t"))) {
    throw new Error("not a Netscape cookies.txt (need tab-separated lines — export with 'Get cookies.txt LOCALLY', don't paste JSON)");
  }
  const target = ytCookiesPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, t.replace(/\r\n/g, "\n"), "utf8");
  config.cookieFile = target; // live, no restart
  logPretty("SYSTEM", `YouTube cookies updated via Discord (${t.length} chars -> ${target})`);
  return target;
}
function isGuildAdmin(member) {
  try {
    if (!member) return false;
    if (member.id === member.guild?.ownerId) return true;
    return member.permissions?.has?.(PermissionFlagsBits.ManageGuild);
  } catch { return false; }
}
function buildTransportRows(state = null) {
  const paused = state?.player?.state?.status === AudioPlayerStatus.Paused;
  const r1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("mus_prev").setLabel("Prev").setEmoji("⏮").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("mus_resume").setLabel(paused ? "Play" : "Pause").setEmoji(paused ? "▶" : "⏸").setStyle(paused ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("mus_skip").setLabel("Skip").setEmoji("⏭").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("mus_stop").setLabel("Stop").setEmoji("⏹").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("mus_queue").setLabel("List").setEmoji("📋").setStyle(ButtonStyle.Secondary),
  );
  const lyricsOn = state ? state.showLyrics !== false : true;
  const r2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("mus_loop").setLabel(`Loop: ${state ? loopLabel(state.loopMode).replace(/^[^\s]+\s/, "") : "Off"}`).setEmoji("🔁").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("mus_lyrics").setLabel(`Lyrics: ${lyricsOn ? "On" : "Off"}`).setEmoji("📝").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("mus_volup").setLabel("Vol +").setEmoji("🔊").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("mus_voldown").setLabel("Vol −").setEmoji("🔉").setStyle(ButtonStyle.Secondary),
  );
  return [r1, r2];
}
// Setup is done once the guild has both bocchi rooms (text + saved voice).
function isBocchiSetup(state) {
  const guild = state?.guildId ? client.guilds.cache.get(state.guildId) : null;
  if (!guild) return false;
  const hasText = guild.channels.cache.some((c) =>
    c.type === ChannelType.GuildText && c.name.toLowerCase() === "bocchi");
  return hasText && !!getSavedMusicVoice(guild.id);
}
// Settings row: always visible so a hidden-controls panel can be reopened.
// The /setup button hides itself once the bocchi rooms already exist.
function buildSettingsRow(state = null) {
  const shown = !state || state.showControls !== false;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("mus_controls").setLabel(`Controls: ${shown ? "Show" : "Hidden"}`).setEmoji("🎛").setStyle(ButtonStyle.Secondary),
  );
  // if (!isBocchiSetup(state)) {
  //   row.addComponents(new ButtonBuilder().setCustomId("mus_setup").setLabel("/setup").setEmoji("🛠").setStyle(ButtonStyle.Secondary));
  // }
  return row;
}
function buildControlRows(state = null) {
  const rows = [];
  const [r1, r2] = buildTransportRows(state);
  rows.push(r1);
  if (!state || state.showControls !== false) rows.push(r2);
  rows.push(buildSettingsRow(state));
  return rows;
}
function buildPanelEmbed(guild) {
  const st = getGuildState(guild);
  const cur = st.current ? `**${st.current.title}**\n👤 ${st.current.requestedBy}` : "— idle —\nuse `/play` to add songs";
  const next = st.queue.slice(0, 3).map((x, i) => `\`${i + 1}.\` ${x.title}`).join("\n") || "—";
  const ck = ytCookiesStatus();
  const room = getSavedControlChannel(guild.id) ? `<#${getSavedControlChannel(guild.id)}>` : "#bocchi (auto)";
  const panel = new EmbedBuilder().setColor(0x5865F2).setTitle("🎛 Music Panel — Settings")
    .setDescription("Press the buttons — you must share a voice channel with the bot\nAll bot messages live in " + room)
    .addFields(
      { name: "🎵 Now", value: cur, inline: false },
      { name: "📋 Next", value: next, inline: false },
      { name: "🔊 Volume", value: `${st.volumePct}%`, inline: true },
      { name: "🔁 Loop", value: loopLabel(st.loopMode), inline: true },
      { name: "📝 Lyrics", value: st.showLyrics !== false ? "On" : "Off", inline: true },
      { name: "🎛 Controls", value: st.showControls !== false ? "Show" : "Hidden", inline: true },
      { name: " Room", value: room, inline: true },
      { name: "🍪 YouTube", value: ck.exists ? `✅ signed in (${ck.size}b)` : "❌ not signed — admin, use `/ytsignin`", inline: true },
    ).setTimestamp();
  const pt = st.current ? (st.current.thumb || thumbFor(st.current.source)) : null;
  if (pt) panel.setThumbnail(pt);
  return panel;
}
// /setup in one place (slash, prefix, panel button): voice room "bocchi" +
// text room #bocchi (created when missing), then post the living panel there.
async function runBocchiSetup(guild) {
  let voiceRoom = guild.channels.cache.find((candidate) =>
    candidate.type === ChannelType.GuildVoice && candidate.name.toLowerCase() === "bocchi");
  if (!voiceRoom) {
    voiceRoom = await guild.channels.create({
      name: "bocchi",
      type: ChannelType.GuildVoice,
      reason: "Create the bocchi music room",
    });
  }
  setSavedMusicVoice(guild.id, voiceRoom.id);
  const state = getGuildState(guild);
  ensureVC(guild, voiceRoom.id, state);
  const channel = await resolveBotTextChannel(guild, null);
  if (!channel) throw new Error("I could not create or find #bocchi. Check Manage Channels, View Channel and Send Messages permissions.");
  const panel = state.current ? buildNowPlayingEmbed(state, state.currentLyrics) : buildPanelEmbed(guild);
  const ref = await upsertNpMessage(guild, channel.id, panel, true);
  if (!ref) throw new Error("I could not send the panel there. Check View Channel, Send Messages, and Embed Links permissions.");
  if (state.current) startNowPlayingTicker(guild, state);
  return { voiceRoom, channel };
}
// Re-render the living Now Playing message so button labels (loop/lyrics) stay live.
async function refreshNpControls(guild, state) {
  try {
    if (!state.npMessage) return;
    const embed = state.current ? buildNowPlayingEmbed(state, state.currentLyrics) : buildPanelEmbed(guild);
    await upsertNpMessage(guild, state.npMessage.channelId, embed, true);
  } catch (e) { logPretty("WARN", `Panel refresh failed: ${e?.message || e}`); }
}
async function handleMusicButton(itx) {
  const id = itx.customId;
  const guild = itx.guild;
  const state = getGuildState(guild);
  const me = guild.members.me;
  const userVC = itx.member?.voice?.channelId;
  const botVC = me?.voice?.channelId;
  const needsVC = !["mus_queue", "mus_panel", "mus_lyrics", "mus_controls", "mus_setup"].includes(id);
  if (needsVC && (!userVC || (botVC && botVC !== userVC))) {
    return itx.reply({ content: "Please join the bot's voice channel first 🎙️", flags: MessageFlags.Ephemeral });
  }
  logPretty("COMMAND", `BTN ${id}`, { user: itx.user.tag, guild: guild.name });
  if (id === "mus_pause") { try { state.player.pause(); } catch { } return itx.reply({ content: "⏸ Paused — press ▶ to resume", flags: MessageFlags.Ephemeral }); }
  if (id === "mus_prev") {
    try {
      const prev = (state.history || []).pop();
      if (!prev || !prev.source) return itx.reply({ content: "No previous track yet", flags: MessageFlags.Ephemeral });
      const g = itx.guild;
      const userVC = itx.member?.voice?.channelId;
      // Put the current track back at the front, previous ahead of it.
      if (state.current) {
        state.queue.unshift({ title: state.current.title, source: state.current.source, thumb: state.current.thumb || null, durationSec: state.current.durationSec || null, requestedBy: state.current.requestedBy, guild: g, voiceChannelId: state.current.voiceChannelId || userVC, textChannelId: state.current.textChannelId });
      }
      state.queue.unshift({ title: prev.title, source: prev.source, thumb: prev.thumb || null, durationSec: prev.durationSec || null, requestedBy: prev.requestedBy || itx.user.tag, guild: g, voiceChannelId: userVC, textChannelId: itx.channelId });
      state.skipRequested = true;
      state.prevJump = true;
      try { state.player.stop(true); } catch {}
      cleanupCurrentPipeline(state);
      return itx.reply({ content: `⏮ Back to **${cleanTitle(prev.title)}**`, flags: MessageFlags.Ephemeral });
    } catch (e) { return itx.reply({ content: "Previous failed: " + (e?.message || e), flags: MessageFlags.Ephemeral }); }
  }
  if (id === "mus_resume") {
    try {
      if (!state.current) return itx.reply({ content: "Nothing playing — use /play first", flags: MessageFlags.Ephemeral });
      // Single Play button toggles: reclick pauses, reclick again resumes.
      if (state.player.state.status === AudioPlayerStatus.Paused) {
        state.player.unpause();
        return itx.reply({ content: `▶ Playing: **${cleanTitle(state.current?.title || "—")}**`, flags: MessageFlags.Ephemeral });
      }
      state.player.pause();
      return itx.reply({ content: "⏸ Paused — press ▶ to resume", flags: MessageFlags.Ephemeral });
    } catch { return itx.reply({ content: "⏸ Paused", flags: MessageFlags.Ephemeral }); }
  }
  if (id === "mus_skip") { state.skipRequested = true; try { state.player.stop(true); } catch { } cleanupCurrentPipeline(state); return itx.reply({ content: "⏭ Skipped", flags: MessageFlags.Ephemeral }); }
  if (id === "mus_stop") {
    state.queue = []; state.current = null; state.startedAt = null; state.loopMode = "off"; state.skipRequested = false;
    if (state.leaveTimer) { clearTimeout(state.leaveTimer); state.leaveTimer = null; }
    try { state.player.stop(true); } catch { } cleanupCurrentPipeline(state);
    try { getVoiceConnection(guild.id)?.destroy(); } catch { }
    markNpStopped(guild).catch(() => { });
    return itx.reply({ content: "🛑 Stopped + cleared", flags: MessageFlags.Ephemeral });
  }
  if (id === "mus_queue") {
    if (!state.queue.length && !state.current) return itx.reply({ content: "📭 Queue is empty — use `/play` to add songs", flags: MessageFlags.Ephemeral });
    const lines = (state.current ? [`▶ **${state.current.title}** (now)`] : []).concat(state.queue.slice(0, 8).map((x, i) => `\`${i + 1}.\` ${x.title}`)).join("\n");
    return itx.reply({ embeds: [makeEmbed(COLORS.queue).setDescription(`### 📋 Queue\n${lines}`)], flags: MessageFlags.Ephemeral });
  }
  if (id === "mus_shuffle") {
    for (let i = state.queue.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]]; }
    return itx.reply({ content: `🔀 Shuffled **${state.queue.length}**`, flags: MessageFlags.Ephemeral });
  }
  if (id === "mus_loop") {
    state.loopMode = state.loopMode === "off" ? "track" : state.loopMode === "track" ? "queue" : "off";
    await refreshNpControls(guild, state);
    return itx.reply({ content: `🔁 Loop: **${loopLabel(state.loopMode)}**`, flags: MessageFlags.Ephemeral });
  }
  if (id === "mus_controls") {
    state.showControls = !(state.showControls !== false);
    try { if (state.guildId) setSavedShowControls(state.guildId, state.showControls); } catch {}
    await refreshNpControls(guild, state);
    return itx.reply({ content: state.showControls ? "🎛 Controls Show" : "🎛 Controls hidden — the settings row stays so you can bring them back", flags: MessageFlags.Ephemeral });
  }
  if (id === "mus_setup") {
    if (!isGuildAdmin(itx.member)) return itx.reply({ content: "Manage Server permission required.", flags: MessageFlags.Ephemeral });
    try {
      const { voiceRoom, channel } = await runBocchiSetup(guild);
      await refreshNpControls(guild, state);
      return itx.reply({ content: `🛠 Setup done — voice <#${voiceRoom.id}> + text <#${channel.id}>`, flags: MessageFlags.Ephemeral });
    } catch (e) { return itx.reply({ content: "Setup failed: " + (e?.message || e), flags: MessageFlags.Ephemeral }); }
  }
  if (id === "mus_lyrics") {
    state.showLyrics = !(state.showLyrics !== false);
    try { if (state.guildId) setSavedShowLyrics(state.guildId, state.showLyrics); } catch {}
    await refreshNpControls(guild, state);
    return itx.reply({ content: state.showLyrics ? "📝 Karaoke lyrics on — sing along!" : "📝 Lyrics hidden", flags: MessageFlags.Ephemeral });
  }
  if (id === "mus_volup") { setVolumePct(state, (state.volumePct || 100) + 20); return itx.reply({ content: `🔊 ${state.volumePct}%`, flags: MessageFlags.Ephemeral }); }
  if (id === "mus_voldown") { setVolumePct(state, Math.max(0, (state.volumePct || 100) - 20)); return itx.reply({ content: `🔉 ${state.volumePct}%`, flags: MessageFlags.Ephemeral }); }
  return itx.reply({ content: "?", flags: MessageFlags.Ephemeral });
}

function buildHelpEmbedSlash() {
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle("🎵 Music Bot — User Guide")
    .setDescription("> Just use **Slash** `/` commands\n> Supports **YouTube · SoundCloud · TikTok · Spotify** (track)")
    .addFields(
      {
        name: "🎶 Play & queue",
        value: [
          "`/play query:<name/URL>` — Play or queue a song",
          "`/playlist query:<URL/search> limit:<N>` — Load songs in bulk",
          "`/queue` — Show the full queue",
          "`/p` — Currently playing song",
          "`/remove index:<number>` — Remove from queue",
          "`/shuffle` — Shuffle the queue",
        ].join("\n"),
        inline: false,
      },
      {
        name: "⏯️ Playback",
        value: [
          "`/skip` — Skip the current song",
          "`/pause` — Pause",
          "`/resume` — Resume",
          "`/stop` — Stop and clear the whole queue",
        ].join("\n"),
        inline: true,
      },
      {
        name: "🔊 Volume & loop",
        value: [
          "`/volume value:<0-10000>` — Adjust the volume",
          "`/loop mode:off` — Loop off",
          "`/loop mode:track` — Loop the current track",
          "`/loop mode:queue` — Loop the whole queue",
        ].join("\n"),
        inline: true,
      },
      {
        name: "⚙️ System",
        value: [
          "`/ping` — Check latency",
          "`/ai question:<text>` — Ask Gemini a question",
          "`/airef` — Set this chat's AI persona (omit persona to use Ref/Ai_Tsun.txt)",
          "`/setaip` — Open a private AI chat",
          "`/delete` — Delete your private AI chat",
          "`/deletep confirm:true` — Delete all messages in public AI chat (Manage Messages)",
          "`/clear` — Clear this server's AI history (Manage Channels)",
          "`/setai` — Create a public AI chat channel (Manage Channels)",
          "`/setup` — Create or reuse the music control room (Manage Server)",
          "`/botupdate` — Update yt-dlp",
          "`/help` — Show this guide",
        ].join("\n"),
        inline: false,
      },
    )
    .setFooter({ text: "💡 Tip: prefix commands via /help are faster!" })
    .setTimestamp();
}

function parseLimitFromArgs(tokens) {
  let limit = null;
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--limit" || t === "limit" || t === "-l") {
      const n = parseInt(tokens[i + 1], 10);
      if (!Number.isNaN(n)) limit = n;
      i++;
      continue;
    }
    out.push(t);
  }
  return { limit, tokens: out };
}

// ─── Embed helper functions ────────────────────────────────────────────────
const COLORS = {
  primary: 0x5865F2, // Discord Blurple
  success: 0x57F287, // Green
  warning: 0xFEE75C, // Yellow
  error: 0xED4245, // Red
  info: 0x5DADE2, // Blue
  music: 0xE91E63, // Pink/Music
  queue: 0x9B59B6, // Purple
};

function makeEmbed(color = COLORS.primary) {
  return new EmbedBuilder().setColor(color).setTimestamp();
}

function successEmbed(title, description) {
  return makeEmbed(COLORS.success)
    .setDescription(`### ${title}\n${description ? `${description}` : ""}`);
}

function errorEmbed(description) {
  return makeEmbed(COLORS.error)
    .setDescription(`### ❌ Error\n${description}`);
}

function infoEmbed(title, description) {
  return makeEmbed(COLORS.info)
    .setDescription(`### ${title}\n${description ? `${description}` : ""}`);
}

function musicEmbed(title, description) {
  return makeEmbed(COLORS.music)
    .setDescription(`### ${title}\n${description ? `${description}` : ""}`);
}

function loopLabel(mode) {
  if (mode === "track") return "🔂 Loop current";
  if (mode === "queue") return "🔁 Loop whole queue";
  return "➡️ Off";
}
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
// ---- Clean + dynamic Now Playing UI ----
function cleanTitle(t, max = 90) {
  let s = String(t ?? "Unknown").split("\n")[0].trim();
  s = s.replace(/(\s*#[^\s#]+)+\s*$/, "").trim(); // strip trailing hashtag run
  if (s.length > max) s = s.slice(0, max - 1).trim() + "…";
  return s || "Unknown";
}
function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "• LIVE";
  sec = Math.floor(sec);
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
function playbackSeconds(state) {
  const isPaused = state.player?.state?.status === AudioPlayerStatus.Paused && state.pausedAt;
  const referenceTime = isPaused ? state.pausedAt : Date.now();
  const elapsed = state.startedAt ? (referenceTime - state.startedAt) / 1000 : 0;
  return (state.posBase || 0) + Math.max(0, elapsed);
}
function marqueeText(text, elapsedSec, width = 32) {
  const normalized = String(text || "Unknown track").replace(/\s+/g, " ").trim();
  if (normalized.length <= width) return normalized;
  const cycle = `${normalized}   •   `;
  const offset = Math.floor(Math.max(0, elapsedSec) / 1.5) % cycle.length;
  return (cycle + cycle).slice(offset, offset + width);
}
function progressLine(state) {
  const dur = state.current?.durationSec;
  const el = playbackSeconds(state);
  if (!Number.isFinite(dur) || !dur || dur <= 0) return `▶ ${fmtTime(el)} • LIVE`;
  const p = Math.max(0, Math.min(1, el / dur));
  const w = 12, fill = Math.round(p * w);
  return `${"█".repeat(fill)}${"░".repeat(w - fill)} ${fmtTime(el)} / ${fmtTime(dur)}`;
}
// Lyrics via LRCLIB (free, no key). Cached per title. Returns plain text plus
// timestamped `synced` lines for karaoke scrolling, or null when missing.
const lyricCache = new Map();
function parseSyncedLyrics(synced) {
  const out = [];
  for (const rawLine of String(synced || "").split(/\r?\n/)) {
    const m = rawLine.match(/^\s*\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$/);
    if (!m) continue;
    const t = Number(m[1]) * 60 + Number(m[2]);
    const text = (m[3] || "").trim().slice(0, 160);
    if (!Number.isFinite(t) || t < 0 || !text) continue;
    out.push({ t, text });
    if (out.length >= 400) break;
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}
function lyricIndexAt(synced, elapsedSec) {
  let idx = -1;
  for (let i = 0; i < synced.length; i++) {
    if (synced[i].t <= elapsedSec + 0.25) idx = i;
    else break;
  }
  return idx;
}
async function fetchLyrics(title) {
  const key = String(title || "").slice(0, 80).toLowerCase().trim();
  if (!key || key.length < 3) return null;
  if (lyricCache.has(key)) return lyricCache.get(key);
  const p = (async () => {
    try {
      const q = encodeURIComponent(cleanTitle(title, 80));
      const s = await fetchJsonWithTimeout(`https://lrclib.net/api/search?q=${q}`, 7000);
      const arr = Array.isArray(s) ? s : [];
      const best = arr.find((x) => x && x.syncedLyrics) || arr.find((x) => x && x.plainLyrics) || null;
      if (!best) return null;
      const synced = parseSyncedLyrics(best.syncedLyrics);
      let text = String(best.plainLyrics || "").trim();
      if (!text && best.syncedLyrics) text = String(best.syncedLyrics).replace(/^\[\d+:\d+\.\d+\]\s*/gm, "").trim();
      if (!text) return null;
      if (/^\[?instrumental\]?$/i.test(text)) return { text: "🎵 Instrumental", synced: [], artist: best.artistName || null, name: best.trackName || null };
      if (text.length < 20) return null;
      if (text.length > 900) text = text.slice(0, 900).trim() + "…";
      return { text, synced, artist: best.artistName || null, name: best.trackName || null };
    } catch { return null; }
  })();
  lyricCache.set(key, p);
  if (lyricCache.size > 200) { try { lyricCache.delete(lyricCache.keys().next().value); } catch {} }
  return p;
}
// Spotify-style karaoke block: a scrolling window of lines around the current
// position — sung lines dimmed, the live line highlighted, upcoming lines plain.
// Driven by track position so the window auto-scrolls as the song plays.
function karaokeField(state, lyrics, estimated = false) {
  const el = playbackSeconds(state);
  const synced = lyrics.synced;
  const idx = lyricIndexAt(synced, el);
  const PAST = 2, FUTURE = 4;
  const rows = [];
  if (idx < 0) {
    rows.push("*♪ Intro — get ready…*");
    for (let i = 0; i < Math.min(FUTURE + 1, synced.length); i++) rows.push(`　${synced[i].text}`);
  } else {
    const start = Math.max(0, idx - PAST);
    for (let i = start; i < idx; i++) rows.push(`╰╴${synced[i].text}`);
    rows.push(`**🎤▶ ${synced[idx].text}**`);
    for (let i = idx + 1; i < synced.length && rows.length < PAST + 1 + FUTURE; i++) rows.push(`　${synced[i].text}`);
    if (idx >= synced.length - 1) rows.push("*♪ Outro…*");
  }
  let value = rows.join("\n");
  if (value.length > 1000) value = value.slice(0, 997).trimEnd() + "…";
  const by = lyrics.artist ? ` · ${lyrics.artist}` : "";
  const est = estimated ? " · ~timing estimated" : "";
  return { name: `🎤 Karaoke — sing along${by}${est}`, value: `​\n${value}\n​`, inline: false };
}
// No synced LRC available? Spread the plain lines evenly over the track so the
// karaoke highlight still scrolls (clearly labelled as estimated).
function estimateSyncedLyrics(text, durationSec) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2 || lines.length > 200) return [];
  const start = Math.max(5, durationSec * 0.06);
  const end = durationSec * 0.97;
  const step = (end - start) / lines.length;
  return lines.map((line, i) => ({ t: start + i * step, text: line.slice(0, 160) }));
}
function buildNowPlayingEmbed(state, lyrics) {
  const cur = state.current;
  const dur = cur?.durationSec;
  const scrollingTitle = marqueeText(cleanTitle(cur?.title, 180), playbackSeconds(state));
  const e = makeEmbed(COLORS.music)
    .setTitle("🎶 Now Playing")
    .setDescription(`**${scrollingTitle}**${Number.isFinite(dur) && dur > 0 ? ` — ${fmtTime(dur)}` : ""}\n${progressLine(state)}`)
    .addFields(
      { name: "👤 Requested by", value: `${cur?.requestedBy || "—"}`, inline: true },
      { name: "🔊 Volume", value: `${state.volumePct}%`, inline: true },
      { name: "🔁 Loop", value: loopLabel(state.loopMode), inline: true },
    )
    .setFooter({ text: "Use the controls below" })
    .setTimestamp();
  if (cur?.source && isUrl(cur.source)) e.setURL(cur.source);
  const t = cur ? (cur.thumb || thumbFor(cur.source)) : null;
  if (t) e.setThumbnail(t);
  if (lyrics && lyrics.text) {
    let synced = Array.isArray(lyrics.synced) ? lyrics.synced : [];
    let estimated = false;
    if (!synced.length && Number.isFinite(dur) && dur > 30 && !/^🎵/.test(lyrics.text)) {
      synced = estimateSyncedLyrics(lyrics.text, dur);
      estimated = synced.length > 0;
    }
    if (state.showLyrics !== false && synced.length) {
      e.addFields(karaokeField(state, { ...lyrics, synced }, estimated));
    } else {
      const lines = lyrics.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      let preview = lines.slice(0, 4).join("\n");
      if (preview.length > 280) preview = preview.slice(0, 277).trimEnd() + "...";
      else if (lines.length > 4) preview += "\n…";
      e.addFields({ name: `📝 Lyrics preview${lyrics.artist ? ` · ${lyrics.artist}` : ""}`, value: preview, inline: false });
    }
  }
  return e;
}
function stopNowPlayingTicker(state) {
  if (state.npRefreshTimer) clearInterval(state.npRefreshTimer);
  state.npRefreshTimer = null;
}
function startNowPlayingTicker(guild, state) {
  stopNowPlayingTicker(state);
  state.npRefreshTimer = setInterval(async () => {
    if (!state.current || !state.npMessage) {
      stopNowPlayingTicker(state);
      return;
    }
    if (state.player.state.status === AudioPlayerStatus.Paused || state.npRefreshing) return;
    state.npRefreshing = true;
    try {
      await upsertNpMessage(guild, state.npMessage.channelId, buildNowPlayingEmbed(state, state.currentLyrics), true);
    } catch (error) {
      logPretty("WARN", `Now Playing ticker failed: ${error?.message || error}`);
    } finally {
      state.npRefreshing = false;
    }
  }, 3000);
  state.npRefreshTimer.unref?.();
}
// One dedicated text room per server: #bocchi. Every bot message/panel lives
// there — an existing #bocchi wins, else the bot creates it. A previously
// saved channel is only a last-resort fallback (e.g. no Manage Channels),
// so a stale setting can never keep bot messages out of #bocchi.
const bocchiCreateCooldown = new Map();
async function resolveBotTextChannel(guild, fallbackId) {
  const bocchi = guild.channels.cache.find((c) =>
    c.type === ChannelType.GuildText && c.name.toLowerCase() === "bocchi");
  if (bocchi) {
    if (getSavedControlChannel(guild.id) !== bocchi.id) {
      try { setSavedControlChannel(guild.id, bocchi.id); } catch { }
    }
    return bocchi;
  }
  const lastTry = bocchiCreateCooldown.get(guild.id) || 0;
  if (Date.now() - lastTry > 60000) {
    bocchiCreateCooldown.set(guild.id, Date.now());
    try {
      const created = await guild.channels.create({
        name: "bocchi",
        type: ChannelType.GuildText,
        topic: "Bocchi music room — live karaoke lyrics, music panel and bot messages.",
        permissionOverwrites: [{
          id: guild.roles.everyone.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
        }],
        reason: "Create the bocchi text room",
      });
      try { setSavedControlChannel(guild.id, created.id); } catch { }
      logPretty("SYSTEM", `Created #bocchi text room in ${guild.name}`);
      return created;
    } catch (e) {
      logPretty("WARN", `Could not create #bocchi in ${guild.name}: ${e?.message || e}`);
    }
  }
  const savedId = getSavedControlChannel(guild.id);
  const saved = savedId ? guild.channels.cache.get(savedId) : null;
  if (saved?.isTextBased?.()) return saved;
  const fb = fallbackId ? guild.channels.cache.get(fallbackId) : null;
  return fb?.isTextBased?.() ? fb : null;
}
// One living Now Playing message per guild: edit it on track change instead
// of spamming a new embed every song. Always lives in #bocchi.
async function upsertNpMessage(guild, channelId, embed, withControls = true) {
  const st = getGuildState(guild);
  const ch = await resolveBotTextChannel(guild, channelId);
  if (!ch) return null;
  const old = st.npMessage;
  const components = withControls ? buildControlRows(st) : [];
  try {
    if (old && old.channelId === ch.id) {
      const msg = await ch.messages.fetch(old.messageId);
      if (msg) { await msg.edit({ embeds: [embed], components }); return old; }
    }
  } catch { }
  if (old && old.channelId !== ch.id) {
    try {
      const previousChannel = guild.channels.cache.get(old.channelId);
      const previousMessage = previousChannel?.isTextBased?.()
        ? await previousChannel.messages.fetch(old.messageId)
        : null;
      if (previousMessage) await previousMessage.edit({ components: [] });
    } catch { }
  }
  try {
    const msg = await ch.send({ embeds: [embed], components });
    const ref = { channelId: ch.id, messageId: msg.id };
    st.npMessage = ref;
    return ref;
  } catch { }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────

const aiChatBusy = new Set();
const privateAiSessions = new Map();
async function getPrivateAiSession(itx) {
  const thread = itx.channel;
  if (!thread?.isThread?.() || thread.type !== ChannelType.PrivateThread || !thread.name.startsWith("private-ai-")) return null;
  let session = privateAiSessions.get(thread.id);
  if (session) {
    if (session.userId !== itx.user.id) throw new Error("This private AI chat belongs to another user.");
    return session;
  }
  const members = await thread.members.fetch();
  if (!members.has(itx.user.id)) throw new Error("You are not a member of this private AI chat.");
  session = { guildId: itx.guildId, userId: itx.user.id, thread, history: [], persona: getAiPersona(`private:${itx.guildId}:${thread.id}`) };
  privateAiSessions.set(thread.id, session);
  return session;
}
async function handlePrivateAiMessage(msg, session) {
  const question = String(msg.content || "").trim().slice(0, 2000);
  if (!question) return;
  const sessionKey = `private:${session.thread.id}`;
  if (aiChatBusy.has(sessionKey)) {
    return msg.reply({ content: "I’m answering your previous question. Please try again shortly.", allowedMentions: { parse: [] } });
  }
  aiChatBusy.add(sessionKey);
  try {
    if (!config.geminiApiKey && !config.openRouterApiKey) throw new Error("AI is not configured. Ask a server admin to set a Gemini or OpenRouter API key.");
    await msg.channel.sendTyping();
    const answer = await askGemini(question, session.history, session.persona);
    session.history = [...session.history, { role: "user", parts: [{ text: question }] }, { role: "model", parts: [{ text: answer }] }].slice(-20);
    await msg.reply({ content: answer, allowedMentions: { parse: [] } });
  } catch (error) {
    const message = error?.name === "AbortError"
      ? "Gemini took too long to respond. Please try again."
      : (error?.message || "Gemini request failed.");
    await msg.reply({ content: message, allowedMentions: { parse: [] } }).catch(() => {});
  } finally {
    aiChatBusy.delete(sessionKey);
  }
}
async function handleAiChatMessage(msg) {
  const question = String(msg.content || "").trim().slice(0, 2000);
  if (!question) return;
  if (!config.geminiApiKey && !config.openRouterApiKey) {
    return msg.reply({ content: "AI is not configured. Ask a server admin to set a Gemini or OpenRouter API key.", allowedMentions: { parse: [] } });
  }
  const sessionKey = `channel:${msg.guild.id}:${msg.channelId}`;
  if (aiChatBusy.has(sessionKey)) {
    return msg.reply({ content: "I’m answering another question in this channel. Please try again shortly.", allowedMentions: { parse: [] } });
  }
  aiChatBusy.add(sessionKey);
  try {
    await msg.channel.sendTyping();
    const answer = await askGeminiWithHistory(question, sessionKey);
    await msg.reply({ content: answer, allowedMentions: { parse: [] } });
  } catch (error) {
    const message = error?.name === "AbortError"
      ? "Gemini took too long to respond. Please try again."
      : (error?.message || "Gemini request failed.");
    await msg.reply({ content: message, allowedMentions: { parse: [] } }).catch(() => {});
  } finally {
    aiChatBusy.delete(sessionKey);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Private chat (DM) support: the bot answers EVERYTHING typed in DMs. Safe
// commands run against the shared server; dangerous/admin commands are
// filtered out; plain text gets a conversational reply.
const DM_BLOCKED_COMMANDS = new Set(["ytsignin", "ytsignout", "botupdate", "setup", "setai", "setaip", "delete", "deletep", "clear", "airef", "vstate", "watchtogether", "video"]);
const DM_MUSIC_COMMANDS = new Set(["play", "playlist", "skip", "stop", "pause", "resume", "queue", "np", "remove", "shuffle", "loop", "volume", "panel"]);
const DM_COMMAND_ALIASES = { p: "play", q: "queue", now: "np", next: "skip", s: "skip", st: "stop", vol: "volume", upd: "botupdate", h: "help", controls: "panel" };
async function dmTargetGuild(userId) {
  let mutual = null;
  for (const guild of client.guilds.cache.values()) {
    let member = guild.members.cache.get(userId);
    if (!member) { try { member = await guild.members.fetch(userId); } catch { member = null; } }
    if (!member) continue;
    if (guild.members.me?.voice?.channelId) return guild; // bot already live here
    if (!mutual) mutual = guild;
  }
  return mutual;
}
async function runDmMusicCommand(msg, guild, cmd, parts) {
  const state = getGuildState(guild);
  const userVC = guild.members.me?.voice?.channelId || getSavedMusicVoice(guild.id) || null;
  const botChannel = await resolveBotTextChannel(guild, null);
  const textChannelId = botChannel?.id || null;
  const reply = (payload) => msg.reply(payload);

  if (cmd === "panel") {
    const panel = state.current ? buildNowPlayingEmbed(state, state.currentLyrics) : buildPanelEmbed(guild);
    const ref = await upsertNpMessage(guild, textChannelId, panel, true);
    if (!ref) return reply({ embeds: [errorEmbed("I cannot access the #bocchi control channel.")] });
    if (state.current) startNowPlayingTicker(guild, state);
    return reply({ content: `Music controls are in <#${ref.channelId}> (server **${guild.name}**).` });
  }
  if (cmd === "np") {
    if (!state.current) return reply({ embeds: [infoEmbed("🎵 Nothing playing", `Use \`/play\` to start`)] });
    const lyrNp = await fetchLyrics(state.current.title).catch(() => null);
    return reply({ embeds: [buildNowPlayingEmbed(state, lyrNp)] });
  }
  if (cmd === "queue") {
    if (!state.queue.length) return reply({ embeds: [infoEmbed("📭 Queue is empty", `Use \`/play\` to add songs`)] });
    const lines = state.queue.slice(0, 10).map((x, i) => `\`${String(i + 1).padStart(2, "0")}.\` **${x.title}**\n　　👤 ${x.requestedBy}`).join("\n");
    const more = state.queue.length > 10 ? `\n*… and **${state.queue.length - 10}** tracks*` : "";
    return reply({
      embeds: [
        makeEmbed(COLORS.queue).setDescription(`### 📋 Queue — ${guild.name}`)
          .addFields(
            { name: `Tracks (${Math.min(state.queue.length, 10)}/${state.queue.length})`, value: lines + more, inline: false },
            { name: "🔁 Loop", value: loopLabel(state.loopMode), inline: true },
            { name: "🎵 Now playing", value: state.current ? `**${state.current.title}**` : "—", inline: true },
          )
      ]
    });
  }
  if (cmd === "play") {
    const q = parts.join(" ").trim();
    if (!q) return reply({ embeds: [errorEmbed(`Please give a song name or link\n**Example:** \`/play query:lofi hip hop\``)] });
    if (!userVC) return reply({ embeds: [errorEmbed(`I'm not in a voice room in **${guild.name}** yet — run \`/setup\` in the server first.`)] });
    const item = { title: q, source: q, requestedBy: msg.author.tag, guild, voiceChannelId: userVC, textChannelId };
    state.queue.push(item);
    const shouldStart = !state.current;
    const metaP = resolveTitleAndThumb(q);
    if (shouldStart) playNext(guild, textChannelId, state);
    const meta = await metaP;
    if (meta.title && meta.title !== q) item.title = meta.title;
    if (meta.thumb) item.thumb = meta.thumb;
    if (meta.durationSec) item.durationSec = meta.durationSec;
    const addedEmbed = makeEmbed(COLORS.success).setDescription(`### ➕ Added to queue`)
      .addFields(
        { name: "🎵 Track", value: `**${cleanTitle(item.title)}**`, inline: false },
        { name: "📋 Queue position", value: `\`#${state.queue.length}\``, inline: true },
        { name: "👤 Requested by", value: `${msg.author}`, inline: true },
        { name: "🏠 Server", value: guild.name, inline: true },
      );
    if (item.thumb) addedEmbed.setThumbnail(item.thumb);
    return reply({ embeds: [addedEmbed] });
  }
  if (cmd === "playlist") {
    const parsed = parseLimitFromArgs(parts);
    const q = parsed.tokens.join(" ").trim();
    if (!q) return reply({ embeds: [errorEmbed(`Please give a playlist link or search text\n**Example:** \`/playlist query:lofi playlist\``)] });
    if (!userVC) return reply({ embeds: [errorEmbed(`I'm not in a voice room in **${guild.name}** yet — run \`/setup\` in the server first.`)] });
    const items = await fetchPlaylistEntries(q, parsed.limit);
    if (!items.length) return reply({ embeds: [errorEmbed("No songs found in the playlist or search results")] });
    for (const { title, url, thumb, durationSec } of items) {
      state.queue.push({ title, source: url, thumb: thumb || thumbFor(url), durationSec: durationSec || null, requestedBy: msg.author.tag, guild, voiceChannelId: userVC, textChannelId });
    }
    const preview = items.slice(0, 5).map((x, i) => `\`${i + 1}.\` ${x.title}`).join("\n");
    const more = items.length > 5 ? `\n*… and ${items.length - 5} tracks*` : "";
    await reply({
      embeds: [
        makeEmbed(COLORS.queue).setDescription(`### 📚 Playlist loaded — ${guild.name}`)
          .addFields(
            { name: "🎶 Total tracks", value: `**${items.length} tracks**`, inline: true },
            { name: "👤 Requested by", value: `${msg.author}`, inline: true },
            { name: "📋 First tracks", value: preview + more, inline: false },
          )
      ]
    });
    if (!state.current) playNext(guild, textChannelId, state);
    return;
  }
  if (cmd === "skip") {
    if (!state.current) return reply({ embeds: [infoEmbed(" Nothing playing", "Nothing to skip")] });
    state.skipRequested = true;
    state.player.stop(true);
    cleanupCurrentPipeline(state);
    return reply({ embeds: [successEmbed("⏭️ Skipped", state.queue.length ? `Next: **${state.queue[0]?.title || "—"}**` : "Queue is empty")] });
  }
  if (cmd === "stop") {
    state.queue = [];
    state.current = null;
    state.startedAt = null;
    state.loopMode = "off";
    state.skipRequested = false;
    if (state.leaveTimer) { clearTimeout(state.leaveTimer); state.leaveTimer = null; }
    state.player.stop(true);
    cleanupCurrentPipeline(state);
    const vc = getVoiceConnection(guild.id);
    if (vc) vc.destroy();
    markNpStopped(guild).catch(() => { });
    return reply({ embeds: [successEmbed("🛑 Stopped", "Queue cleared and left voice")] });
  }
  if (cmd === "pause") { state.player.pause(); return reply({ embeds: [infoEmbed("⏸️ Paused", `Use \`/resume\` to resume`)] }); }
  if (cmd === "resume") { state.player.unpause(); return reply({ embeds: [successEmbed("▶️ Resumed", `Now playing: **${state.current?.title || "—"}**`)] }); }
  if (cmd === "volume") {
    const value = parseInt(parts[0], 10);
    if (Number.isNaN(value)) return reply({ embeds: [errorEmbed(`Please give a volume number (0-10000)\n**Example:** \`/volume value:80\``)] });
    setVolumePct(state, value);
    const bar = "█".repeat(Math.round(Math.min(state.volumePct, 200) / 20)) + "░".repeat(10 - Math.round(Math.min(state.volumePct, 200) / 20));
    return reply({ embeds: [successEmbed("🔊  Volume updated", `\`${bar}\` **${state.volumePct}%**`)] });
  }
  if (cmd === "loop") {
    const mode = (parts[0] || "").toLowerCase();
    if (!["off", "track", "queue"].includes(mode)) return reply({ embeds: [errorEmbed("Mode must be `off` · `track` · `queue`")] });
    state.loopMode = mode;
    return reply({ embeds: [successEmbed("🔁 Loop updated", `Current mode: **${loopLabel(mode)}**`)] });
  }
  if (cmd === "shuffle") {
    shuffleArray(state.queue);
    return reply({ embeds: [successEmbed("🔀 Shuffled", `Reordered **${state.queue.length} tracks** done`)] });
  }
  if (cmd === "remove") {
    const index = parseInt(parts[0], 10);
    if (Number.isNaN(index) || index < 1) return reply({ embeds: [errorEmbed(`Please give the queue number to remove\n**Example:** \`/remove index:3\``)] });
    if (index > state.queue.length) return reply({ embeds: [errorEmbed(`Number is past the queue end (${state.queue.length} tracks)`)] });
    const [rm] = state.queue.splice(index - 1, 1);
    return reply({ embeds: [successEmbed("🗑️  Removed from queue", `**${rm?.title || "Unknown"}**`)] });
  }
  return reply({ embeds: [errorEmbed(`\`${cmd}\` is not available in private chat`)] });
}
async function handleDmMessage(msg) {
  const raw = String(msg.content || "").trim();
  if (!raw) return;
  const looksLikeCommand = raw.startsWith("/");
  const stripped = raw.startsWith("/") ? raw.slice(1).trim() : raw;
  const parts = stripped.split(/\s+/).filter(Boolean);
  const cmdRaw = (parts.shift() || "").toLowerCase();
  const cmd = DM_COMMAND_ALIASES[cmdRaw] || cmdRaw;
  const known = cmd === "help" || cmd === "ping" || DM_MUSIC_COMMANDS.has(cmd) || DM_BLOCKED_COMMANDS.has(cmd);

  if (stripped && (looksLikeCommand || known)) {
    if (DM_BLOCKED_COMMANDS.has(cmd)) {
      return msg.reply({ embeds: [errorEmbed(`🔒 \`/${cmd}\` is filtered out of private chat — it is a server/admin command. Use it in the server instead.`)] });
    }
    if (cmd === "help") return msg.reply({ embeds: [buildHelpEmbedSlash()] });
    if (cmd === "ping") {
      return msg.reply({
        embeds: [makeEmbed(COLORS.info).setDescription("### 🏓  Pong!").addFields({ name: "🌐 WebSocket", value: `\`${Math.round(client.ws.ping)} ms\``, inline: true })]
      });
    }
    if (DM_MUSIC_COMMANDS.has(cmd)) {
      const guild = await dmTargetGuild(msg.author.id);
      if (!guild) return msg.reply({ embeds: [errorEmbed("I don't share any server with you yet — invite me and run `/setup` there first.")] });
      return runDmMusicCommand(msg, guild, cmd, parts);
    }
    if (looksLikeCommand) {
      return msg.reply({ embeds: [errorEmbed(`Unknown command \`${raw.split(/\s+/)[0]}\` — type \`help\` to see what I can do`)] });
    }
  }

  // Plain conversation — the bot answers everything typed in private chat.
  if (config.geminiApiKey || config.openRouterApiKey) {
    const sessionKey = `dm:${msg.author.id}`;
    if (aiChatBusy.has(sessionKey)) {
      return msg.reply({ content: "I’m finishing my last answer — one moment!", allowedMentions: { parse: [] } });
    }
    aiChatBusy.add(sessionKey);
    try {
      await msg.channel.sendTyping();
      const answer = await askGeminiWithHistory(raw, sessionKey);
      return msg.reply({ content: answer, allowedMentions: { parse: [] } });
    } catch (e) {
      logPretty("WARN", `DM chat reply failed: ${e?.message || e}`);
    } finally { aiChatBusy.delete(sessionKey); }
  }
  return msg.reply({
    embeds: [
      infoEmbed("🎸 Bocchi here!",
        "I answer everything you type in private chat.\n" +
        `**Safe commands here:** \`help\` \`play <song>\` \`playlist\` \`np\` \`queue\` \`skip\` \`pause\` \`resume\` \`stop\` \`loop\` \`volume\` \`shuffle\` \`remove\` \`panel\` \`ping\`\n` +
        "**Filtered out (server/admin only):** `setup` `ytsignin` `ytsignout` `botupdate` `setai` `clear` `deletep` `vstate` `video` `watchtogether`\n" +
        "Anything else — just talk to me!")
    ]
  });
}

client.on("messageCreate", async (msg) => {
  try {
    if (msg.author?.bot) return;
    if (!msg.guild) {
      await handleDmMessage(msg);
      return;
    }

    const privateSession = privateAiSessions.get(msg.channelId);
    if (privateSession) {
      if (privateSession.userId !== msg.author.id) return;
      await handlePrivateAiMessage(msg, privateSession);
      return;
    }
    if (msg.channelId === getSavedAiChannel(msg.guild.id)) {
      await handleAiChatMessage(msg);
      return;
    }

    // NOTE: legacy / prefix commands were removed — slash commands only.
  } catch (e) {
    console.error(e);
    try { await msg.reply({ embeds: [errorEmbed("Error reading that command — please try again")] }); } catch { }
  }
});


// Slash command definitions
const commands = [
  new SlashCommandBuilder().setName("play").setDescription("Play music from YouTube (song name or URL)")
    .addStringOption(o => o.setName("query").setDescription("Song name/URL").setRequired(true)),
  new SlashCommandBuilder().setName("skip").setDescription("Skip the current song"),
  new SlashCommandBuilder().setName("stop").setDescription("Stop and clear the queue"),
  new SlashCommandBuilder().setName("pause").setDescription("Pause"),
  new SlashCommandBuilder().setName("resume").setDescription("Resume"),
  new SlashCommandBuilder().setName("ping").setDescription("Check ping"),
  new SlashCommandBuilder().setName("botupdate").setDescription("Update yt-dlp"),
  new SlashCommandBuilder().setName("p").setDescription("What's playing right now"),
  new SlashCommandBuilder().setName("queue").setDescription("Show the remaining queue"),
  new SlashCommandBuilder().setName("list").setDescription("Show the remaining queue"),
  new SlashCommandBuilder().setName("volume").setDescription("Adjust volume (0-10000)")
    .addIntegerOption(o => o.setName("value").setDescription("Percent (0-10000)").setRequired(true).setMinValue(0).setMaxValue(10000)),
  new SlashCommandBuilder().setName("playlist").setDescription("Add songs in bulk from YouTube (playlist or search)")
    .addStringOption(o => o.setName("query").setDescription("Playlist link or search text").setRequired(true))
    .addIntegerOption(o => o.setName("limit").setDescription("Max count (omit = whole playlist) (1-5000)").setMinValue(1).setMaxValue(5000)),
  new SlashCommandBuilder().setName("remove").setDescription("Remove a song by queue position")
    .addIntegerOption(o => o.setName("index").setDescription("Position in /queue").setRequired(true).setMinValue(1).setAutocomplete(true)),
  new SlashCommandBuilder().setName("shuffle").setDescription("Shuffle the queue randomly"),
  new SlashCommandBuilder().setName("loop").setDescription("Set track/queue loop")
    .addStringOption(o =>
      o.setName("mode")
        .setDescription("Loop mode")
        .setRequired(true)
        .addChoices(
          { name: "Off", value: "off" },
          { name: "Loop current", value: "track" },
          { name: "Loop whole queue", value: "queue" },
        )
    ),
  new SlashCommandBuilder().setName("help").setDescription("Show all commands and usage"),
  new SlashCommandBuilder().setName("ai").setDescription("Ask Gemini a question")
    .addStringOption(o => o.setName("question").setDescription("What would you like to ask?").setRequired(true).setMaxLength(1000)),
  new SlashCommandBuilder().setName("airef").setDescription("Set this chat's AI persona; omit text to use Ref/Ai_Tsun.txt")
    .addStringOption(o => o.setName("persona").setDescription("Persona instructions; omit to use the default persona file").setMaxLength(4000))
    .addBooleanOption(o => o.setName("reset").setDescription("Remove this chat's persona")),
  new SlashCommandBuilder().setName("setai").setDescription("Create a public AI chat channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder().setName("setaip").setDescription("Open a temporary private AI chat"),
  new SlashCommandBuilder().setName("delete").setDescription("Delete your temporary private AI chat"),
  new SlashCommandBuilder().setName("deletep").setDescription("Delete all messages in the public AI chat")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addBooleanOption(o => o.setName("confirm").setDescription("Confirm deleting every message in the public AI chat").setRequired(true)),
  new SlashCommandBuilder().setName("clear").setDescription("Clear this server's AI history and private chats")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder().setName("panel").setDescription("Open the music control panel (buttons)"),
  new SlashCommandBuilder().setName("setup").setDescription("Create or reuse the music control room")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("ytstatus").setDescription("Check YouTube sign-in status"),
  new SlashCommandBuilder().setName("ytsignin").setDescription("Sign in YouTube with cookies.txt (admin)")
    .addAttachmentOption(o => o.setName("file").setDescription("cookies.txt file").setRequired(true)),
  new SlashCommandBuilder().setName("ytsignout").setDescription("Remove YouTube cookies (admin)"),
  new SlashCommandBuilder().setName("video").setDescription("Share the video page + play audio in voice (YouTube)")
    .addStringOption(o => o.setName("query").setDescription("Video name/YouTube URL").setRequired(true)),
  new SlashCommandBuilder().setName("watchtogether").setDescription("Watch video together in voice chat (Watch Together)"),
  new SlashCommandBuilder().setName("vstate").setDescription("Debug: voice/player status (admin)"),
].map(c => c.toJSON());

// Guild queue and player state
const guildStates = new Map();

// Persisted per-guild settings (volume) — survives restarts via data dir.
function volumeStorePath() { return path.join(config.dataDir, "guild-settings.json"); }
function loadGuildSettings() {
  try {
    const raw = fs.readFileSync(volumeStorePath(), "utf8");
    const o = JSON.parse(raw);
    return (o && typeof o === "object") ? o : {};
  } catch { return {}; }
}
// Only pass a cookies file to yt-dlp if it actually looks like a Netscape
// cookies file (non-empty, tab-separated, ideally with the standard header).
// An empty/garbage file makes yt-dlp fail EVERYTHING — worse than no cookies.
let _cookieCache = { path: null, mtimeMs: 0, valid: false };
function effectiveCookieFile() {
  const p = config.cookieFile;
  if (!p) return null;
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size < 50) { _cookieCache = { path: p, mtimeMs: st.size, valid: false }; return null; }
    const key = p + ":" + st.size + ":" + st.mtimeMs;
    if (_cookieCache.path === key) return _cookieCache.valid ? p : null;
    const head = fs.readFileSync(p, "utf8").slice(0, 4096);
    const lines = head.split("\n").filter((l) => l && !l.trim().startsWith("#"));
    const valid = lines.length > 0 && lines.some((l) => l.includes("\t") && /youtube\.com|youtu\.be|google\.com/i.test(l));
    _cookieCache = { path: key, valid };
    if (!valid) logPretty("WARN", `Ignoring invalid cookies file ${p} (not Netscape format) — running without cookies`);
    return valid ? p : null;
  } catch { return null; }
}
function saveGuildSettings(all) {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(volumeStorePath(), JSON.stringify(all), "utf8");
  } catch (e) { logPretty("ERROR", "save settings: " + (e?.message || e)); }
}
function getSavedVolume(guildId) {
  const v = loadGuildSettings()[String(guildId)]?.volumePct;
  return Number.isFinite(v) ? Math.max(0, Math.min(10000, v)) : null;
}
function setSavedVolume(guildId, pct) {
  const all = loadGuildSettings();
  all[String(guildId)] = { ...(all[String(guildId)] || {}), volumePct: pct };
  saveGuildSettings(all);
}
function getSavedShowLyrics(guildId) {
  const v = loadGuildSettings()[String(guildId)]?.showLyrics;
  return v === undefined ? true : v !== false;
}
function setSavedShowLyrics(guildId, on) {
  const all = loadGuildSettings();
  all[String(guildId)] = { ...(all[String(guildId)] || {}), showLyrics: on !== false };
  saveGuildSettings(all);
}
function getSavedShowControls(guildId) {
  const v = loadGuildSettings()[String(guildId)]?.showControls;
  return v === undefined ? true : v !== false;
}
function setSavedShowControls(guildId, on) {
  const all = loadGuildSettings();
  all[String(guildId)] = { ...(all[String(guildId)] || {}), showControls: on !== false };
  saveGuildSettings(all);
}
function getSavedMusicVoice(guildId) {
  return loadGuildSettings()[String(guildId)]?.musicVoiceChannelId || null;
}
function setSavedMusicVoice(guildId, channelId) {
  const all = loadGuildSettings();
  all[String(guildId)] = { ...(all[String(guildId)] || {}), musicVoiceChannelId: channelId };
  saveGuildSettings(all);
}
function getSavedAiChannel(guildId) {
  return loadGuildSettings()[String(guildId)]?.aiChatChannelId || null;
}
function aiSessionKeyForChannel(guildId, channelId) {
  return getSavedAiChannel(guildId) === channelId
    ? `channel:${guildId}:${channelId}`
    : `slash:${guildId}:${channelId}`;
}
function setSavedAiChannel(guildId, channelId) {
  const all = loadGuildSettings();
  all[String(guildId)] = { ...(all[String(guildId)] || {}), aiChatChannelId: channelId };
  saveGuildSettings(all);
}
function getSavedControlChannel(guildId) {
  return loadGuildSettings()[String(guildId)]?.controlChannelId || null;
}
function setSavedControlChannel(guildId, channelId) {
  const all = loadGuildSettings();
  all[String(guildId)] = { ...(all[String(guildId)] || {}), controlChannelId: channelId };
  saveGuildSettings(all);
}
async function deletePublicAiChat(guild) {
  const channelId = getSavedAiChannel(guild.id);
  if (!channelId) throw new Error("No public AI chat is configured. Run /setai first.");
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.messages?.fetch || !channel?.bulkDelete) throw new Error("The configured public AI chat channel was not found.");
  const sessionKey = `channel:${guild.id}:${channel.id}`;
  if (aiChatBusy.has(sessionKey)) throw new Error("The AI is answering in the public channel. Try again in a moment.");

  let deleted = 0;
  const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
  while (true) {
    const batch = await channel.messages.fetch({ limit: 100 });
    if (!batch.size) break;
    const recent = batch.filter((message) => Date.now() - message.createdTimestamp < fourteenDaysMs);
    const old = batch.filter((message) => Date.now() - message.createdTimestamp >= fourteenDaysMs);
    let removedThisBatch = 0;

    if (recent.size > 1) {
      try {
        removedThisBatch += (await channel.bulkDelete(recent, true)).size;
      } catch {
        for (const message of recent.values()) {
          try { await message.delete(); removedThisBatch++; } catch { }
        }
      }
    } else if (recent.size === 1) {
      try { await recent.first().delete(); removedThisBatch++; } catch { }
    }
    for (const message of old.values()) {
      try { await message.delete(); removedThisBatch++; } catch { }
    }

    if (!removedThisBatch) throw new Error("No messages could be deleted. Check the bot's Manage Messages permission.");
    deleted += removedThisBatch;
  }

  const histories = loadAiHistories();
  delete histories[sessionKey];
  saveAiHistories(histories);
  setAiPersona(sessionKey, "");
  return deleted;
}

function createGuildState(guild) {
  const player = createAudioPlayer();
  const state = {
    guildId: guild.id,
    queue: [],
    current: null,
    player,
    currentPipe: /** @type {null | { ff: import('child_process').ChildProcessWithoutNullStreams, stream: NodeJS.ReadableStream }} */ (null),
    restartGuard: { tried: false },
    currentResource: null,
    volumePct: getSavedVolume(guild.id) ?? config.defaultVolume,
    showLyrics: getSavedShowLyrics(guild.id), // karaoke sing-along block
    showControls: getSavedShowControls(guild.id), // transport buttons on the panel
    loopMode: config.defaultLoop,
    skipRequested: false,
    leaveTimer: null, // disconnect countdown while waiting for new songs
    startedAt: null, // timestamp ms when current track started (progress bar)
    posBase: 0, // track seconds already consumed via seek at start
    pausedAt: null,
    npMessage: null, // { channelId, messageId } living Now Playing message
    npRefreshTimer: null,
    npRefreshing: false,
    currentLyrics: null,
    gen: 0, // playback generation: stale async flows abort when superseded
    failStreak: 0, // consecutive hard failures for the same title
    lastFailTitle: null,
    quickFails: 0, // same track starting+dying within seconds, repeatedly
    lastStart: null, // { title, t } of last successful playback start
    history: [], // finished tracks (for ⏮ previous), capped
    prevJump: false, // set when ⏮ re-queues: idle handler must not re-push
    lastTeardownAt: 0, // ms timestamp of last intentional pipe teardown
  };

  player.on(AudioPlayerStatus.Idle, () => {
    handlePlayerIdle(guild, state).catch((e) => logPretty("ERROR", `Idle handler error: ${e?.message || e}`));
  });
  player.on("error", (e) => {
    handlePlayerError(e, guild, state).catch((err) => logPretty("ERROR", `Player error handler failed: ${err?.message || err}`));
  });
  player.on("stateChange", (oldS, newS) => {
    if (oldS.status === AudioPlayerStatus.Playing && newS.status === AudioPlayerStatus.Paused) {
      state.pausedAt = Date.now();
    } else if (oldS.status === AudioPlayerStatus.Paused && newS.status === AudioPlayerStatus.Playing) {
      if (state.startedAt && state.pausedAt) state.startedAt += Date.now() - state.pausedAt;
      state.pausedAt = null;
    }
    if (state.current && state.npMessage && [AudioPlayerStatus.Playing, AudioPlayerStatus.Paused].includes(newS.status)) {
      const channelId = getSavedControlChannel(guild.id) || state.current.textChannelId;
      upsertNpMessage(guild, channelId, buildNowPlayingEmbed(state, state.currentLyrics), true)
        .catch((e) => logPretty("WARN", `Now Playing refresh failed: ${e?.message || e}`));
    }
    try { logPretty("LOG", `[player] ${oldS.status} -> ${newS.status}`); } catch { }
  });

  return state;
}

function getGuildState(guild) {
  let state = guildStates.get(guild.id);
  if (!state) {
    state = createGuildState(guild);
    guildStates.set(guild.id, state);
  }
  return state;
}

// Mark the living Now Playing message as stopped (keeps one tidy message).
async function markNpStopped(guild, text) {
  try {
    const st = getGuildState(guild);
    if (!st.npMessage) return;
    const ch = guild.channels.cache.get(st.npMessage.channelId);
    if (!ch || !ch.isTextBased?.()) return;
    const msg = await ch.messages.fetch(st.npMessage.messageId);
    if (msg) await msg.edit({ embeds: [makeEmbed(COLORS.info).setTitle("⏹ Stopped").setDescription(text || "Use `/play` to start a new song anytime").setTimestamp()], components: [] });
  } catch { }
}
// Utility functions
async function sendToTextChannel(guild, textChannelId, content) {
  try {
    const ch = await resolveBotTextChannel(guild, textChannelId);
    if (ch) return ch.send(content);
  } catch { }
}
function ensureVC(guild, channelId, state, opts = {}) {
  let conn = getVoiceConnection(guild.id);
  const usable = conn && (
    conn.state.status === VoiceConnectionStatus.Ready ||
    conn.state.status === VoiceConnectionStatus.Connecting ||
    conn.state.status === VoiceConnectionStatus.Signalling
  );
  // Loop replays / retries / seeks must STAY where the bot already is —
  // only fresh song requests follow the requester to a new room.
  if (usable && opts.stay) {
    if (state) { try { conn.subscribe(state.player); } catch (e) { logPretty("ERROR", "Voice subscribe fail: " + (e?.message || e)); } }
    return conn;
  }
  const wrongChannel = usable && channelId && conn.joinConfig?.channelId && conn.joinConfig.channelId !== channelId;
  if (!usable || wrongChannel) {
    if (conn) { try { conn.destroy(); } catch { } }
    logPretty("LOG", `[voice] (re)joining channel ${channelId} (was: ${conn?.state?.status || "none"})`);
    conn = joinVoiceChannel({ channelId, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: true });
    conn.on("error", (e) => logPretty("ERROR", "Voice conn error: " + (e?.message || e)));
    conn.on("stateChange", (o, n) => { try { logPretty("LOG", `[voice] ${o.status} -> ${n.status}`); } catch { } });
  }
  if (state) {
    try {
      const sub = conn.subscribe(state.player);
      if (!sub) logPretty("WARN", "Voice subscribe returned nothing");
    } catch (e) { logPretty("ERROR", "Voice subscribe fail: " + (e?.message || e)); }
  }
  return conn;
}
function voiceDiag(guild) {
  const conn = getVoiceConnection(guild.id);
  const st = guildStates.get(guild.id);
  const vcId = guild.members.me?.voice?.channelId;
  const vcName = vcId ? (guild.channels.cache.get(vcId)?.name || vcId) : "—";
  return {
    botVC: vcName,
    conn: conn?.state?.status || "none",
    subscribed: (() => { try { return !!conn?.state?.subscription; } catch { return false; } })(),
    player: st?.player?.state?.status || "no-state",
    current: st?.current?.title || "—",
    queue: st?.queue?.length ?? 0,
  };
}
function cleanupCurrentPipeline(state) {
  if (!state.currentPipe) return;
  // Mark teardown time: errors surfacing within ~3s of an intentional
  // teardown (skip/stop/song switch) are dying-pipe noise, not real drops.
  // handlePlayerError ignores them so skips don't cry "signal lost".
  state.lastTeardownAt = Date.now();
  try {
    // Destroy the audio stream if present
    try { state.currentPipe.stream?.destroy?.(); } catch { }
    // Kill the ffmpeg process
    try { state.currentPipe.ff?.kill?.("SIGKILL"); } catch { }
    // If there is a helper process (e.g. yt-dlp for TikTok), kill it too
    try { state.currentPipe.helper?.kill?.("SIGKILL"); } catch { }
  } catch (e) {
    swallowPipeError(e);
  } finally {
    state.currentPipe = null;
  }
}
function isUrl(s) { try { new URL(s); return true; } catch { return false; } }

// yt-dlp helper functions
async function getTitle(input) {
  const r = await resolveTitleAndThumb(input);
  return r.title;
}
// Thumbnail helpers — YouTube thumbs need no API key: i.ytimg.com/vi/ID/hqdefault.jpg
function thumbFor(source) {
  const id = extractYouTubeIdSafe(source);
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
}
function extractYouTubeIdSafe(s) { try { return extractYouTubeId(s); } catch { return null; } }
// Native artwork from yt-dlp (TikTok cover, SoundCloud art, YouTube thumb…),
// falling back to i.ytimg.com for YouTube URLs.
function pickThumb(e, fallbackUrl) {
  try {
    if (e?.thumbnail) return e.thumbnail;
    const list = e?.thumbnails;
    if (Array.isArray(list) && list.length) {
      const last = list[list.length - 1];
      if (last?.url) return last.url;
    }
  } catch { }
  return fallbackUrl ? thumbFor(fallbackUrl) : null;
}
// ONE yt-dlp call → { title, thumb, durationSec }. Falls back to raw query.
async function resolveTitleAndThumb(input) {
  try {
    // TikTok: metadata only via TikWM (fast, no yt-dlp).
    if (isTikTokUrl(input)) {
      try {
        const m = await tiktokMeta(input);
        return { title: m.title, thumb: m.thumb, durationSec: numOrNull(m.duration) };
      } catch (e) { logPretty("WARN", "tikwm meta failed: " + (e?.message || e)); }
    }
    if (isSpotifyUrl(input)) {
      const meta = await spotifyMeta(input);
      if (meta.title && meta.title !== input) return { ...meta, durationSec: null };
    }
    const info = await ytdlp(input, ytdlpOpts({ dumpSingleJson: true, skipDownload: true, noWarnings: true }));
    const e = info?.entries?.[0] || info;
    if (e?.title) {
      const url = e.webpage_url || input;
      return { title: e.title, thumb: pickThumb(e, url) || thumbFor(input), durationSec: numOrNull(e.duration) };
    }
  } catch { }
  return { title: input, thumb: thumbFor(input), durationSec: null };
}
function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
// Spotify oembed gives title + album art in one call.
async function spotifyMeta(input) {
  try {
    const url = normalizeSpotifyUrl(input);
    if (!url) return { title: input, thumb: null };
    const data = await fetchJsonWithTimeout(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`, 8000);
    if (data?.title) return { title: String(data.title), thumb: data.thumbnail_url || null };
  } catch { }
  return { title: input, thumb: null };
}
async function resolveFirstVideoUrl(query) {
  if (isSpotifyUrl(query)) {
    const kind = spotifyKind(query);
    if (kind === "album" || kind === "playlist") return null;
    const q2 = await spotifyTrackToSearchQuery(query);
    if (q2) query = q2;
  }
  if (isUrl(query)) return query;
  try {
    const out = await ytdlp(`ytsearch1:${query}`, ytdlpOpts({ dumpSingleJson: true }));
    return out?.entries?.[0]?.webpage_url || null;
  } catch (e) {
    logPretty("ERROR", "search resolve fail: " + (e?.message || e));
    return null;
  }
}
// ---- Video-page helpers (legit: share watch page + iframe, audio via voice) ----
function extractYouTubeId(u) {
  try {
    const s = String(u || "");
    let m = s.match(/(?:youtube\.com\/(?:watch\?[^#]*v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
    if (m) return m[1];
    m = s.match(/^([A-Za-z0-9_-]{11})$/);
    if (m) return m[1];
  } catch { }
  return null;
}
async function resolveVideoInfo(query) {
  // ONE yt-dlp call (was: search call + info call). Title + URL together.
  let input = query;
  if (isSpotifyUrl(query)) {
    const kind = spotifyKind(query);
    if (kind === "album" || kind === "playlist") return null;
    const q2 = await spotifyTrackToSearchQuery(query);
    if (!q2) return null;
    input = q2;
  }
  if (!isUrl(input)) input = `ytsearch1:${input}`;
  try {
    const info = await ytdlp(input, ytdlpOpts({ dumpSingleJson: true, skipDownload: true, noWarnings: true }));
    const e = info?.entries?.[0] || info;
    if (!e) return null;
    const url = e.webpage_url || input;
    const title = e.title || query;
    return { title, url, thumb: pickThumb(e, url), durationSec: numOrNull(e.duration), videoId: extractYouTubeId(e.webpage_url || url) || extractYouTubeId(query) };
  } catch (e) {
    logPretty("ERROR", "video resolve fail: " + (e?.message || e));
    return null;
  }
}
function buildVideoRows(videoId, pageUrl) {
  const row = new ActionRowBuilder();
  if (videoId) {
    row.addComponents(new ButtonBuilder().setLabel("▶ Watch on YouTube").setStyle(ButtonStyle.Link).setURL(`https://www.youtube.com/watch?v=${videoId}`));
    if (pageUrl) row.addComponents(new ButtonBuilder().setLabel("🖥 Open video page").setStyle(ButtonStyle.Link).setURL(pageUrl));
  } else if (pageUrl) {
    // TikTok / SoundCloud / others: no embed page, just the source link.
    row.addComponents(new ButtonBuilder().setLabel("🔗 Open link").setStyle(ButtonStyle.Link).setURL(pageUrl));
  }
  return row.components.length ? [row] : [];
}
// Watch Together: the ONLY legit way to show video inside a voice channel.
// Bots cannot push video frames (audio-only API); instead the bot creates an
// Activity invite so everyone in the VC watches YouTube together in sync.
const WATCH_TOGETHER_APP_ID = "880218394199220334";
async function createWatchTogetherInvite(voiceChannel) {
  const invite = await voiceChannel.createInvite({
    maxAge: 6 * 3600,
    targetApplication: WATCH_TOGETHER_APP_ID,
    targetType: InviteTargetType.EmbeddedApplication,
    reason: "Watch Together session",
  });
  return invite;
}
async function getDirectAudioUrlAndHeaders(input) {
  // Single yt-dlp call: resolve the page URL (or search query) AND extract
  // the CDN audio URL in one shot. Previously we called resolveFirstVideoUrl
  // first (one yt-dlp invocation) and then called this function (a second
  // invocation). The CDN URL YouTube returns expires quickly, so by the time
  // ffmpeg started fetching it the URL was already dead → instant FINISHED.
  // Now we do everything in one call so ffmpeg starts immediately.
  const info = await ytdlp(input, ytdlpOpts({ dumpSingleJson: true, f: "bestaudio/best" }));
  const url = info?.url;
  const headers = info?.http_headers || {};
  if (!url) throw new Error("yt-dlp did not return media url");
  return { url, headers };
}
function buildFfmpegHeadersString(h) {
  const merged = {
    "User-Agent": h["User-Agent"] || h["user-agent"] || "Mozilla/5.0",
    "Accept": h["Accept"] || "*/*",
    "Accept-Language": h["Accept-Language"] || "en-US,en;q=0.9",
    "Origin": h["Origin"] || "https://www.youtube.com",
    "Referer": h["Referer"] || "https://www.youtube.com/",
    ...(h.Cookie ? { "Cookie": h.Cookie } : (h.cookie ? { "Cookie": h.cookie } : {})),
  };
  return Object.entries(merged).map(([k, v]) => `${k}: ${v}`).join("\r\n");
}
function spawnFfmpegFromDirectUrl(url, headersStr) {
  if (!FFMPEG_AVAILABLE) throw new Error("ffmpeg binary not available");

  // Build argument list dynamically based off the audio/network config
  const a = [];

  // Base logging and banner settings
  a.push("-loglevel", "info", "-hide_banner");

  // Reconnect logic with configurable max delay
  a.push(
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_on_network_error", "1",
    "-reconnect_delay_max", String(config.ffmpegReconnectDelayMax)
  );

  // Tune buffering and probing depending on latency preference
  if (config.ffmpegLowLatency) {
    a.push(
      "-fflags", "+nobuffer",
      "-flags", "low_delay",
      "-analyzeduration", String(config.ffmpegInputAnalyzeMs * 1000), // microseconds
      "-probesize", "32k",
      "-rw_timeout", "15000000",
      "-timeout", "15000000"
    );
  } else {
    const us = Math.max(0, config.ffmpegInputAnalyzeMs) * 1000;
    a.push("-analyzeduration", String(us), "-probesize", "256k");
  }

  // Pass through HTTP headers and input URL
  a.push("-headers", headersStr + "\r\n", "-i", url);

  // Drop any video streams
  a.push("-vn");

  // Apply channel count and sample rate
  a.push("-ac", String(config.audioChannels));
  a.push("-ar", String(config.audioSampleRate));

  // Optional audio filter chain
  const afChain = (config.audioFilter || "").trim();
  if (afChain) {
    a.push("-af", afChain);
  }

  // Encode to Opus with bitrate and VBR settings
  a.push("-c:a", "libopus");
  a.push("-b:a", config.opusBitrate);

  // Configure variable bitrate mode
  if (config.opusVbr === "off") {
    a.push("-vbr", "off");
  } else if (config.opusVbr === "constrained") {
    a.push("-vbr", "constrained");
  } else {
    a.push("-vbr", "on");
  }

  // Set Opus application profile if valid
  if (["audio", "voip", "lowdelay"].includes(config.opusApplication)) {
    a.push("-application", config.opusApplication);
  }

  // Frame duration (accepted values: 2.5,5,10,20,40,60 ms)
  const fd = Number(config.opusFrameDuration);
  if ([2.5, 5, 10, 20, 40, 60].includes(fd)) {
    a.push("-frame_duration", String(fd));
  }

  // Complexity (0–10)
  const cx = Number(config.opusComplexity);
  if (Number.isFinite(cx) && cx >= 0 && cx <= 10) {
    a.push("-compression_level", String(cx));
  }

  // Append any custom extra arguments
  if (config.ffmpegExtraArgs && config.ffmpegExtraArgs.trim()) {
    // Split on whitespace to allow multiple flags
    a.push(...config.ffmpegExtraArgs.trim().split(/\s+/));
  }

  // Output container and pipe to stdout
  a.push("-f", "ogg", "pipe:1");

  const ff = spawn(FFMPEG || "ffmpeg", a, { stdio: ["ignore", "pipe", "pipe"] });
  ff.on("error", (e) => logPretty("ERROR", "ffmpeg spawn error: " + (e?.message || e)));
  ff.stdout.on("error", swallowPipeError);
  ff.stderr.on("error", swallowPipeError);
  ff.stderr.on("data", d => {
    try {
      logPretty("LOG", "[ffmpeg] " + d.toString().trim());
    } catch { }
  });
  return ff;
}

// Universal yt-dlp → ffmpeg pipe for ALL platforms.
// yt-dlp downloads best audio → stdout → ffmpeg stdin → opus ogg → stdout → Discord.
// Crucially, ff.stdin has an 'error' listener so SIGKILL on stop/skip never
// throws an unhandled EPIPE that crashes the Node process.
// Alternate YouTube player client for cookieless fallback.
// web↔android: if one demands sign-in / PO token, try the other.
function altPlayerClient(primary) {
  return /android/i.test(primary || "") ? "web,web_creator" : "android";
}
function spawnUniversalPipe(source, playerClient, offsetSec) {
  if (!FFMPEG_AVAILABLE) throw new Error("ffmpeg binary not available");

  // ── yt-dlp ───────────────────────────────────────────────────────────────
  const isTikTok = source.includes("tiktok.com") || source.includes("vt.tiktok.com") || source.includes("workers.dev");
  const ytArgs = [];
  if (config.ytdlpForceIpv4) ytArgs.push("--force-ipv4");
  const ckFile = effectiveCookieFile();
  if (ckFile) ytArgs.push("--cookies", ckFile);
  ytArgs.push(
    "--no-check-certificates",
    "--retries", "infinite",
    "--fragment-retries", "infinite",
    "--buffer-size", "64K",
    "--js-runtimes", "node",
  );
  if (isTikTok) {
    // TikTok: needs impersonation to avoid 403
    // and must pick audio-only formats (some clips are video-only)
    ytArgs.push(
      "--impersonate", "chrome",
      "-f", "bestaudio[acodec!=none]/ba[acodec!=none]/b[acodec!=none]",
    );
  } else {
    // YouTube and others — prefer direct m4a (single progressive file = fastest
    // start, no hundreds of DASH fragments on 30min+ videos), concurrent
    // fragments keep long videos from stalling mid-play.
    ytArgs.push(
      "--extractor-args", `youtube:player-client=${playerClient || config.ytdlpPlayerClient};player_skip=webpage`,
      "-f", "bestaudio[ext=m4a]/bestaudio[acodec=aac]/bestaudio/best",
      "--concurrent-fragments", "4",
    );
  }
  ytArgs.push("-o", "-", source);
  const helper = spawn(YTDLP_BIN, ytArgs, { stdio: ["ignore", "pipe", "pipe"] });
  helper.on("error", (e) => logPretty("ERROR", "yt-dlp(universal) error: " + (e?.message || e)));
  helper.stdout.on("error", swallowPipeError);
  helper.stderr.on("error", swallowPipeError);
  helper.stderr.on("data", (d) => { try { logPretty("LOG", "[yt-dlp] " + d.toString().trim()); } catch { } });

  // ── ffmpeg ────────────────────────────────────────────────────────────────
  const a = ffmpegStdinArgs(offsetSec);

  const ff = spawn(FFMPEG || "ffmpeg", a, { stdio: ["pipe", "pipe", "pipe"] });
  ff.on("error", (e) => logPretty("ERROR", "ffmpeg(universal) error: " + (e?.message || e)));
  ff.stdout.on("error", swallowPipeError);
  ff.stderr.on("error", swallowPipeError);
  // *** EPIPE guard: when stop/skip kills ffmpeg, yt-dlp writes into closed stdin
  // without this handler Node throws unhandled EPIPE and dies ***
  ff.stdin.on("error", swallowPipeError);
  ff.stderr.on("data", (d) => { try { logPretty("LOG", "[ffmpeg] " + d.toString().trim()); } catch { } });

  helper.stdout.pipe(ff.stdin);
  return { ff, stream: cushionStream(ff), helper, raw: ff.stdout };
}
// Shared ffmpeg args: read audio from stdin pipe, output opus/ogg to stdout.
// offsetSec>0 adds output-side -ss (accurate seek; input is an unseekable pipe).
function ffmpegStdinArgs(offsetSec) {
  const a = [];
  a.push("-loglevel", "info", "-hide_banner");
  if (config.ffmpegLowLatency) {
    a.push("-fflags", "+nobuffer", "-flags", "low_delay",
      "-analyzeduration", String(Math.max(500000, config.ffmpegInputAnalyzeMs * 1000)), "-probesize", "64k");
  } else {
    a.push("-analyzeduration", String(Math.max(0, config.ffmpegInputAnalyzeMs) * 1000), "-probesize", "256k");
  }
  // Bigger pipe-input queue so a busy CPU doesn't drop the stream start.
  a.push("-thread_queue_size", "1024", "-i", "pipe:0", "-vn");
  const off = Number(offsetSec);
  if (Number.isFinite(off) && off > 0) a.push("-ss", String(off)); // output seek: decode+drop, exact
  a.push("-ac", String(config.audioChannels), "-ar", String(config.audioSampleRate));
  const afChain = (config.audioFilter || "").trim();
  if (afChain) a.push("-af", afChain);
  a.push("-c:a", "libopus", "-b:a", config.opusBitrate);
  if (config.opusVbr === "off") a.push("-vbr", "off");
  else if (config.opusVbr === "constrained") a.push("-vbr", "constrained");
  else a.push("-vbr", "on");
  if (["audio", "voip", "lowdelay"].includes(config.opusApplication))
    a.push("-application", config.opusApplication);
  const fd = Number(config.opusFrameDuration);
  if ([2.5, 5, 10, 20, 40, 60].includes(fd)) a.push("-frame_duration", String(fd));
  const cx = Number(config.opusComplexity);
  if (Number.isFinite(cx) && cx >= 0 && cx <= 10) a.push("-compression_level", String(cx));
  if (config.ffmpegExtraArgs && config.ffmpegExtraArgs.trim())
    a.push(...config.ffmpegExtraArgs.trim().split(/\s+/));
  a.push("-f", "ogg", "pipe:1");
  return a;
}
// ffmpeg with stdin input (caller pipes audio bytes in). Same output/cushion
// plumbing as the universal pipe; helper=null (no yt-dlp child).
function spawnFfmpegStdin(tag, offsetSec) {
  if (!FFMPEG_AVAILABLE) throw new Error("ffmpeg binary not available");
  const ff = spawn(FFMPEG || "ffmpeg", ffmpegStdinArgs(offsetSec), { stdio: ["pipe", "pipe", "pipe"] });
  ff.on("error", (e) => logPretty("ERROR", `ffmpeg(${tag}) error: ` + (e?.message || e)));
  ff.stdout.on("error", swallowPipeError);
  ff.stderr.on("error", swallowPipeError);
  ff.stdin.on("error", swallowPipeError);
  ff.stderr.on("data", (d) => { try { logPretty("LOG", `[ffmpeg(${tag})] ` + d.toString().trim()); } catch { } });
  return { ff, stream: cushionStream(ff), helper: null, raw: ff.stdout };
}
// Wrap an ffmpeg process's stdout in a PassThrough cushion (up to 384KB ≈
// 24s of 128k audio) so slow-starting sources don't stutter the beginning.
// Data is preserved for playback; probe the LIVE raw output separately.
function cushionStream(ff) {
  const cushion = new PassThrough({ highWaterMark: 384 * 1024 });
  cushion.on("error", swallowPipeError);
  ff.stdout.pipe(cushion);
  cushion.on("close", () => { try { ff.stdout.unpipe(cushion); } catch { } });
  return cushion;
}
// Wait until minBytes are cushioned (or source dies / timeout) before playing.
// Uses 'readable' (not 'data') so nothing is consumed before demuxProbe.
async function awaitPrebuffer(pipeObj, minBytes, maxWaitMs) {
  const s = pipeObj?.stream;
  if (!s || s.destroyed || minBytes <= 0) return;
  if ((s.readableLength || 0) >= minBytes) return;
  await new Promise((resolve) => {
    let done = false;
    const cleanup = () => { clearTimeout(timer); s.off("readable", onReadable); s.off("close", onClose); s.off("error", onClose); };
    const finish = () => { if (!done) { done = true; cleanup(); resolve(); } };
    const onReadable = () => { if ((s.readableLength || 0) >= minBytes) finish(); };
    const onClose = () => finish(); // dead source → let probe fail fast
    const timer = setTimeout(finish, maxWaitMs);
    s.on("readable", onReadable);
    s.on("close", onClose);
    s.on("error", onClose);
  });
}

// Spawn a TikTok pipeline using yt-dlp piping directly into ffmpeg. This avoids
// fetching the TikTok media URL via ffmpeg (which often results in 403
// Forbidden responses). Instead, yt-dlp is responsible for downloading the
// media, and ffmpeg consumes the stream from stdin. The returned object
// includes the ffmpeg process, its stdout stream, and the yt-dlp helper
// process for cleanup.
function spawnTikTokPipe(pageUrl) {
  if (!FFMPEG_AVAILABLE) {
    throw new Error("ffmpeg binary not available");
  }
  // Build yt-dlp CLI arguments. We respect configuration options such as
  // force IPv4 and cookie file. The output is written to stdout ("-") so
  // ffmpeg can read it from a pipe.
  const ytdlpArgs = [];
  // use force-ipv4 if configured
  if (config.ytdlpForceIpv4) {
    ytdlpArgs.push("--force-ipv4");
  }
  // use cookie file if provided
  const legacyCk = effectiveCookieFile();
  if (legacyCk) {
    ytdlpArgs.push("--cookies", legacyCk);
  }
  // Basic resilient settings
  ytdlpArgs.push(
    "--no-check-certificates",
    "--retries", "infinite",
    "--fragment-retries", "infinite",
    "-f", "ba",
    "-o", "-",
    "--js-runtimes", "node",
    pageUrl
  );
  // Spawn yt-dlp process
  const helper = spawn("yt-dlp", ytdlpArgs, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  helper.on("error", (e) => logPretty("ERROR", "yt-dlp spawn error: " + (e?.message || e)));
  helper.stderr.on("error", swallowPipeError);
  helper.stderr.on("data", (d) => {
    try {
      logPretty("LOG", "[yt-dlp] " + d.toString().trim());
    } catch { }
  });
  // Build ffmpeg arguments based on our audio configuration. Unlike
  // spawnFfmpegFromDirectUrl, we do not include reconnect flags because
  // yt-dlp is handling network access. We still honor low‑latency and
  // audio quality settings.
  const a = [];
  a.push("-loglevel", "info", "-hide_banner");
  if (config.ffmpegLowLatency) {
    a.push(
      "-fflags", "+nobuffer",
      "-flags", "low_delay",
      "-analyzeduration", String(config.ffmpegInputAnalyzeMs * 1000),
      "-probesize", "32k"
    );
  } else {
    const us = Math.max(0, config.ffmpegInputAnalyzeMs) * 1000;
    a.push("-analyzeduration", String(us), "-probesize", "256k");
  }
  // Input from stdin (pipe)
  a.push("-i", "pipe:0");
  // Drop any video
  a.push("-vn");
  // Channels and sample rate
  a.push("-ac", String(config.audioChannels));
  a.push("-ar", String(config.audioSampleRate));
  // Optional audio filter
  const afChain = (config.audioFilter || "").trim();
  if (afChain) {
    a.push("-af", afChain);
  }
  // Opus encoding settings
  a.push("-c:a", "libopus");
  a.push("-b:a", config.opusBitrate);
  if (config.opusVbr === "off") {
    a.push("-vbr", "off");
  } else if (config.opusVbr === "constrained") {
    a.push("-vbr", "constrained");
  } else {
    a.push("-vbr", "on");
  }
  if (["audio", "voip", "lowdelay"].includes(config.opusApplication)) {
    a.push("-application", config.opusApplication);
  }
  const fd = Number(config.opusFrameDuration);
  if ([2.5, 5, 10, 20, 40, 60].includes(fd)) {
    a.push("-frame_duration", String(fd));
  }
  const cx = Number(config.opusComplexity);
  if (Number.isFinite(cx) && cx >= 0 && cx <= 10) {
    a.push("-compression_level", String(cx));
  }
  if (config.ffmpegExtraArgs && config.ffmpegExtraArgs.trim()) {
    a.push(...config.ffmpegExtraArgs.trim().split(/\s+/));
  }
  a.push("-f", "ogg", "pipe:1");
  // Spawn ffmpeg process
  const ff = spawn(FFMPEG || "ffmpeg", a, {
    stdio: ["pipe", "pipe", "pipe"],
  });
  ff.on("error", (e) => logPretty("ERROR", "ffmpeg(tiktok) spawn error: " + (e?.message || e)));
  ff.stdout.on("error", swallowPipeError);
  ff.stderr.on("error", swallowPipeError);
  ff.stderr.on("data", (d) => {
    try {
      logPretty("LOG", "[ffmpeg(tiktok)] " + d.toString().trim());
    } catch { }
  });
  // Pipe yt-dlp stdout into ffmpeg stdin
  helper.stdout.pipe(ff.stdin);
  return { ff, stream: ff.stdout, helper };
}

// Playlist helper: fetch entries list
// Returns [{ title, url }] from playlist/mix links or search queries (ytsearchN:)
async function fetchPlaylistEntries(input, limit = null) {
  // If limit is omitted:
  // - URL playlist: fetch ALL items (still protected by playlistHardCap)
  // - search text: default to 25 results
  const isInputUrl = isUrl(input);

  const hardCap = Math.max(1, Number(config.playlistHardCap) || 5000);

  let max;
  if (limit === null || limit === undefined) {
    max = isInputUrl ? Infinity : 25;
  } else {
    max = Math.min(Math.max(Number(limit) || 25, 1), hardCap);
  }

  const entries = [];
  try {
    if (isInputUrl) {
      const info = await ytdlp(input, ytdlpOpts({
        dumpSingleJson: true,
        "yes-playlist": true,
        "flat-playlist": true,
      }));
      const arr = info?.entries || [];
      for (const e of arr) {
        if (Number.isFinite(max) && entries.length >= max) break;
        // Safety: even if max is Infinity, keep a hard cap to prevent runaway memory usage
        if (entries.length >= hardCap) break;

        const url = e?.webpage_url || e?.url || (e?.id ? `https://www.youtube.com/watch?v=${e.id}` : null);
        const title = e?.title || e?.id || "unknown";
        if (url) entries.push({ title, url, thumb: pickThumb(e, url), durationSec: numOrNull(e?.duration) });
      }
    } else {
      const n = Number.isFinite(max) ? max : 25;
      const out = await ytdlp(`ytsearch${n}:${input}`, ytdlpOpts({ dumpSingleJson: true }));
      const arr = out?.entries || [];
      for (const e of arr) {
        if (entries.length >= n) break;
        const url = e?.webpage_url || e?.url || (e?.id ? `https://www.youtube.com/watch?v=${e.id}` : null);
        const title = e?.title || e?.id || "unknown";
        if (url) entries.push({ title, url, thumb: pickThumb(e, url), durationSec: numOrNull(e?.duration) });
      }
    }
  } catch (err) {
    logPretty("ERROR", "fetchPlaylistEntries fail: " + (err?.message || err));
  }

  if (!Number.isFinite(max)) return entries;
  return entries.slice(0, max);
}

// Player helper functions
// Playback-finished jingle: played in the voice room when a song/playlist
// naturally ends (Assets/Bocchi-…-再生完了曲.mp3).
const END_CHIME_PATH = path.join(__dirname, "Assets", "Bocchi-2026-09-29-00-31-再生完了曲.mp3");
async function playEndChime(guild, state) {
  try {
    if (state.current || state.queue.length) return; // something took over
    if (!fs.existsSync(END_CHIME_PATH)) return;
    const conn = getVoiceConnection(guild.id);
    if (!conn || conn.state.status === VoiceConnectionStatus.Destroyed) return;
    logPretty("INFO", `Queue finished — playing end jingle in ${guild.name}`);
    const resource = createAudioResource(END_CHIME_PATH, { inlineVolume: false });
    await new Promise((resolve) => {
      const finish = () => { clearTimeout(timer); state.player.off("idle", finish); resolve(); };
      const timer = setTimeout(finish, 20000);
      state.player.once("idle", finish);
      try { state.player.play(resource); } catch { finish(); }
    });
  } catch (e) { logPretty("WARN", `End jingle failed: ${e?.message || e}`); }
}
async function handlePlayerIdle(guild, state) {
  stopNowPlayingTicker(state);
  cleanupCurrentPipeline(state);
  state.currentResource = null;
  state.currentLyrics = null;
  state.pausedAt = null;
  if (!state.current) return;

  const finished = state.current;
  const manualSkip = state.skipRequested;
  state.skipRequested = false;

  logPretty("NOWPLAY", `FINISHED  ${finished.title}`);

  // Track history for ⏮ previous (skip re-push on prev-jumps + loop replays).
  if (!state.prevJump && finished && finished.source) {
    const h = state.history || (state.history = []);
    if (!h.length || h[h.length - 1].title !== finished.title) {
      h.push({ title: finished.title, source: finished.source, thumb: finished.thumb || null, durationSec: finished.durationSec || null, requestedBy: finished.requestedBy });
      if (h.length > 30) h.shift();
    }
  }
  state.prevJump = false;

  // Same track dying within seconds over and over (loop + broken source):
  // break the loop instead of retry-storming forever.
  const nowT = Date.now();
  if (state.lastStart && state.lastStart.title === finished.title && nowT - state.lastStart.t < 15000) state.quickFails = (state.quickFails || 0) + 1;
  else state.quickFails = 0;
  if (state.quickFails >= 3 && (state.loopMode === "track" || state.loopMode === "queue") && !manualSkip) {
    state.loopMode = "off";
    state.quickFails = 0;
    logPretty("ERROR", `Giving up loop on "${finished.title}" (died 3x in a row)`);
    const loopWarnMsg = await sendToTextChannel(guild, finished.textChannelId, { embeds: [
      makeEmbed(COLORS.warning)
        .setDescription(`### ⛔  Stopped looping\n**${cleanTitle(finished.title)}** keeps failing — loop is off. Check \`/ytstatus\` or re-upload cookies with \`/ytsignin\`.`)
    ]});
    if (loopWarnMsg) setTimeout(() => loopWarnMsg.delete().catch(() => {}), 3 * 60 * 1000);
    state.current = null;
    await playNext(guild, finished.textChannelId, state);
    return;
  }

  if (state.loopMode === "track" && !manualSkip) {
    state.restartGuard.tried = false;
    await playSame(guild, finished.textChannelId, finished, state);
    return;
  }

  if (state.loopMode === "queue") {
    state.queue.push({ ...finished });
  }

  state.current = null;
  await playNext(guild, finished.textChannelId, state);
  if (!manualSkip && !state.queue.length && !state.current) await playEndChime(guild, state);
}

async function handlePlayerError(error, guild, state) {
  // Teardown noise? A skip/stop/switch just killed this pipe on purpose.
  if (state.lastTeardownAt && Date.now() - state.lastTeardownAt < 3000) return;
  logPretty("ERROR", `Player error: ${error?.message || error}`);
  // Capture up front: the Idle handler can null state.current concurrently.
  const cur = state.current;
  const tc = cur?.textChannelId;
  if (!cur || !tc) return;

  if (!state.restartGuard.tried) {
    state.restartGuard.tried = true;
    logPretty("WARN", `STREAM DROP — retrying once`, { tail: cur.title });
    const signalMsg = await sendToTextChannel(guild, tc, {
      embeds: [
        makeEmbed(COLORS.warning)
          .setDescription("### 🔁 Signal lost\nReconnecting…")
      ]
    });
    if (signalMsg) setTimeout(() => signalMsg.delete().catch(() => {}), 3 * 60 * 1000);
    await playSame(guild, tc, cur, state);
    return;
  }

  await playNext(guild, tc, state);
}

async function playNext(guild, textChannelId, state = getGuildState(guild)) {
  const myGen = ++state.gen; // supersede any older in-flight playback
  const stale = () => myGen !== state.gen;
  state.restartGuard.tried = false;
  cleanupCurrentPipeline(state);
  // A new song arrived while waiting — cancel the goodbye countdown.
  // Remember if we were already waiting so we don't spam the message twice.
  const wasWaiting = !!state.leaveTimer;
  if (state.leaveTimer) { clearTimeout(state.leaveTimer); state.leaveTimer = null; }

  if (!state.queue.length) {
    stopNowPlayingTicker(state);
    state.current = null;
    state.startedAt = null;
    state.currentLyrics = null;
    state.pausedAt = null;
    const waitSec = config.disconnectDelaySec;
    const waitMin = Math.round(waitSec / 60);
    logPretty("INFO", `QUEUE EMPTY — waiting ${waitMin} min for new songs`);
    if (!wasWaiting) {
      // Reuse the living Now Playing message as the idle notice (clean UI).
      const idle = makeEmbed(COLORS.info)
        .setTitle("📭 Queue is empty")
        .setDescription(`Waiting **${waitMin} more min** for new songs\nAdd with \`/play\`!`)
        .setTimestamp();
      await upsertNpMessage(guild, getSavedControlChannel(guild.id) || textChannelId, idle, false);
    }
    // Stay in voice; leave only if nothing queued within the wait window.
    if (state.leaveTimer) clearTimeout(state.leaveTimer);
    state.leaveTimer = setTimeout(async () => {
      state.leaveTimer = null;
      if (state.queue.length || state.current) return; // song came in — stay
      const vc = getVoiceConnection(guild.id);
      if (vc) vc.destroy();
      logPretty("INFO", "Wait over — disconnecting");
      await sendToTextChannel(guild, textChannelId, {
        embeds: [
          makeEmbed(COLORS.info).setDescription("### 👋 Left voice\nCall me back anytime with `/play`!")
        ]
      });
    }, waitSec * 1000);
    return;
  }

  const next = state.queue.shift();
  stopNowPlayingTicker(state);
  state.current = next;
  state.currentLyrics = null;
  state.pausedAt = null;

  try {
    // Lyrics resolve in parallel with audio extraction — no added delay.
    const lyrP = fetchLyrics(next.title).catch(() => null);
    // Use unified playback helper; this will throw on resolution errors.
    // stayPut: automatic queue advances never move rooms. Fresh /play-style
    // requests already validated same-room-or-no-connection, so staying is safe.
    const { pageUrl } = await startPlayback(guild, next, state, true);
    if (stale()) return; // a newer playback took over — don't touch state
    state.startedAt = Date.now();
    state.pausedAt = null;
    state.lastStart = { title: next.title, t: Date.now() };
    state.failStreak = 0;
    logPretty("NOWPLAY", `${next.title}`, {
      user:  next.requestedBy,
      tail: `up_next: ${state.queue[0]?.title || "—"}`,
    });
    const lyrics = await lyrP;
    if (stale()) return;
    state.currentLyrics = lyrics;
    const controlChannelId = getSavedControlChannel(guild.id) || next.textChannelId;
    await upsertNpMessage(guild, controlChannelId, buildNowPlayingEmbed(state, lyrics));
    startNowPlayingTicker(guild, state);
  } catch (e) {
    if (stale()) { // put the song back — the newer flow owns the queue now
      try { if (state.current !== next && next) state.queue.unshift(next); } catch {}
      return;
    }
    const reason = String(e?.message || e || "unknown").slice(0, 300);
    // Cookieless fallback: sign-in/PO-token/403 failure → retry once with the
    // alternate YouTube player client before giving up on the song.
    if (/sign in|PO Token|403|HTTP Error 403/i.test(reason) && next && !next.altClient && !isTikTokUrl(next.source)) {
      next.altClient = altPlayerClient(config.ytdlpPlayerClient);
      state.current = null;
      state.queue.unshift(next);
      logPretty("WARN", `Retrying "${next.title}" with player-client=${next.altClient} (no cookies needed?)`);
      const retryMsg = await sendToTextChannel(guild, next.textChannelId, { embeds: [
        makeEmbed(COLORS.info)
          .setDescription(`### 🔄  Trying another way\n**${cleanTitle(next.title)}** needs sign-in on this client — retrying without cookies…`)
      ]});
      if (retryMsg) setTimeout(() => retryMsg.delete().catch(() => {}), 5 * 60 * 1000);
      await playNext(guild, textChannelId, state);
      return;
    }
    // Same title failing repeatedly → give up instead of looping forever.
    if (next?.title && state.lastFailTitle === next.title) state.failStreak = (state.failStreak || 0) + 1;
    else { state.lastFailTitle = next?.title || null; state.failStreak = 1; }
    const hint = /sign in|cookies|PO Token|403/i.test(reason)
      ? "\n💡 YouTube wants sign-in — admin, re-upload cookies with `/ytsignin`"
      : "";
    logPretty("ERROR", "play error: " + reason);
    if ((state.failStreak || 0) >= 3) {
      logPretty("ERROR", `Giving up on "${next?.title}" after 3 straight failures`);
      const giveUpMsg = await sendToTextChannel(guild, next.textChannelId, { embeds: [
        makeEmbed(COLORS.error)
          .setDescription(`### ⛔  Giving up\n**${cleanTitle(next?.title)}** failed 3 times in a row — removed from rotation.`)
      ]});
      if (giveUpMsg) setTimeout(() => giveUpMsg.delete().catch(() => {}), 3 * 60 * 1000);
      if (state.loopMode === "track") state.loopMode = "off";
      state.failStreak = 0;
      state.current = null;
      await playNext(guild, textChannelId, state);
      return;
    }
    const skipWarnMsg = await sendToTextChannel(guild, next.textChannelId, {
      embeds: [
        makeEmbed(COLORS.warning)
          .setDescription(`### ⚠️  Skipped this track (not a skip command)\n**${next?.title ?? "Unknown"}** failed: \`${reason}\`${hint}`)
      ]
    });
    if (skipWarnMsg) setTimeout(() => skipWarnMsg.delete().catch(() => {}), 3 * 60 * 1000);
    state.current = null;
    await playNext(guild, textChannelId, state);
  }
}

async function playSame(guild, textChannelId, item, state = getGuildState(guild)) {
  const myGen = ++state.gen;
  const stale = () => myGen !== state.gen;
  try {
    state.current = item;
    stopNowPlayingTicker(state);
    state.currentLyrics = null;
    state.pausedAt = null;
    cleanupCurrentPipeline(state);
    // Reuse unified playback helper; any errors will be caught below.
    // stayPut: loop/retry/seek never move rooms — only new requests do.
    await startPlayback(guild, item, state, true);
    if (stale()) return;
    state.startedAt = Date.now();
    state.pausedAt = null;
    state.lastStart = { title: item.title, t: Date.now() };
    logPretty("WARN", `RESTARTED  ${item.title}`);
    const lyrRe = await fetchLyrics(item.title).catch(() => null);
    if (stale()) return;
    state.currentLyrics = lyrRe;
    const controlChannelId = getSavedControlChannel(guild.id) || textChannelId;
    await upsertNpMessage(guild, controlChannelId, buildNowPlayingEmbed(state, lyrRe));
    startNowPlayingTicker(guild, state);
  } catch (err) {
    const msg = String(err?.message || err || "");
    logPretty("ERROR", "playSame error: " + msg);
    if (stale()) return;
    // Same cookieless fallback as playNext: retry once, other client.
    if (/sign in|PO Token|403|HTTP Error 403/i.test(msg) && item && !item.altClient && !isTikTokUrl(item.source)) {
      item.altClient = altPlayerClient(config.ytdlpPlayerClient);
      logPretty("WARN", `Retrying "${item.title}" with player-client=${item.altClient}`);
      await playSame(guild, textChannelId, item, state);
      return;
    }
    state.current = null;
    await playNext(guild, textChannelId, state);
  }
}

function applyVolume(state) {
  try {
    const pct = Number.isFinite(state.volumePct) ? state.volumePct : 100;
    state.currentResource?.volume?.setVolumeLogarithmic(Math.max(pct, 0) / 100);
  } catch { }
}

// Prepare and start playback: resolve the audio URL, spawn ffmpeg, probe the stream and play.
async function startPlayback(guild, item, state, stayPut = false) {
  // Ensure the bot is connected to the correct voice channel and subscribed to the player
  ensureVC(guild, item.voiceChannelId, state, { stay: stayPut });

  // Resolve source: convert Spotify track → search query if needed.
  // For everything else (YouTube URL, search text, SoundCloud URL etc.)
  // we pass it straight to yt-dlp which handles search internally.
  let source = item.source;
  if (isSpotifyUrl(source)) {
    const kind = spotifyKind(source);
    if (kind === "album" || kind === "playlist") throw new Error("Spotify albums/playlists not supported in play; use /playlist");
    const q = await spotifyTrackToSearchQuery(source);
    if (!q) throw new Error("cannot resolve Spotify track title");
    source = `ytsearch1:${q}`;
  } else if (!isUrl(source)) {
    // Plain text search query — prefix with ytsearch so yt-dlp searches YouTube
    source = `ytsearch1:${source}`;
  }

  // TikTok: metadata via TikWM. Audio is streamed via Cloudflare Worker proxy
  // to avoid Railway/AWS datacenter IP blocks. Falls back to yt-dlp.
  if (isTikTokUrl(source)) {
    try {
      const meta = await tiktokMeta(source);
      if (item.title === item.source) item.title = meta.title;
      if (!item.thumb && meta.thumb) item.thumb = meta.thumb;
      
      // Use the direct TikTok CDN URL (meta.audioUrl). The proxyAudioUrl is behind Cloudflare
      // and blocks datacenter IPs like Railway. Node.js fetch() works fine against TikTok CDN directly.
      const fetchUrl = meta.audioUrl;
      logPretty("LOG", `[tikwm] audio (fetch) <- ${fetchUrl.slice(0, 90)}...`);
      
      // Node.js fetch() easily bypasses Cloudflare's Bot Fight Mode which was blocking
      // ffmpeg and yt-dlp on Railway datacenter IPs. We fetch the stream and pipe it.
      const res = await fetch(fetchUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' }
      });
      if (!res.ok) throw new Error(`Fetch returned ${res.status}`);
      
      const { Readable } = require("stream");
      const pipeObj = spawnFfmpegStdin("tiktok-cf", consumeOffset(item, state));
      Readable.fromWeb(res.body).pipe(pipeObj.ff.stdin);
      
      await playPipe(guild, item, state, pipeObj);
      return { pageUrl: source };
    } catch (e) {
      logPretty("WARN", `[tikwm] failed (${e?.message || e}), falling back to direct yt-dlp`);
    }
  }

  // All sources go through the yt-dlp→ffmpeg pipe. This avoids CDN URL
  // expiry (YouTube) and 403 errors because yt-dlp owns the download instead
  // of ffmpeg fetching over HTTP. item.altClient = retry with the other
  // YouTube player client (cookieless fallback).
  await playPipe(guild, item, state, spawnUniversalPipe(source, item.altClient || undefined, consumeOffset(item, state)));
  return { pageUrl: source };
}

// Seek support: consume a one-shot offset (seconds of track time) stored on
// the item, anchor the progress bar to it. Returns 0 when none.
function consumeOffset(item, state) {
  const off = Number(item?.offsetSec);
  item.offsetSec = 0;
  const clean = Number.isFinite(off) && off > 0 ? off : 0;
  state.posBase = clean;
  return clean;
}

// Play an already-spawned pipe: probe live output, pre-buffer, then hand to Discord.
async function playPipe(guild, item, state, pipeObj) {
  state.currentPipe = pipeObj;
  // A newer playback may have destroyed this pipe already (superseded race).
  if (pipeObj.stream?.destroyed) throw new Error("pipe destroyed (superseded by newer playback)");
  // Probe the LIVE ffmpeg stdout (proven path). Probing the cushion after it
  // filled loses the head on fast/small files (EOF race) → 0 packets → songs
  // "finish" instantly with no error. Playback still reads from the cushion.
  const probeP = demuxProbe(pipeObj.raw || pipeObj.stream);
  // demuxProbe pauses the raw stream on finish — resume it, or the
  // ff.stdout→cushion pipe stays frozen (~137B in cushion) and ffmpeg stalls
  // forever with the player stuck buffering.
  probeP.then(
    () => { try { pipeObj.raw?.resume?.(); } catch { } },
    () => { try { pipeObj.raw?.resume?.(); } catch { } },
  );
  // Smooth start: let ~4s of audio cushion up before Discord reads, so
  // yt-dlp's slow first seconds don't stutter the beginning.
  await awaitPrebuffer(pipeObj, (config.prebufferKB || 0) * 1024, config.prebufferWaitMs);
  const { type } = await probeP;
  const stream = pipeObj.stream;
  try { logPretty("LOG", `[pipe] probe=${type} cushion=${stream?.readableLength ?? "?"}B destroyed=${!!stream?.destroyed} ended=${!!stream?.readableEnded}`); } catch { }
  // Dead source (e.g. YouTube sign-in wall): probe found no audio container
  // and almost nothing buffered. Throw so the retry/skip machinery engages
  // instead of "playing" 0 bytes and instantly finishing in silence.
  if ((type === "arbitrary" || type === "Arbitrary") && (stream?.readableLength ?? 0) < 1024) {
    throw new Error("empty audio stream — YouTube sign in wall? (0 bytes received)");
  }
  const resource = createAudioResource(stream, { inputType: type, inlineVolume: true });
  state.currentResource = resource;
  applyVolume(state);
  state.player.play(resource);
  return { type };
}

function setVolumePct(state, pct) {
  if (pct < 0) pct = 0;
  if (pct > 10000) pct = 10000;
  state.volumePct = pct;
  applyVolume(state);
  // Remember per server across restarts
  try { if (state.guildId) setSavedVolume(state.guildId, pct); } catch { }
}

client.on("error", (e) => logPretty("ERROR", `Client error: ${e?.message || e}`));
process.on("unhandledRejection", (e) => logPretty("ERROR", `unhandledRejection: ${e}`));

// Ready event and command handling
const restClient = new REST({ version: "10" }).setToken(config.token);
client.once(Events.ClientReady, async () => {
  const tag = client.user.tag;
  const guildCount = client.guilds.cache.size;
  console.log("");
  console.log(`  ${C.bold}${C.bgGreen}\x1b[30m  ✓ ONLINE  ${R}  ${C.bold}${C.green}${tag}${R}  ${C.gray}·${R}  ${C.white}${guildCount} server(s)${R}`);
  console.log("");
  try {
    await restClient.put(Routes.applicationCommands(client.user.id), { body: commands });
    logPretty("SYSTEM", "Slash commands registered");
  } catch (e) {
    logPretty("ERROR", "register error: " + (e?.message || e));
  }
  // Schedule automatic yt-dlp updates only if enabled in the configuration
  if (config.ytdlpAutoUpdate) {
    scheduleDailyBangkokMidnight(() => runYtDlpUpdate());
    const ONE_DAY = 24 * 3600 * 1000;
    if (Date.now() - readLastUpdateTs() > ONE_DAY) runYtDlpUpdate();
  }
});

client.on("interactionCreate", async (itx) => {
  if (itx.isAutocomplete()) {
    if (itx.commandName === "remove") {
      const state = getGuildState(itx.guild);
      if (!state.queue || state.queue.length === 0) {
        return await itx.respond([]);
      }
      const focusedValue = (itx.options.getFocused() || "").toString().toLowerCase();
      const choices = state.queue.map((item, i) => {
        const title = item.title.length > 80 ? item.title.substring(0, 80) + "..." : item.title;
        return { name: `${i + 1}. ${title}`, value: i + 1 };
      });
      const filtered = choices.filter(choice => choice.name.toLowerCase().includes(focusedValue)).slice(0, 25);
      await itx.respond(filtered);
    }
    return;
  }
  // Music control buttons
  if (itx.isButton && itx.isButton()) {
    try {
      if (String(itx.customId || "").startsWith("mus_")) return await handleMusicButton(itx);
    } catch (e) { try { await itx.reply({ content: "Error: " + (e?.message || e), flags: MessageFlags.Ephemeral }); } catch { } return; }
    return;
  }
  if (!itx.isChatInputCommand()) return;
  // Calculate round-trip time. Clamp at zero to avoid negative values when clocks differ.
  const rttRaw = Date.now() - itx.createdTimestamp;
  const rtt = rttRaw < 0 ? 0 : rttRaw;
  logPretty("COMMAND", `/${itx.commandName}`, {
    user: itx.user.tag,
    guild: itx.guild.name,
    rtt,
  });

  if (itx.commandName === "help") {
    return itx.reply({ embeds: [buildHelpEmbedSlash()] });
  }

  if (itx.commandName === "ai") {
    const question = itx.options.getString("question", true).trim();
    if (!config.geminiApiKey && !config.openRouterApiKey) {
      return itx.reply({ content: "AI is not configured. Set GEMINI_API_KEY or OPENROUTER_API_KEY in .env and restart the bot.", flags: MessageFlags.Ephemeral });
    }
    await itx.deferReply();
    try {
      const privateSession = await getPrivateAiSession(itx);
      let answer;
      if (privateSession) {
        answer = await askGemini(question, privateSession.history, privateSession.persona);
        privateSession.history = [...privateSession.history, { role: "user", parts: [{ text: question }] }, { role: "model", parts: [{ text: answer }] }].slice(-20);
      } else {
        answer = await askGeminiWithHistory(question, aiSessionKeyForChannel(itx.guildId, itx.channelId));
      }
      return itx.editReply({ content: answer, allowedMentions: { parse: [] } });
    } catch (error) {
      const message = error?.name === "AbortError"
        ? "Gemini took too long to respond. Please try again."
        : (error?.message || "Gemini request failed.");
      return itx.editReply({ content: message, allowedMentions: { parse: [] } });
    }
  }

  if (itx.commandName === "airef") {
    await itx.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const privateSession = await getPrivateAiSession(itx);
      const reset = itx.options.getBoolean("reset") === true;
      let persona = "";
      if (!reset) {
        persona = itx.options.getString("persona")?.trim()
          || fs.readFileSync(path.join(__dirname, "Ref", "Ai_Tsun.txt"), "utf8").trim();
        if (!persona) throw new Error("Persona text is empty. Add persona text or restore Ref/Ai_Tsun.txt.");
      }
      if (privateSession) {
        privateSession.persona = persona;
        setAiPersona(`private:${itx.guildId}:${privateSession.thread.id}`, persona);
      } else {
        setAiPersona(aiSessionKeyForChannel(itx.guildId, itx.channelId), persona);
      }
      return itx.editReply({ content: reset
        ? "Reset this chat to Gemini's default personality. Other chats are unchanged."
        : `Applied this persona to the current chat only (${persona.length} characters). Other chats are unchanged.` });
    } catch (error) {
      return itx.editReply({ content: `Could not set this chat's persona: ${error?.message || error}` });
    }
  }

  if (itx.commandName === "clear") {
    await itx.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await clearGuildAiChats(itx.guildId);
    return itx.editReply({ content: `Cleared ${result.clearedHistories} saved AI conversation(s) and closed ${result.closedPrivateChats} temporary private chat(s). Public channel messages were not deleted.` });
  }

  if (itx.commandName === "delete") {
    const ownedSession = [...privateAiSessions.entries()].find(([, session]) =>
      session.guildId === itx.guildId && session.userId === itx.user.id);
    const currentPrivateThread = itx.channel?.isThread?.()
      && itx.channel.type === ChannelType.PrivateThread
      && itx.channel.name.startsWith("private-ai-")
      ? itx.channel
      : null;
    const thread = ownedSession?.[1].thread || currentPrivateThread;
    if (!thread) {
      return itx.reply({ content: "You do not have an active private AI chat to delete.", flags: MessageFlags.Ephemeral });
    }
    await itx.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      if (!ownedSession) {
        const members = await thread.members.fetch();
        if (!members.has(itx.user.id)) throw new Error("Only a member of this private chat can delete it.");
      }
      await thread.delete("Private AI chat deleted by its owner");
      privateAiSessions.delete(thread.id);
      aiChatBusy.delete(`private:${thread.id}`);
      setAiPersona(`private:${itx.guildId}:${thread.id}`, "");
      return itx.editReply({ content: "Your private AI chat and its temporary conversation history were deleted." });
    } catch (error) {
      return itx.editReply({ content: `Could not delete your private chat. The bot needs Manage Threads permission. (${error?.message || error})` });
    }
  }

  if (itx.commandName === "deletep") {
    if (!itx.options.getBoolean("confirm", true)) {
      return itx.reply({ content: "Deletion cancelled. Run `/deletep` with `confirm: true` to remove all public AI chat messages.", flags: MessageFlags.Ephemeral });
    }
    await itx.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const deleted = await deletePublicAiChat(itx.guild);
      return itx.editReply({ content: `Deleted ${deleted} message(s) from the public AI chat and cleared its saved AI context.` });
    } catch (error) {
      return itx.editReply({ content: `Could not delete the public AI chat messages. ${error?.message || error}` });
    }
  }

  if (itx.commandName === "setai") {
    await itx.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const savedChannelId = getSavedAiChannel(itx.guildId);
      const savedChannel = savedChannelId ? await itx.guild.channels.fetch(savedChannelId).catch(() => null) : null;
      const channel = savedChannel || await itx.guild.channels.create({
        name: "ai-chat",
        type: ChannelType.GuildText,
        topic: "Public AI chat. Messages here are answered by the music bot’s Gemini assistant.",
        permissionOverwrites: [{
          id: itx.guild.roles.everyone.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
        }],
      });
      setSavedAiChannel(itx.guildId, channel.id);
      return itx.editReply({ content: `Public AI chat is ready: <#${channel.id}>` });
    } catch (error) {
      return itx.editReply({ content: `Could not create the AI chat channel. The bot needs Manage Channels permission. (${error?.message || error})` });
    }
  }

  if (itx.commandName === "setaip") {
    await itx.deferReply({ flags: MessageFlags.Ephemeral });
    if (!config.geminiApiKey && !config.openRouterApiKey) {
      return itx.editReply({ content: "AI is not configured. Ask a server admin to set a Gemini or OpenRouter API key." });
    }
    try {
      const existing = [...privateAiSessions.entries()].find(([, session]) =>
        session.guildId === itx.guildId && session.userId === itx.user.id);
      if (existing) {
        return itx.editReply({ content: `Your private AI chat is ready: <#${existing[0]}>. It stays until you run /delete.` });
      }
      const parent = itx.channel?.isThread?.() ? itx.channel.parent : itx.channel;
      if (!parent?.threads?.create) throw new Error("Run /setaip in a server text channel.");
      const username = itx.user.username.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 70) || "user";
      const thread = await parent.threads.create({
        name: `private-ai-${username}`,
        type: ChannelType.PrivateThread,
        autoArchiveDuration: 60,
        invitable: false,
        reason: "Temporary private AI chat",
      });
      await thread.members.add(itx.user.id);
      const session = { guildId: itx.guildId, userId: itx.user.id, thread, history: [], persona: "" };
      privateAiSessions.set(thread.id, session);
      return itx.editReply({ content: `Your private AI chat is ready: <#${thread.id}>. It stays until you run /delete.` });
    } catch (error) {
      return itx.editReply({ content: `Could not create the private AI chat. The bot needs Create Private Threads, Send Messages in Threads, and Manage Threads permissions. (${error?.message || error})` });
    }
  }

  if (itx.commandName === "setup") {
    if (!isGuildAdmin(itx.member)) {
      return itx.reply({ content: "Manage Server permission required.", flags: MessageFlags.Ephemeral });
    }
    await itx.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const { voiceRoom, channel } = await runBocchiSetup(itx.guild);
      return itx.editReply({ content: `Done! Joined <#${voiceRoom.id}> (saved as the music room) and posted controls in <#${channel.id}>.` });
    } catch (error) {
      return itx.editReply({ content: `Could not set up the music control channel: ${error?.message || error}` });
    }
  }

  const me = itx.guild.members.me;
  const userVC = itx.member?.voice?.channelId;
  const botVC = me?.voice?.channelId;
  const sameVC = userVC && (!botVC || botVC === userVC);

  const needsSameVC = !["help", "ai", "ping", "botupdate", "np", "queue", "panel", "ytstatus", "ytsignin", "ytsignout", "watchtogether", "vstate"].includes(itx.commandName);

  if (needsSameVC && !sameVC) {
    return itx.reply({ embeds: [errorEmbed("Please join the bot's voice channel first 🎙️")], flags: MessageFlags.Ephemeral });
  }

  const state = getGuildState(itx.guild);

  if (itx.commandName === "ping") {
    await itx.reply({
      embeds: [
        makeEmbed(COLORS.info)
          .setDescription("### 🏓  Pong!")
          .addFields(
            { name: "🌐 WebSocket", value: `\`${Math.round(itx.client.ws.ping)} ms\``, inline: true },
            { name: "⏱️ RTT", value: `\`${rtt} ms\``, inline: true },
          )
      ]
    });
    return;
  }

  if (itx.commandName === "botupdate") {
    await itx.deferReply({ flags: MessageFlags.Ephemeral });
    await runYtDlpUpdate((msg) => itx.editReply({
      embeds: [
        msg.startsWith("✅")
          ? successEmbed("✅ Update complete", "yt-dlp is now up to date")
          : msg.startsWith("⏳")
            ? infoEmbed("⏳ Updating", "The yt-dlp update is running")
            : errorEmbed(msg)
      ], content: ""
    }));
    return;
  }

  if (itx.commandName === "panel") {
    const panel = state.current ? buildNowPlayingEmbed(state, state.currentLyrics) : buildPanelEmbed(itx.guild);
    const ref = await upsertNpMessage(itx.guild, null, panel, true);
    if (!ref) return itx.reply({ content: "I cannot access the #bocchi control channel.", flags: MessageFlags.Ephemeral });
    if (state.current) startNowPlayingTicker(itx.guild, state);
    return itx.reply({ content: `Music controls are in <#${ref.channelId}>.`, flags: MessageFlags.Ephemeral });
  }

  if (itx.commandName === "ytstatus") {
    const ck = ytCookiesStatus();
    return itx.reply({
      embeds: [
        makeEmbed(COLORS.info).setDescription(`### 🍪 YouTube sign-in\n${ck.exists ? `✅ signed in\n\`${ck.path}\` (${ck.size} bytes)` : `❌ not signed\nAdmin, use \`/ytsignin\` attach the cookies.txt file`}`)
      ], flags: MessageFlags.Ephemeral
    });
  }

  if (itx.commandName === "ytsignin") {
    if (!isGuildAdmin(itx.member)) return itx.reply({ embeds: [errorEmbed("Manage Server permission required")], flags: MessageFlags.Ephemeral });
    await itx.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const att = itx.options.getAttachment("file");
      if (!att) return itx.editReply({ embeds: [errorEmbed("Attach the cookies.txt file")] });
      const r = await fetch(att.url);
      const text = await r.text();
      const saved = saveYTCookies(text);
      return itx.editReply({ embeds: [successEmbed("✅ YouTube signed in", `saved → \`${saved}\`\nTry \`/play\` `)] });
    } catch (e) { return itx.editReply({ embeds: [errorEmbed("Could not save cookies: " + (e?.message || e))] }); }
  }

  if (itx.commandName === "ytsignout") {
    if (!isGuildAdmin(itx.member)) return itx.reply({ embeds: [errorEmbed("Manage Server permission required")], flags: MessageFlags.Ephemeral });
    try { fs.unlinkSync(ytCookiesPath()); } catch { }
    if (!process.env.YTDLP_COOKIES_PATH) config.cookieFile = null;
    return itx.reply({ embeds: [successEmbed("🗑️ Signed out", "Cookies removed")], flags: MessageFlags.Ephemeral });
  }

  if (itx.commandName === "vstate") {
    const d = voiceDiag(itx.guild);
    return itx.reply({
      embeds: [
        makeEmbed(COLORS.info).setDescription(`### 🔍 Voice state`)
          .addFields(
            { name: "Bot VC", value: `${d.botVC}`, inline: true },
            { name: "Connection", value: `${d.conn}`, inline: true },
            { name: "Subscribed", value: `${d.subscribed}`, inline: true },
            { name: "Player", value: `${d.player}`, inline: true },
            { name: "Current", value: `${d.current}`, inline: false },
            { name: "Queue", value: `${d.queue}`, inline: true },
          )
      ], flags: MessageFlags.Ephemeral
    });
  }

  if (itx.commandName === "video") {
    await itx.deferReply();
    const qv = itx.options.getString("query");
    const info = await resolveVideoInfo(qv);
    if (!info) return itx.editReply({ embeds: [errorEmbed("Video not found — try another search")] });
    const watchUrl = info.videoId ? `http://localhost:${config.port}/watch?v=${info.videoId}` : info.url;
    const vSlashThumb = info.thumb || (info.videoId ? `https://i.ytimg.com/vi/${info.videoId}/hqdefault.jpg` : thumbFor(info.url));
    state.queue.push({ title: info.title, source: info.url, thumb: vSlashThumb, durationSec: info.durationSec || null, requestedBy: itx.user.tag, guild: itx.guild, voiceChannelId: userVC, textChannelId: itx.channelId });
    const vSlash = makeEmbed(COLORS.music).setDescription(`### 🎬 ${info.title}`)
      .addFields({ name: "🔗 Video page", value: info.url, inline: false }, { name: "🔊 Audio", value: "queued in voice — hear it while you watch the page", inline: false });
    if (vSlashThumb) vSlash.setThumbnail(vSlashThumb);
    await itx.editReply({ embeds: [vSlash], components: buildVideoRows(info.videoId, watchUrl) });
    if (!state.current) playNext(itx.guild, itx.channelId, state);
    return;
  }

  if (itx.commandName === "watchtogether") {
    if (!userVC) return itx.reply({ embeds: [errorEmbed("Join a voice channel first, then use this command 🎙️")], flags: MessageFlags.Ephemeral });
    try {
      const vc = itx.guild.channels.cache.get(userVC);
      const inv = await createWatchTogetherInvite(vc);
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("📺 Join Watch Together").setStyle(ButtonStyle.Link).setURL(inv.url));
      return itx.reply({
        embeds: [
          successEmbed("📺 Watch Together ready", `Watch together in **${vc?.name || "voice"}** — hit Join\n\n*Video shows in everyone's voice chat (bots can only send audio + activity links)*`)
        ], components: [row]
      });
    } catch (e) { return itx.reply({ embeds: [errorEmbed("Could not create a watch party (bot needs the Create Invite permission): " + (e?.message || e))], flags: MessageFlags.Ephemeral }); }
  }

  if (itx.commandName === "play") {
    await itx.deferReply({ flags: MessageFlags.Ephemeral });
    const q = itx.options.getString("query");
    // Queue instantly with the query as placeholder title, then resolve the
    // real title AND start playback in parallel (was: 2 sequential yt-dlp
    // passes ≈ 2x startup delay on long videos).
    const item = {
      title: q,
      source: q,
      requestedBy: itx.user.tag,
      guild: itx.guild,
      voiceChannelId: userVC,
      textChannelId: itx.channelId,
    };
    state.queue.push(item);
    const shouldStart = !state.current;
    const metaP = resolveTitleAndThumb(q);
    if (shouldStart) playNext(itx.guild, itx.channelId, state);
    const meta = await metaP;
    if (meta.title && meta.title !== q) item.title = meta.title;
    if (meta.thumb) item.thumb = meta.thumb;
    if (meta.durationSec) item.durationSec = meta.durationSec;
    const addedSlash = makeEmbed(COLORS.success)
      .setDescription(`### ➕ Added to queue`)
      .addFields(
        { name: "🎵 Track", value: `**${cleanTitle(item.title)}**`, inline: false },
        { name: "📋 Queue position", value: `\`#${state.queue.length}\``, inline: true },
        { name: "👤 Requested by", value: `${itx.user}`, inline: true },
      );
    if (item.thumb) addedSlash.setThumbnail(item.thumb);
    await itx.editReply({ embeds: [addedSlash] });
    return;
  }

  if (itx.commandName === "skip") {
    state.skipRequested = true;
    state.player.stop(true);
    cleanupCurrentPipeline(state);
    await itx.reply({ embeds: [successEmbed("⏭️ Skipped", state.queue.length ? `Next: **${state.queue[0]?.title || "—"}**` : "Queue is empty")] });
    return;
  }

  if (itx.commandName === "stop") {
    state.queue = [];
    state.current = null;
    state.startedAt = null;
    state.loopMode = "off";
    state.skipRequested = false;
    if (state.leaveTimer) { clearTimeout(state.leaveTimer); state.leaveTimer = null; }
    state.player.stop(true);
    cleanupCurrentPipeline(state);
    const vc = getVoiceConnection(itx.guild.id);
    if (vc) vc.destroy();
    markNpStopped(itx.guild).catch(() => { });
    await itx.reply({ embeds: [successEmbed("🛑 Stopped", "Queue cleared and left voice")] });
    return;
  }

  if (itx.commandName === "pause") {
    state.player.pause();
    await itx.reply({ embeds: [infoEmbed("⏸️ Paused", "Type `/resume` to resume")] });
    return;
  }

  if (itx.commandName === "resume") {
    state.player.unpause();
    await itx.reply({ embeds: [successEmbed("▶️ Resumed", `Now playing: **${state.current?.title || "—"}**`)] });
    return;
  }

  if (itx.commandName === "np" || itx.commandName === "p") {
    if (!state.current) return itx.reply({ embeds: [infoEmbed("🎵 Nothing playing", "Use `/play query:<song>` to start")] });
    const lyrNpS = await fetchLyrics(state.current.title).catch(() => null);
    return itx.reply({ embeds: [buildNowPlayingEmbed(state, lyrNpS)], components: buildControlRows(state) });
  }

  if (itx.commandName === "queue" || itx.commandName === "list") {
    if (!state.queue.length) return itx.reply({ embeds: [infoEmbed("📭 Queue is empty", "Use `/play query:<song>` to add songs")], flags: MessageFlags.Ephemeral });
    const lines = state.queue.slice(0, 10).map((x, i) => `\`${String(i + 1).padStart(2, "0")}.\` **${x.title}**\n　　👤 ${x.requestedBy}`).join("\n");
    const more = state.queue.length > 10 ? `\n*… and **${state.queue.length - 10}** tracks*` : "";
    return itx.reply({
      embeds: [
        makeEmbed(COLORS.queue)
          .setDescription(`### 📋 Queue`)
          .addFields(
            { name: `Tracks (${Math.min(state.queue.length, 10)}/${state.queue.length})`, value: lines + more, inline: false },
            { name: "🔁 Loop", value: loopLabel(state.loopMode), inline: true },
            { name: "🎵 Now playing", value: state.current ? `**${state.current.title}**` : "—", inline: true },
          )
      ],
      flags: MessageFlags.Ephemeral
    });
  }

  if (itx.commandName === "volume") {
    const v = itx.options.getInteger("value");
    setVolumePct(state, v);
    const bar = "█".repeat(Math.round(Math.min(state.volumePct, 200) / 20)) + "░".repeat(10 - Math.round(Math.min(state.volumePct, 200) / 20));
    return itx.reply({ embeds: [successEmbed("🔊  Volume updated", `\`${bar}\` **${state.volumePct}%**`)] });
  }

  if (itx.commandName === "playlist") {
    await itx.deferReply();
    const q = itx.options.getString("query");
    const limit = itx.options.getInteger("limit");

    const items = await fetchPlaylistEntries(q, limit);
    if (!items.length) {
      return itx.editReply({ embeds: [errorEmbed("No songs found in the playlist or search results")] });
    }

    for (const { title, url, thumb, durationSec } of items) {
      state.queue.push({
        title,
        source: url,
        thumb: thumb || thumbFor(url),
        durationSec: durationSec || null,
        requestedBy: itx.user.tag,
        guild: itx.guild,
        voiceChannelId: itx.member?.voice?.channelId,
        textChannelId: itx.channelId,
      });
    }

    const preview = items.slice(0, 5).map((x, i) => `\`${i + 1}.\` ${x.title}`).join("\n");
    const more = items.length > 5 ? `\n*… and ${items.length - 5} tracks*` : "";
    await itx.editReply({
      embeds: [
        makeEmbed(COLORS.queue)
          .setDescription(`### 📚 Playlist loaded`)
          .addFields(
            { name: "🎶 Total tracks", value: `**${items.length} tracks**`, inline: true },
            { name: "👤 Requested by", value: `${itx.user}`, inline: true },
            { name: "📋 First tracks", value: `${preview}${more}`, inline: false },
          )
      ]
    });

    if (!state.current) playNext(itx.guild, itx.channelId, state);
    return;
  }

  if (itx.commandName === "remove") {
    if (!state.queue.length) return itx.reply({ embeds: [infoEmbed("📭 Queue is empty", "Nothing to remove")] });
    const index = itx.options.getInteger("index");
    if (index < 1 || index > state.queue.length) {
      return itx.reply({ embeds: [errorEmbed(`Invalid number (${state.queue.length} in the queue)`)], flags: MessageFlags.Ephemeral });
    }
    const [removed] = state.queue.splice(index - 1, 1);
    return itx.reply({ embeds: [successEmbed("🗑️  Removed from queue", `**${removed.title}**`)] });
  }

  if (itx.commandName === "shuffle") {
    if (state.queue.length < 2) return itx.reply({ embeds: [infoEmbed("🔀 Can't shuffle", "Need at least 2 songs in the queue")] });
    for (let i = state.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]];
    }
    return itx.reply({ embeds: [successEmbed("🔀 Shuffled", `Reordered **${state.queue.length} tracks** done`)] });
  }

  if (itx.commandName === "loop") {
    const mode = itx.options.getString("mode");
    state.loopMode = mode;
    return itx.reply({ embeds: [successEmbed("🔁 Loop updated", `Current mode: **${loopLabel(mode)}**`)], flags: MessageFlags.Ephemeral });
  }
});

client.login(config.token);

// ================= Web dashboard (login + YouTube sign-in) =================
// No extra deps. Uses built-in http only.
// Env: DASHBOARD_USER (default admin), DASHBOARD_PASSWORD (required), PORT.
// Routes:
//   GET  /health      -> plain 200 for Railway/Render keep-alive
//   GET  /            -> redirect to /dashboard
//   GET  /login       -> login form
//   POST /login       -> check user/pass, set session cookie
//   GET  /dashboard   -> status + YouTube cookies upload + yt-dlp update
//   POST /cookies     -> save cookies.txt (auth)
//   POST /cookies/clear -> delete cookies (auth)
//   POST /ytdlp-update  -> run yt-dlp update (auth)
//   GET  /logout
//   GET  /api/status  -> JSON (auth)
const dashSessions = new Map(); // token -> { user, exp }
const dashLoginAttempts = new Map(); // ip -> { count, reset }
const DASH_SESSION_TTL_MS = 12 * 3600 * 1000;

function dashClientIp(req) {
  return (req.socket?.remoteAddress || "unknown").toString();
}
function dashRateLimited(ip) {
  const now = Date.now();
  const e = dashLoginAttempts.get(ip);
  if (!e || now > e.reset) { dashLoginAttempts.set(ip, { count: 0, reset: now + 5 * 60 * 1000 }); return false; }
  return e.count >= 10;
}
function dashNoteFail(ip) {
  const now = Date.now();
  let e = dashLoginAttempts.get(ip);
  if (!e || now > e.reset) e = { count: 0, reset: now + 5 * 60 * 1000 };
  e.count++;
  dashLoginAttempts.set(ip, e);
}
function dashParseCookies(req) {
  const h = req.headers.cookie || "";
  const out = {};
  for (const part of h.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function dashIsAuthed(req) {
  const t = dashParseCookies(req).dash_session;
  if (!t) return false;
  const s = dashSessions.get(t);
  if (!s) return false;
  if (Date.now() > s.exp) { dashSessions.delete(t); return false; }
  return true;
}
function dashCreateSession(user) {
  const t = crypto.randomBytes(32).toString("hex");
  dashSessions.set(t, { user, exp: Date.now() + DASH_SESSION_TTL_MS });
  return t;
}
function dashBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on("data", (c) => { n += c.length; if (n > limit) { reject(new Error("body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
function dashParseForm(body) {
  const out = {};
  for (const kv of body.split("&")) {
    if (!kv) continue;
    const i = kv.indexOf("=");
    const k = decodeURIComponent((i < 0 ? kv : kv.slice(0, i)).replace(/\+/g, " "));
    const v = decodeURIComponent((i < 0 ? "" : kv.slice(i + 1)).replace(/\+/g, " "));
    out[k] = v;
  }
  return out;
}
function escHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function dashCookiesPath() {
  return config.cookieFile || path.join(config.dataDir, "cookies.txt");
}
function dashCookiesStatus() {
  const p = dashCookiesPath();
  try {
    const st = fs.statSync(p);
    return { path: p, exists: true, size: st.size, mtime: st.mtime.toISOString() };
  } catch { return { path: p, exists: false, size: 0, mtime: null }; }
}
function dashBotStatus() {
  const guilds = [];
  try {
    for (const [id, st] of guildStates) {
      let name = id;
      try { name = client.guilds.cache.get(id)?.name || id; } catch { }
      guilds.push({ id, name, nowPlaying: st.current?.title || null, queueCount: st.queue.length, next: st.queue.slice(0, 5).map((x) => x.title), volume: st.volumePct, loop: st.loopMode, player: st.player?.state?.status || null, botVC: botVcName(id) });
    }
  } catch { }
  return {
    tag: client.user ? client.user.tag : "offline",
    guilds: client.guilds ? client.guilds.cache.size : 0,
    uptimeSec: Math.floor(process.uptime()),
    queues: guilds,
    cookies: dashCookiesStatus(),
    ytAutoUpdate: config.ytdlpAutoUpdate,
  };
}
function botVcName(guildId) {
  try {
    const g = client.guilds.cache.get(guildId);
    const vcId = g?.members?.me?.voice?.channelId;
    if (!vcId) return null;
    return g.channels.cache.get(vcId)?.name || vcId;
  } catch { return null; }
}
// Full guild list for the web manager: voice channels + live state.
function dashGuilds() {
  const out = [];
  try {
    for (const [id, g] of client.guilds.cache) {
      const voice = [];
      try {
        for (const [cid, ch] of g.channels.cache) {
          if (ch && ch.type === ChannelType.GuildVoice) voice.push({ id: cid, name: ch.name, members: ch.members?.size || 0 });
        }
      } catch { }
      voice.sort((a, b) => b.members - a.members);
      const st = guildStates.get(id);
      out.push({
        id, name: g.name,
        botVC: g.members.me?.voice?.channelId || null,
        voice,
        nowPlaying: st?.current ? { title: st.current.title, by: st.current.requestedBy, thumb: st.current.thumb || thumbFor(st.current.source), durationSec: st.current.durationSec || null, startedAt: st.startedAt || null, posBase: st.posBase || 0, lyrics: st.currentLyrics } : null,
        queue: st ? st.queue.slice(0, 20).map((x) => ({ title: x.title, by: x.requestedBy })) : [],
        queueCount: st?.queue.length || 0,
        volume: st?.volumePct ?? config.defaultVolume,
        loop: st?.loopMode || config.defaultLoop,
        player: st?.player?.state?.status || "idle",
      });
    }
  } catch { }
  return out;
}
function dashParseJson(body) {
  try { const o = JSON.parse(body); if (o && typeof o === "object") return o; } catch { }
  return dashParseForm(body || "");
}
function firstTextChannelId(guild) {
  try {
    if (guild.systemChannelId) return guild.systemChannelId;
    const ch = guild.channels.cache.find((c) => c && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement));
    return ch ? ch.id : null;
  } catch { return null; }
}
// Web manager: queue + play a song (same engine as /play).
async function dashPlay(guildId, query) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) throw new Error("unknown server");
  const vcId = guild.members.me?.voice?.channelId;
  if (!vcId) throw new Error("bot is not in a voice channel — press Join first");
  const q = String(query || "").trim();
  if (!q) throw new Error("empty query");
  const state = getGuildState(guild);
  const textId = firstTextChannelId(guild);
  const item = { title: q, source: q, requestedBy: "dashboard:" + config.dashboardUser, guild, voiceChannelId: vcId, textChannelId: textId };
  state.queue.push(item);
  const shouldStart = !state.current;
  const metaP = resolveTitleAndThumb(q);
  if (shouldStart) playNext(guild, textId, state);
  const meta = await metaP;
  if (meta.title && meta.title !== q) item.title = meta.title;
  if (meta.thumb) item.thumb = meta.thumb;
  if (meta.durationSec) item.durationSec = meta.durationSec;
  logPretty("COMMAND", "WEB /play", { user: "dashboard", guild: guild.name, tail: item.title });
  return { title: item.title, position: state.queue.length };
}
// Web manager: transport + sound controls. Mirrors the Discord buttons.
function dashControl(guildId, action, value) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) throw new Error("unknown server");
  const state = getGuildState(guild);
  if (action === "pause") { try { state.player.pause(); } catch { } return "paused"; }
  if (action === "resume") { try { state.player.unpause(); } catch { } return "resumed"; }
  if (action === "skip") {
    state.skipRequested = true;
    try { state.player.stop(true); } catch { }
    cleanupCurrentPipeline(state);
    return "skipped";
  }
  if (action === "stop") {
    state.queue = []; state.current = null; state.startedAt = null;
    state.loopMode = "off"; state.skipRequested = false;
    if (state.leaveTimer) { clearTimeout(state.leaveTimer); state.leaveTimer = null; }
    try { state.player.stop(true); } catch { }
    cleanupCurrentPipeline(state);
    try { getVoiceConnection(guild.id)?.destroy(); } catch { }
    markNpStopped(guild).catch(() => { });
    return "stopped";
  }
  if (action === "shuffle") {
    for (let i = state.queue.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]]; }
    return "shuffled " + state.queue.length;
  }
  if (action === "volume") {
    const v = Number(value);
    if (!Number.isFinite(v)) throw new Error("bad volume");
    setVolumePct(state, v);
    return String(state.volumePct);
  }
  if (action === "loop") {
    if (!["off", "track", "queue"].includes(value)) throw new Error("bad loop mode");
    state.loopMode = value;
    return value;
  }
  if (action === "prev") {
    const prev = (state.history || []).pop();
    if (!prev || !prev.source) throw new Error("no previous track");
    const me2 = guild.members.me;
    const uvc = me2?.voice?.channelId;
    if (state.current) {
      state.queue.unshift({ title: state.current.title, source: state.current.source, thumb: state.current.thumb || null, durationSec: state.current.durationSec || null, requestedBy: state.current.requestedBy, guild, voiceChannelId: state.current.voiceChannelId || uvc, textChannelId: state.current.textChannelId });
    }
    state.queue.unshift({ title: prev.title, source: prev.source, thumb: prev.thumb || null, durationSec: prev.durationSec || null, requestedBy: prev.requestedBy || ("dashboard:" + config.dashboardUser), guild, voiceChannelId: uvc, textChannelId: firstTextChannelId(guild) });
    state.skipRequested = true;
    state.prevJump = true;
    try { state.player.stop(true); } catch {}
    cleanupCurrentPipeline(state);
    return prev.title;
  }
  throw new Error("unknown action: " + action);
}
// Web manager: seek the current track (restart at offset, same engine).
async function dashSeek(guildId, seconds) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) throw new Error("unknown server");
  const state = getGuildState(guild);
  if (!state.current) throw new Error("nothing playing");
  let s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) throw new Error("bad position");
  const dur = Number(state.current.durationSec);
  if (Number.isFinite(dur) && dur > 0 && s > dur - 1) s = Math.max(0, dur - 1);
  state.current.offsetSec = s;
  await playSame(guild, state.current.textChannelId, state.current, state);
  return s;
}
function startDashboard() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      const p = url.pathname;
      if (p === "/health") { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("Discord music bot is running"); return; }
      // Cloudflare Worker authentication header
      const requestSecret = req.headers["x-bot-secret"] || req.headers["x-bot-auth"];

      if (p === "/watch" && req.method === "GET") {
        // Public video page: embeds YouTube iframe (user asked: share the video page / find the iframe).
        // Netflix is NOT embeddable here (DRM + X-Frame-Options) — YouTube only.
        const v = (url.searchParams.get("v") || "").trim();
        const idOk = /^[A-Za-z0-9_-]{6,}$/.test(v);
        const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Watch${idOk ? " " + escHtml(v) : ""}</title>
<style>body{font-family:system-ui;background:#020617;color:#e2e8f0;margin:0;padding:24px;text-align:center}.box{max-width:860px;margin:0 auto}iframe{width:100%;height:480px;border:0;border-radius:12px;background:#000}small{color:#94a3b8}</style></head><body><div class="box">
<h2>🎬 Video page</h2>${idOk ? `<iframe src="https://www.youtube.com/embed/${escHtml(v)}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe><p><a style="color:#93c5fd" href="https://www.youtube.com/watch?v=${escHtml(v)}">Open on YouTube</a></p>` : `<p>Missing video id. Use <code>/watch?v=VIDEO_ID</code> — get the link from <code>/video</code> in Discord.</p><p><small>Note: Netflix cannot be embedded/streamed (DRM + blocks iframes).</small></p>`}</div></body></html>`;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(html); return;
      }
        if (requestSecret !== config.dashboardPassword) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }

        if (p === "/api/status" && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(dashBotStatus()));
          return;
        }
        if (p === "/api/guilds" && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(dashGuilds()));
          return;
        }
        if (p === "/api/join" && req.method === "POST") {
          try {
            const b = dashParseJson(await dashBody(req, 64 * 1024));
            const guild = client.guilds.cache.get(b.guildId);
            if (!guild) throw new Error("unknown server");
            const ch = guild.channels.cache.get(b.channelId);
            if (!ch || !ch.isVoiceBased?.()) throw new Error("not a voice channel");
            const state = getGuildState(guild);
            ensureVC(guild, ch.id, state);
            logPretty("COMMAND", "WEB join", { user: "dashboard", guild: guild.name, tail: ch.name });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, channel: ch.name }));
            return;
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e?.message || String(e) }));
            return;
          }
        }
        if (p === "/api/leave" && req.method === "POST") {
          try {
            const b = dashParseJson(await dashBody(req, 64 * 1024));
            const guild = client.guilds.cache.get(b.guildId);
            if (!guild) throw new Error("unknown server");
            try { getVoiceConnection(guild.id)?.destroy(); } catch { }
            logPretty("COMMAND", "WEB leave", { user: "dashboard", guild: guild.name });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return;
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e?.message || String(e) }));
            return;
          }
        }
        if (p === "/api/play" && req.method === "POST") {
          try {
            const b = dashParseJson(await dashBody(req, 256 * 1024));
            const r = await dashPlay(b.guildId, b.query);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, title: r.title, position: r.position }));
            return;
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e?.message || String(e) }));
            return;
          }
        }
        if (p === "/api/ctl" && req.method === "POST") {
          try {
            const b = dashParseJson(await dashBody(req, 64 * 1024));
            const r = dashControl(b.guildId, b.action);
            logPretty("COMMAND", "WEB " + b.action, { user: "dashboard" });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, result: r }));
            return;
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e?.message || String(e) }));
            return;
          }
        }
        if (p === "/api/volume" && req.method === "POST") {
          try {
            const b = dashParseJson(await dashBody(req, 64 * 1024));
            const r = dashControl(b.guildId, "volume", b.value);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, result: r }));
            return;
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e?.message || String(e) }));
            return;
          }
        }
        if (p === "/api/loop" && req.method === "POST") {
          try {
            const b = dashParseJson(await dashBody(req, 64 * 1024));
            const r = dashControl(b.guildId, "loop", b.mode);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, result: r }));
            return;
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e?.message || String(e) }));
            return;
          }
        }
        if (p === "/api/seek" && req.method === "POST") {
          try {
            const b = dashParseJson(await dashBody(req, 64 * 1024));
            const r = await dashSeek(b.guildId, b.seconds);
            logPretty("COMMAND", "WEB seek " + r + "s", { user: "dashboard" });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, position: r }));
            return;
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e?.message || String(e) }));
            return;
          }
        }
      if (p === "/cookies" && req.method === "POST") {
        const body = await dashBody(req);
        const f = dashParseForm(body);
        const text = (f.cookiesText || "").trim();
        if (!text || text.length < 100) { res.writeHead(302, { Location: "/dashboard?msg=" + encodeURIComponent("Paste full cookies.txt content (too short)") }); res.end(); return; }
        if (!text.includes("youtube.com") && !text.includes("youtu.be")) { res.writeHead(302, { Location: "/dashboard?msg=" + encodeURIComponent("Invalid: no youtube.com entries found") }); res.end(); return; }
        if (!text.split("\n").filter((l) => l && !l.trim().startsWith("#")).some((l) => l.includes("\t"))) { res.writeHead(302, { Location: "/dashboard?msg=" + encodeURIComponent("Invalid: not a Netscape cookies.txt (tab-separated lines required)") }); res.end(); return; }
        const target = dashCookiesPath();
        try { fs.mkdirSync(path.dirname(target), { recursive: true }); } catch { }
        fs.writeFileSync(target, text.replace(/\r\n/g, "\n"), "utf8");
        config.cookieFile = target; // live update, no restart needed
        logPretty("SYSTEM", "YouTube cookies updated via dashboard", { tail: `${text.length} chars -> ${target}` });
        res.writeHead(302, { Location: "/dashboard?msg=" + encodeURIComponent("✅ Cookies saved to " + target + " — try /play again") }); res.end(); return;
      }
      if (p === "/cookies/clear" && req.method === "POST") {
        const target = dashCookiesPath();
        try { fs.unlinkSync(target); } catch { }
        if (!process.env.YTDLP_COOKIES_PATH) config.cookieFile = null;
        logPretty("SYSTEM", "YouTube cookies removed via dashboard");
        res.writeHead(302, { Location: "/dashboard?msg=" + encodeURIComponent("Cookies removed") }); res.end(); return;
      }
      if (p === "/ytdlp-update" && req.method === "POST") {
        runYtDlpUpdate(() => { });
        res.writeHead(302, { Location: "/dashboard?msg=" + encodeURIComponent("yt-dlp update started — check console") }); res.end(); return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" }); res.end("not found");
    } catch (e) {
      logPretty("ERROR", "Dashboard error: " + (e?.message || e));
      try { res.writeHead(500, { "Content-Type": "text/plain" }); res.end("internal error"); } catch { }
    }
  });
  server.on("error", (e) => {
    // Dashboard port blocked (EACCES/EADDRINUSE) must NOT kill the Discord bot.
    logPretty("ERROR", `Dashboard port ${config.port} failed (${e?.code || e?.message}). Discord still running — set PORT=3100 in .env and restart for dashboard.`);
  });
  server.listen(config.port, () => logPretty("SYSTEM", `Dashboard on port ${config.port} (/health, /login, /dashboard)`));
}
startDashboard();