# Runs anywhere that takes a container: Fly.io, Railway, Render, a VPS.
FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

# Every directory the server can serve has to be listed here. Forgetting one
# does not fail the build — the page still renders and only the missing files
# 404, which reads like a broken link rather than a packaging bug. It has
# happened twice: once for assets, once for legal. test/docker.test.js now
# fails if a servable directory is missing from this list.
COPY shared ./shared
COPY server ./server
COPY client ./client
COPY assets ./assets
COPY legal ./legal
COPY index.html ./

ENV PORT=8080
ENV TRUST_PROXY=1
EXPOSE 8080

# Run unprivileged.
USER node

CMD ["node", "server/index.js"]
