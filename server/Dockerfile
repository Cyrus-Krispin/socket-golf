FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
COPY shared/ ./shared/
COPY server/ ./server/
RUN npm ci --workspace=server --workspace=shared --omit=dev
WORKDIR /app/server
EXPOSE 3001
CMD ["node", "--import", "tsx", "src/index.ts"]
