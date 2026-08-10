# syntax=docker/dockerfile:1

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# N8N_HOST/N8N_API_KEY aren't needed at build time (only next build + typecheck
# run here, no data fetching) — real values are injected at container runtime.
RUN npm run build

# output: "standalone" (next.config.ts) means .next/standalone already
# contains server.js + only the node_modules actually used, so the final
# image never needs a full `npm install`.
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

# 0.0.0.0 here is standard Docker practice: isolation from the outside world
# is enforced by docker-compose's port mapping (bound to 127.0.0.1 on the
# host), not by the process inside the container.
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000

CMD ["node", "server.js"]
