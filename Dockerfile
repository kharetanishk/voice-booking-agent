FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.json ./
RUN bun install --frozen-lockfile
COPY server server
COPY web web
ENV NODE_ENV=production
CMD ["bun", "server/index.ts"]
