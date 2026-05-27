# Stage 1: Build the NestJS application
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# Stage 2: Run the production application
FROM node:20-alpine

WORKDIR /app

# Install FFmpeg and Python3 (required by yt-dlp)
RUN apk add --no-cache ffmpeg python3

COPY package*.json ./
# Install only production dependencies
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/scripts ./scripts

# Run fix-ytdlp.js to ensure yt-dlp is downloaded and executable
RUN node scripts/fix-ytdlp.js

EXPOSE 3001

ENV NODE_ENV=production

CMD ["npm", "run", "start:prod"]
