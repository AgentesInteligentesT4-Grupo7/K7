# K7 no Docker: a Central (administração, fitas e bots) e o site, a partir do código-fonte.
# Roda com o tsx (como o `npm run admin` no Windows): as extensões das fitas são TypeScript carregado na hora,
# então não há etapa de compilação separada.
FROM node:24-slim
ENV NODE_ENV=production \
    TZ=America/Sao_Paulo \
    K7_NAVEGADOR=/usr/bin/chromium
WORKDIR /app

# tzdata: horário local nos logs e nas fitas. chromium + fontes: as imagens das fitas (layouts HTML viram PNG),
# com acentos e os ícones de emoji dos layouts.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata ca-certificates chromium fonts-dejavu-core fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# --ignore-scripts: o better-sqlite3 já traz o binário pronto para Linux (prebuilds/), sem node-gyp.
# --include=dev (o NODE_ENV=production tiraria): o tsx é quem carrega o código e as extensões das fitas.
RUN npm ci --ignore-scripts --include=dev && npm cache clean --force

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY .agents ./.agents
COPY modulos ./modulos
COPY web ./web
COPY estilos ./estilos
COPY evals ./evals

# Pastas graváveis pelo usuário sem privilégios (o volume /app/state herda essa posse).
RUN mkdir -p state/dados data workspace tmp perfis && chown -R node:node /app
USER node

# Padrão: a Central. O site e o chat no terminal trocam o comando (veja o docker-compose.yml).
CMD ["node", "--import", "tsx", "src/canais/admin/admin.ts"]
