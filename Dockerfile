FROM node:22-alpine AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci || npm install
COPY web ./
RUN npx vite build

FROM node:22-alpine
WORKDIR /app
# fail fast and retry instead of hanging for minutes on a flaky registry connection
ENV NPM_CONFIG_FETCH_RETRIES=5 NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=2000 NPM_CONFIG_FETCH_TIMEOUT=60000 NPM_CONFIG_AUDIT=false NPM_CONFIG_FUND=false
COPY server/package*.json server/
RUN cd server && (npm ci || npm install)
COPY server server
COPY --from=web /app/web/dist web/dist
ENV PORT=3000 CURRENT_DATE=2026-11-23
EXPOSE 3000
# seed synthetic data (deterministic) then start
CMD ["sh", "-c", "cd server && npm run seed && npm start"]
