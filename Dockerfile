FROM node:20-slim

# Install Python3, yt-dlp deps, ffmpeg
RUN apt-get update && apt-get install -y \
    python3 python3-pip ffmpeg \
    && pip3 install yt-dlp --break-system-packages \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
