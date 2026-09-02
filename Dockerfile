# PPTist 自部署镜像：单容器同时提供页面、默认 PPT API 与 SSE 通知
# 构建：docker build -t pptist-standalone .
# 运行：docker run -d -p 8686:8686 -v pptist-data:/app/data --env PPTIST_PUBLIC_URL=http://<服务器IP>:8686 pptist-standalone
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build-only

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
# 默认 PPT 持久化目录（挂载卷后容器重建不丢失）
VOLUME ["/app/data"]
EXPOSE 8686
CMD ["node", "server/pptist-server.mjs"]
