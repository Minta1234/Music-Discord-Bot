# 🎵 bocchi — Discord Music Bot

A feature-rich Discord music bot with live karaoke lyrics, AI chat, a web dashboard, YouTube/TikTok/Spotify support, and real-time playback controls.

---

## ✨ Features

- 🎶 **YouTube, TikTok & Spotify** support (Spotify → YouTube search)
- 📋 **Queue system** with shuffle, remove, loop modes
- 🎤 **Live synced karaoke lyrics** — scrolling highlighted in the Now Playing embed
- ⚡ **Speed control** — toggle 1x / 2x seamlessly (no restart from beginning)
- 🔊 **Volume control** (0–10000%)
- 🛡️ **Stable Audio** — Native C++ Opus encoding (libsodium & @discordjs/opus) for zero-lag playback
- 🤖 **AI chat** (Gemini 1.5 Flash / OpenRouter) with custom persona support
- 🌐 **Web dashboard** at `localhost:4000` — full playback control in browser
- 📺 **Watch Together** — Discord Watch Party link
- 🎛️ **Discord button controls** — Prev, Play/Pause, Skip, Stop, List, Loop, Speed, Lyrics, Volume
- 🔒 **Private-only replies** — bot responses are ephemeral (only you see them)
- 🎵 **End-of-playlist chime** — plays a jingle when the queue ends
- 🏠 **#bocchi control room** — dedicated text channel for all bot output

---

## 🚀 Setup

### 1. Prerequisites

- [Node.js](https://nodejs.org/) v22+
- [ffmpeg](https://ffmpeg.org/) installed and on PATH
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) (auto-updated by the bot)
- A [Discord Bot Token](https://discord.com/developers/applications)

### 2. Install

```bash
git clone https://github.com/Minta1234/Music-Discord-Bot.git
cd Music-Discord-Bot
npm install
```

### 3. Configure `.env`

Create a `.env` file in the root directory:

```env
TOKEN=your_discord_bot_token
GEMINI_API_KEY=your_gemini_key          # optional, for AI chat
OPENROUTER_API_KEY=your_openrouter_key  # optional, alternative AI
OPENROUTER_MODEL=openai/gpt-4o-mini
PORT=4000
DASHBOARD_USER=admin
DASHBOARD_PASSWORD=your_dashboard_password
DEFAULT_VOLUME=100
DEFAULT_LOOP_MODE=off
DISCONNECT_DELAY_SEC=300
TIMEZONE_OFFSET_HOURS=7
```

### 4. Run

```bash
node bot.js
# or
./start.bat   # Windows
```

---

## 🎮 Slash Commands

### 🎵 Music

| Command | Description |
|---------|-------------|
| `/play query:<song>` | Play a song from YouTube (name or URL) |
| `/playlist query:<url>` | Add a full YouTube playlist or bulk search |
| `/skip` | Skip the current song |
| `/stop` | Stop playback and clear queue |
| `/pause` | Pause playback |
| `/resume` | Resume playback |
| `/np` | Show what's playing now (with lyrics) |
| `/queue` / `/list` | Show the queue (only visible to you) |
| `/remove index:<n>` | Remove a song by its queue position |
| `/shuffle` | Shuffle the queue randomly |
| `/loop mode:<off/track/queue>` | Set loop mode |
| `/volume value:<0-10000>` | Set volume percentage |

### 🎛️ Control Panel

| Command | Description |
|---------|-------------|
| `/panel` | Post the music control panel with buttons |
| `/setup` | Create the `#bocchi` control room (Admin only) |

### 🤖 AI Chat

| Command | Description |
|---------|-------------|
| `/ai question:<text>` | Ask the AI a question |
| `/airef persona:<text>` | Set a custom AI persona for this channel |
| `/setai` | Create a public AI chat channel |
| `/setaip` | Open a private temporary AI chat thread |
| `/delete` | Delete your private AI chat thread |
| `/deletep confirm:true` | Delete all messages in the public AI chat |
| `/clear` | Clear all AI history on this server |

### 🛠️ Utility

| Command | Description |
|---------|-------------|
| `/ping` | Check bot latency |
| `/botupdate` | Update yt-dlp to latest version |
| `/ytstatus` | Check YouTube cookie sign-in status |
| `/ytsignin file:<cookies.txt>` | Sign in with YouTube cookies (Admin) |
| `/ytsignout` | Remove YouTube cookies (Admin) |
| `/video query:<url>` | Share video page + play audio |
| `/watchtogether` | Start a Discord Watch Together session |
| `/vstate` | Debug voice/player status (Admin) |
| `/help` | Show all commands |

---

## 🕹️ Button Controls

When the Now Playing panel is active, you get one-click buttons:

| Button | Action |
|--------|--------|
| ⏮ Prev | Play previous track |
| ▶/⏸ Play/Pause | Toggle playback |
| ⏭ Skip | Skip to next song |
| ⏹ Stop | Stop + clear queue |
| 📋 List | Show queue (private) |
| 🔁 Loop | Cycle loop modes |
| ⏩ Speed | Toggle 1x / 2x speed |
| 📝 Lyrics | Toggle karaoke lyrics |
| 🔊 Vol+ / 🔉 Vol− | Adjust volume |
| 🎛 Controls | Show/hide settings row |

---

## 🌐 Web Dashboard

Access the dashboard at `http://localhost:4000`

- Login with `DASHBOARD_USER` / `DASHBOARD_PASSWORD` from `.env`
- Full playback control, queue view, volume slider
- Scrolling live karaoke lyrics synced to playback

---

## 🐳 Docker / Nixpacks

The project includes `Dockerfile` and `nixpacks.toml` for easy deployment on platforms like [Railway](https://railway.app/).

```toml
# nixpacks.toml
[phases.setup]
aptPkgs = ["ffmpeg", "python3", "ca-certificates", "tzdata"]
```

---

## 📁 Project Structure

```
.
├── bot.js              # Main bot logic
├── package.json
├── nixpacks.toml       # Railway/Nixpacks config
├── Dockerfile
├── Assets/             # End-of-playlist audio chime
├── .env                # Environment variables (not committed)
└── cookies.txt         # YouTube cookies (not committed)
```

---

## 💬 Commands (slash only)

All commands are Discord slash commands — the legacy `n!` prefix was removed:

`/play`, `/skip`, `/stop`, `/pause`, `/resume`, `/np`, `/queue`, `/volume`, `/loop`, `/shuffle`, `/remove`, `/playlist`, `/help`, `/panel`, `/setup`, `/video`, `/watchtogether`, `/vstate`, `/ytsignin`, `/ytsignout`, `/ytstatus`

---

## 🔐 Privacy & Security

- `.env` and `cookies.txt` are **never committed** (in `.gitignore`)
- Dashboard protected with login + rate limiting
- Bot responses that only you should see are **ephemeral** (private)

---
Refference:
https://github.com/ninjamadeena/music-discord-bot
