FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg python3 python-is-python3 ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./

ENV NODE_ENV=production

RUN npm install --omit=dev --no-audit --no-fund --legacy-peer-deps

COPY . .

CMD ["npm","start"]