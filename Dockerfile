FROM node:22.14.0-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
RUN npm run check

ENV NODE_ENV=production
EXPOSE 4173
CMD ["npm", "start"]
