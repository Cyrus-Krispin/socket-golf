FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
COPY shared/ ./shared/
COPY server/ ./server/
RUN npm ci --workspace=server --workspace=shared
RUN npm run build --workspace=server
RUN npm ci --workspace=server --workspace=shared --omit=dev
WORKDIR /app/server
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 CMD node -e "require('http').get('http://localhost:3001/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"
CMD ["node", "dist/index.js"]
