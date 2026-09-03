# syntax=docker/dockerfile:1

# The Discord transport for assistant-hub-swarm. One process, one HTTP port, no
# database, no migrations, no volumes — it registers with a core at boot and
# reconciles from the desired state the core answers with.
#
#   docker build --secret id=npm_token,env=NPM_TOKEN -t ahw-transport-discord .
#
# The SDK comes from GitHub Packages, whose npm registry wants a token on every
# request: a public package there is readable by any account, but not
# anonymously. So the build takes one as a BuildKit secret — never a build arg,
# never a layer. Any token with `read:packages` will do; in CI it is the
# workflow's own GITHUB_TOKEN.
#
# It runs from TypeScript source via tsx: the entrypoint uses top-level await,
# and a compile step would buy nothing here but a second module resolution to
# keep correct.

FROM node:24-alpine AS base
WORKDIR /app

# --- deps ---
# `npm install`, not `npm ci`: the lockfile may be generated on another OS and
# omit Linux-only optional native deps (sharp's musl build, which the SDK pulls
# in for image normalization), which `npm ci`'s strict sync check rejects.
#
# The committed `.npmrc` carries the scope; the token is appended from the
# secret and the file is deleted inside the same layer, so nothing about it is
# recoverable from the image.
FROM base AS deps
COPY package.json package-lock.json* .npmrc ./
RUN --mount=type=secret,id=npm_token \
    set -eu; \
    if [ -s /run/secrets/npm_token ]; then \
      printf '//npm.pkg.github.com/:_authToken=%s\n' "$(cat /run/secrets/npm_token)" >> .npmrc; \
    fi; \
    npm install --no-audit --no-fund; \
    rm -f .npmrc

# --- runner ---
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3220

# No ffmpeg here, unlike the Telegram transport: Discord hands over an
# attachment's bytes and its content type directly, so nothing samples video
# frames. sharp, which the SDK brings for image normalization, ships its own
# musl libvips binary via npm and needs no system package either.

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# Run as non-root.
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

EXPOSE 3220

# The core probes /health unauthenticated; answering it is the first thing the
# process does, before it registers.
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health >/dev/null 2>&1 || exit 1

CMD ["npx", "tsx", "src/index.ts"]
