# Runs anywhere that takes a container: Fly.io, Railway, Render, a VPS.
FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY shared ./shared
COPY server ./server
COPY client ./client
COPY index.html ./

ENV PORT=8080
ENV TRUST_PROXY=1
EXPOSE 8080

# Run unprivileged.
USER node

CMD ["node", "server/index.js"]
