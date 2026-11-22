# Imagem do monitor de preços da Eneba.
# Node 24 executa TypeScript direto (type stripping) e traz o módulo node:sqlite embutido.
FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production \
    TZ=America/Sao_Paulo

# Dependências de produção primeiro, para aproveitar o cache de camadas.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src

# Diretório do banco SQLite, com dono para o usuário não-root.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

CMD ["node", "--disable-warning=ExperimentalWarning", "src/cli.ts", "run"]
