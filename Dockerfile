FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
RUN mkdir -p /data
EXPOSE 3000
CMD ["node", "src/server.mjs"]
