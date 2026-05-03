FROM node:22-alpine
RUN apk add --no-cache wget
WORKDIR /app
COPY package.json package-lock.json* ./
COPY shared/ ./shared/
COPY server/ ./server/
RUN npm ci --workspace=server --workspace=shared
RUN npm run build --workspace=server
RUN npm ci --workspace=server --workspace=shared --omit=dev
WORKDIR /app/server
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 CMD wget --quiet --tries=1 --spider http://localhost:3001/health || exit 1
CMD ["node", "dist/index.js"]
