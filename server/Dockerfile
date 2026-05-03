FROM node:22-alpine AS client-builder
WORKDIR /app
COPY package.json package-lock.json* ./
COPY shared/ ./shared/
COPY client/ ./client/
RUN npm ci --workspace=client --workspace=shared
RUN npm run build -w shared
RUN npm run build -w client

FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
COPY shared/ ./shared/
COPY server/ ./server/
RUN npm ci --workspace=server --workspace=shared --omit=dev
COPY --from=client-builder /app/client/dist ./client/dist
WORKDIR /app/server
EXPOSE 3001
CMD ["node", "--import", "tsx", "src/index.ts"]
