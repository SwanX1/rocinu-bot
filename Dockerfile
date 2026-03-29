FROM oven/bun:alpine AS base

FROM base AS build

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --no-cache --verbose

COPY . .
RUN bun --bun build --production --target=bun --outfile=built.js --minify src/index.ts

FROM base AS prod
WORKDIR /app

COPY --from=build /app/built.js ./built.js

# would be useful here:
# `--fetch-preconnect=discord gateway`
# `--sql-preconnect`
CMD ["bun", "run", "--bun", "--no-install", "--prefer-offline", "./built.js"]