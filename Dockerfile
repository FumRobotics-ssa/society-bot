FROM node:22.19.0-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY public ./public
COPY migrations ./migrations
COPY scripts ./scripts
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV HOST=0.0.0.0 PORT=8787 DB_PATH=/app/data/siahe.sqlite
EXPOSE 8787
CMD ["node", "src/server.js"]
