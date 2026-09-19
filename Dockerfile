FROM mcr.microsoft.com/playwright:v1.49.1-noble

WORKDIR /app

# Enable pnpm
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy monorepo manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./

# Copy internal packages and relay app
COPY packages/ ./packages/
COPY apps/relay/ ./apps/relay/

# Install dependencies and compile
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @web2figma/relay build

# Cloud configuration (Render, Railway, Fly.io, etc.)
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3579
EXPOSE 3579

CMD ["node", "apps/relay/dist/server.js"]
