FROM node:22-bookworm-slim

# Default runtime environment variables
ENV NODE_ENV=production \
    PORT=4000 \
    TZ=Asia/Bangkok

# Install system dependencies:
# - ffmpeg: audio decoding and encoding pipeline
# - python3 & python-is-python3: required for yt-dlp execution
# - curl & ca-certificates: required for secure downloads and health checks
# - tzdata: timezone configuration
# - build-essential: C++ compilers required for native modules (@discordjs/opus)
# - yt-dlp: standalone binary installed to system PATH
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg \
      python3 \
      python-is-python3 \
      ca-certificates \
      tzdata \
      curl \
      build-essential \
 && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package descriptors for layer caching
COPY package*.json ./

# Install production dependencies and remove build tools to keep final image slim
RUN npm install --omit=dev --no-audit --no-fund --legacy-peer-deps \
 && apt-get purge -y --auto-remove build-essential \
 && rm -rf /var/lib/apt/lists/* /root/.npm

# Copy application source code
COPY . .

# Ensure data and log directories exist
RUN mkdir -p /app/data /app/logs

# Expose web dashboard port
EXPOSE 4000

CMD ["npm", "start"]