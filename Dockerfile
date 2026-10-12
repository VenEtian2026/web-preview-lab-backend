FROM node:20-bookworm

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

RUN npx playwright install --with-deps chromium

COPY . .

ENV NODE_ENV=production

EXPOSE 10000

CMD ["node", "app.js"]
