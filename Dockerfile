FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY app.js commands.js excuses.js utils.js excuses.json ./
COPY discord-api.js panel.js publish-panel.js interactions.js ./
COPY portrait.js portrait-text.js portrait-store.js portrait-runtime.js voice-roster.js ./
COPY picker.js ./

ENV NODE_ENV=production
ENV STATE_DIR=/app/data
EXPOSE 3000

CMD ["node", "app.js"]
