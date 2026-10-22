# ── Etapa 1: compila o TypeScript ─────────────────────────────────────────────
FROM node:24-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
# --ignore-scripts: o better-sqlite3 já traz o binário pronto para Linux (prebuilds/),
# então não há compilação nativa (node-gyp) nem dependência de python/gcc na imagem.
RUN npm ci --ignore-scripts

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

# ── Etapa 2: imagem final, só com o necessário para rodar ─────────────────────
FROM node:24-slim
ENV NODE_ENV=production \
    TZ=America/Sao_Paulo
WORKDIR /app

# tzdata: horário local correto nos logs e na ferramenta obter_data_hora.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY .agents ./.agents
COPY modulos ./modulos
COPY web ./web
COPY evals ./evals

# Pastas graváveis pelo usuário sem privilégios (o volume /app/state herda essa posse).
RUN mkdir -p state data workspace tmp perfis && chown -R node:node /app
USER node

# Padrão: canais de serviço (bot do Telegram). Perfil: PERFIL=<nome>.
# Chat no terminal: docker compose run --rm parreiraclaw node dist/canais/terminal/chat.js
CMD ["node", "dist/main.js"]
