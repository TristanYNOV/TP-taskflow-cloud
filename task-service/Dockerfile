FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
COPY prom-client ./prom-client/
RUN npm ci --omit=dev

COPY src ./src/

EXPOSE 3002

CMD ["node", "src/index.js"]
