start "NodeLink" powershell -NoExit -Command "cd nodelink; node --experimental-strip-types src/index.ts"
start "MusicBot" node bot.js
start powershell -NoExit -Command "ngrok http 4000"