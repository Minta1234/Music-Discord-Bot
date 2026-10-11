# 🎵 bocchi — Discord Music Bot

A feature-rich Discord music bot with high-performance NodeLink streaming, live karaoke lyrics, AI chat, a web dashboard, YouTube/TikTok/SoundCloud/Spotify support, and interactive playback controls.

---

## ✨ Features

- ⚡ **Ultra-Fast Audio Engine** — Powered by [NodeLink](https://github.com/PerformanC/NodeLink) for sub-second playback start and high audio fidelity.
- 🎶 **Multi-Platform Support** — Direct audio streaming from YouTube, Spotify, SoundCloud, and TikTok.
- 📋 **Queue System** — Interactive queue with shuffle, remove, and multi-mode looping (Off / Track / Queue).
- 🎤 **Live Synced Karaoke Lyrics** — Scrolling real-time synchronized lyrics right inside the Now Playing embed.
- 🔊 **Volume Control** — Smooth volume adjustment (0–10000%).
- 🛡️ **Stable Audio Pipeline** — Native C++ Opus encoding (libsodium & @discordjs/opus) for zero-lag and crystal clear audio.
- 🤖 **AI Chat** — Gemini 1.5 Flash / OpenRouter AI integration with customizable persona channels and private threads.
- 🌐 **Web Dashboard** — Web control interface at `http://localhost:4000` with visual player, queue management, and live lyrics.
- 🎛️ **Discord Interactive Control Panel** — Quick controls directly on the panel with expandable secondary controls via the **More** button.
- 🔒 **Private & Ephemeral Feedback** — Notifications and status checks only visible to the user triggering them.
- 🏠 **Dedicated #bocchi Room** — All playback controls and bot interactions organized neatly in one room.

---

## 🚀 Setup & Installation

### 1. Prerequisites

- [Node.js](https://nodejs.org/) v22+
- [ffmpeg](https://ffmpeg.org/) installed and available in system PATH
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) (used as fallback stream resolver)
- A [Discord Bot Token](https://discord.com/developers/applications)

### 2. Clone with Submodules

Clone the repository along with the [NodeLink](https://github.com/PerformanC/NodeLink) submodule:

```bash
git clone --recursive https://github.com/Minta1234/Music-Discord-Bot.git
cd Music-Discord-Bot
npm install
```

*(If you already cloned without `--recursive`, run: `git submodule update --init --recursive`)*

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

# NodeLink Engine (Optional / Default: enabled on localhost:2333)
NODELINK_ENABLED=true
NODELINK_HOST=127.0.0.1
NODELINK_PORT=2333
NODELINK_PASSWORD=youshallnotpass
```

### 4. Run the Bot

```bash
# Windows quick start (starts NodeLink & Bot together)
start.bat

# Or run manually:
node bot.js
```

---

## 🎮 Slash Commands

### 🎵 Music

| Command | Description |
|---------|-------------|
| `/play query:<song>` | Play a song from YouTube, Spotify, SoundCloud, or TikTok |
| `/playlist query:<url>` | Add a full playlist or album to queue |
| `/batchplay` | Open modal to paste and enqueue multiple song URLs/titles |
| `/skip` | Skip the current song |
| `/stop` | Stop playback and clear the queue |
| `/pause` | Pause playback |
| `/resume` | Resume playback |
| `/np` | Show what's playing now with synced lyrics |
| `/queue` / `/list` | Show current queue list |
| `/remove index:<n>` | Remove a song by position in queue |
| `/shuffle` | Shuffle songs in queue |
| `/loop mode:<off/track/queue>` | Set repeat mode |
| `/volume value:<0-10000>` | Adjust volume percentage |

### 🎛️ Control Panel

| Command | Description |
|---------|-------------|
| `/panel` | Send the living music control panel to the control channel |
| `/setup` | Automatically set up `#bocchi` text and voice channels (Admin only) |

### 🤖 AI Chat

| Command | Description |
|---------|-------------|
| `/ai question:<text>` | Chat directly with AI |
| `/airef persona:<text>` | Configure persona prompt for this channel |
| `/setai` | Create a dedicated public AI chat channel |
| `/setaip` | Open a private temporary AI chat thread |
| `/delete` | Close and delete your private AI chat thread |
| `/deletep confirm:true` | Clear messages in public AI channel |
| `/clear` | Clear AI conversation history |

### 🛠️ Utility

| Command | Description |
|---------|-------------|
| `/ping` | Check bot latency and heartbeat |
| `/botupdate` | Check for and update yt-dlp binary |
| `/ytstatus` | Check YouTube cookie status |
| `/ytsignin file:<cookies.txt>` | Upload and activate YouTube cookies (Admin) |
| `/ytsignout` | Remove YouTube cookies (Admin) |
| `/video query:<url>` | Share video link + stream audio |
| `/watchtogether` | Start a Discord Watch Together party link |
| `/vstate` | Debug voice and player diagnostic state |
| `/help` | Display command list and guide |

---

## 🕹️ Interactive Button Controls

When the control panel is posted in `#bocchi`, you can control everything using Discord buttons:

### Main Controls (Row 1)
| Button | Action |
|--------|--------|
| `⏮ Prev` | Jump back to the previous track in history |
| `▶/⏸ Play/Pause` | Instant toggle play and pause |
| `⏭ Next` | Skip to next song |
| `More` | Toggle secondary controls on/off (expands/collapses Row 2) |

### Secondary Controls (Row 2 — Toggled by More)
| Button | Action |
|--------|--------|
| `⏹ Stop` | Stop audio playback and clear the queue |
| `📋 Queue` | View current queue list |
| `🔁 Loop: Off/Track/Queue` | Cycle repeat mode |
| `📝 Lyrics: On/Off` | Toggle karaoke lyrics display |
| `⭐ Favorite` | Save track to favorites |

---

## 🌐 Web Dashboard

Access the dashboard at `http://localhost:4000`:

- Sign in with `DASHBOARD_USER` / `DASHBOARD_PASSWORD` configured in `.env`
- Real-time player status, track scrubbing, and volume control
- Live synchronized karaoke lyrics
- YouTube cookies management directly from web UI

---

## 📁 Project Structure

```
.
├── bot.js              # Main Discord bot application
├── nodelink/           # NodeLink audio engine (Git Submodule)
├── .gitmodules         # Submodule mapping for NodeLink
├── package.json
├── nixpacks.toml       # Railway / Nixpacks deployment configuration
├── Dockerfile
├── Assets/             # Audio assets and chimes
├── .env                # Configuration and API keys (gitignored)
└── cookies.txt         # YouTube cookies file (gitignored)
```

---

## 🔐 Privacy & Security

- Sensitive credentials (`.env` and `cookies.txt`) are excluded from Git via `.gitignore`.
- Dashboard is secured with HTTP basic authentication and rate limiting.
- Interaction replies and diagnostic outputs are ephemeral to prevent channel spam.
