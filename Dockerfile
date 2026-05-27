# Stage 1: Build the NestJS application
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies (python3, make, g++) and create symlink for python
RUN apk add --no-cache python3 make g++ && ln -sf /usr/bin/python3 /usr/bin/python

COPY package*.json ./
COPY scripts/ ./scripts/

RUN npm install

COPY . .
RUN npm run build

# Stage 2: Run the production application
FROM node:20-alpine

WORKDIR /app

# Install runtime dependencies (FFmpeg and Python3 for yt-dlp)
RUN apk add --no-cache ffmpeg python3 && ln -sf /usr/bin/python3 /usr/bin/python

COPY package*.json ./
COPY scripts/ ./scripts/

# Install only production dependencies (this will trigger fix-ytdlp.js automatically)
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist

EXPOSE 3001

ENV NODE_ENV=production

CMD ["npm", "run", "start:prod"]
