# The application contains the native Pi/Dashi/Office processing path, which
# requires a complete Node/Linux runtime rather than a Workers isolate.
FROM node:24.19-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . ./

RUN npm run build:server

# Dashi's native renderer deliberately ships as a pinned in-repository skill.
# Install it at image build time so a cold production container never mutates
# its ephemeral filesystem or waits on a package registry.
RUN npm ci --prefix server/agent/skills/dashi-ppt/project

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787

EXPOSE 8787

CMD ["node", "server-dist/server/index.js"]
