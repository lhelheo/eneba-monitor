# Eneba Monitor: documentação completa do projeto

Documento de referência: o que foi investigado, como o monitor funciona, os desafios
encontrados, o estado atual e os próximos passos.

> Data de referência: 21/11/2026. Os endpoints e hashes descritos aqui são os observados
> nessa data. Eles podem mudar sem aviso, porque pertencem ao frontend da Eneba.

---

## Sumário

1. [Objetivo](#1-objetivo)
2. [Histórico do trabalho](#2-histórico-do-trabalho)
3. [Descobertas técnicas](#3-descobertas-técnicas)
4. [Arquitetura](#4-arquitetura)
5. [Funcionalidades](#5-funcionalidades)
6. [Estrutura do código](#6-estrutura-do-código)
7. [Modelo de dados](#7-modelo-de-dados)
8. [Comandos da CLI](#8-comandos-da-cli)
9. [Configuração](#9-configuração)
10. [Regras de alerta](#10-regras-de-alerta)
11. [Estratégia de coleta e intervalo adaptativo](#11-estratégia-de-coleta-e-intervalo-adaptativo)
12. [Testes realizados](#12-testes-realizados)
13. [Desafios enfrentados](#13-desafios-enfrentados)
14. [Situação atual](#14-situação-atual)
15. [Limitações conhecidas](#15-limitações-conhecidas)
16. [Riscos, termos de uso e ética](#16-riscos-termos-de-uso-e-ética)
17. [Manutenção](#17-manutenção)
18. [Próximos passos](#18-próximos-passos)
19. [Glossário](#19-glossário)

---

## 1. Objetivo

Monitorar o preço de produtos específicos escolhidos pelo usuário no site da Eneba
(marketplace de chaves digitais e gift cards), com verificação a cada ~5 minutos,
histórico de preços e alertas quando algo relevante acontece.

Requisitos definidos na conversa:

- Monitorar **itens selecionados** pelo usuário, não o catálogo inteiro.
- Atualização **em tempo real ou com atraso de no máximo 5 minutos**.
- Lidar com possível **proteção anti-robô**, sem contorná-la de forma agressiva.
- Stack em **TypeScript + Node.js**.

---

## 2. Histórico do trabalho

O trabalho foi feito em etapas, cada uma validando a anterior.

| # | Etapa | Resultado |
|---|---|---|
| 1 | **Planejamento** | Plano em 8 etapas: reconhecimento, arquitetura, coleta em camadas, desafios, modelo de dados, esqueleto, cronograma e riscos. A premissa inicial era usar Playwright para contornar anti-bot. |
| 2 | **Teste de viabilidade** | Verificou se o anti-bot da Eneba inviabilizaria o projeto. Resultado: HTTP comum funciona, e a API GraphQL responde sem cookies. O plano foi simplificado: Playwright deixou de ser o caminho principal. |
| 3 | **Teste de intervalo** | Verificou se é possível atualizar a cada 5 minutos. Resultado: sim. Foram 10 verificações de 1 minuto, todas com HTTP 200. Não há push em tempo real, só polling. |
| 4 | **Implementação** | Criação do monitor completo em TypeScript (ver seções 4 a 8). |
| 5 | **Validação** | Typecheck limpo e testes reais contra a Eneba (ver seção 12). |
| 6 | **Documentação e publicação** | Este documento e o envio ao GitHub. |

### Decisões tomadas ao longo do caminho

- **Descartado o Playwright como coletor principal.** Ele só seria necessário se o anti-bot
  bloqueasse HTTP comum, e isso não aconteceu. Pode voltar como plano B futuro.
- **Descartados serviços de resolução de CAPTCHA e rotação de proxies.** Não foram
  necessários e transformariam um monitor pessoal em algo que viola claramente os termos.
- **Escolhido o GraphQL em lote como fonte principal.** Uma única requisição cobre até
  10 produtos, o que reduz muito a carga.
- **Escolhido o HTML (JSON-LD) como fallback.** Não depende de hashes que mudam, então
  garante funcionamento quando a API quebra.
- **Escolhido SQLite com o módulo `node:sqlite` embutido.** Sem dependência nativa para
  instalar e sem servidor de banco.

---

## 3. Descobertas técnicas

Esta seção resume o que foi observado no site, porque é a base de todo o projeto.

### 3.1 Acesso HTTP

- `https://www.eneba.com/robots.txt` retorna 200. Bloqueia checkout, pagamento, busca,
  `redeem-keys`, `cdn-cgi` e `metrics`. **Páginas de produto não estão bloqueadas.**
- Páginas de produto (`/br/<slug>`) retornam **HTTP 200** com User-Agent de navegador,
  sem desafio do Cloudflare, mesmo sem cookies.
- Um User-Agent genérico (`curl/8`) recebe **HTTP 429**. O filtro existe, mas é por
  assinatura de cliente, não por desafio interativo.
- O cabeçalho `cf-ray` indica que a requisição passa pelo Cloudflare, na região GRU (São Paulo).

### 3.2 Fontes de preço no HTML

Cada página de produto traz dados em três lugares:

1. **JSON-LD** (`<script type="application/ld+json">`, `schema.org/Product`):
   `lowPrice`, `priceCurrency`, `offerCount` e `availability`. É a fonte mais estável.
2. **`__APOLLO_STATE__`** (estado inicial do Apollo Client, serializado no HTML): traz
   `preferredAuction` com o preço em centavos e o estoque.
3. **Dados de vendedores** no próprio estado, mais limitados que a API.

### 3.3 API GraphQL

- Endpoint: `https://graphql.eneba.com/graphql/` (POST).
- Usa **Automatic Persisted Queries (APQ)**: em vez do texto da query, o cliente envia
  `operationName`, `variables` e um hash SHA-256 em `extensions.persistedQuery`.
- O header de versão observado foi `x-version: 20261119-120217`.
- O contexto de região é enviado em `variables.context`: `{country: "BR", region: "brazil", language: "pt_BR"}`.
- Operações úteis:

| Operação | O que faz | Uso no projeto |
|---|---|---|
| `GetProductPageAlgoliaRecommendations` | Recebe uma lista de `productSlugs` e devolve o `cheapestAuction` de cada um, com preço em BRL e EUR e estoque | Coleta principal, em lote |
| `ProductNoCache` | Lista todas as ofertas (vendedores) de um produto, com paginação | Comando `offers` |
| `ProductPage`, `ProductMetaForSeo`, `MetricsTrack` | Usadas pela página em si, sem relevância para o monitor | Não usadas |

- Não há WebSocket, SSE nem subscription GraphQL. O preço só muda quando alguém pede.
- As respostas têm `cache-control: no-cache` ou `max-age=0`, e `cf-cache-status: DYNAMIC`.
  **Não há cache de CDN atrapalhando a atualização.**

### 3.4 Comportamento do APQ

Testes com hashes alterados mostraram:

- Alterar os **primeiros 64 caracteres** do hash faz a API responder
  `{"errors":[{"message":"PersistedQueryNotFound"}]}`. É o sinal de hash vencido.
- Alterar **só o sufixo** do hash (depois do `_`) ainda devolve os dados normalmente.
  A validação parece usar apenas o hash SHA-256 principal.
- Um hash de 64 caracteres sem o sufixo devolve erro de servidor (HTTP 400).

Conclusão: o código detecta `PersistedQueryNotFound` como sinal de hash desatualizado.

### 3.5 Preços observados (21/11/2026, contexto BR/BRL)

| Produto (slug) | Menor preço | Ofertas |
|---|---|---|
| `steam-gift-terraria-steam-gift-global` | R$ 12,99 | 12 |
| `steam-gift-project-zomboid-steam-gift-global` | R$ 60,36 | 10 |
| `steam-valheim-steam-key-global` | R$ 120,01 | 19 |
| `roblox-roblox-100-robux-key-global` | R$ 9,53 a R$ 10,44 (variou no teste) | — |
| `psn-playstation-network-card-100-brl-br-psn-key-brazil` | R$ 100,04 | — |

Os preços variam ao longo do dia. Isso confirma que o monitoramento faz sentido.

---

## 4. Arquitetura

```
           ┌──────────────┐
           │   cli.ts     │  add · remove · list · history · offers · once · run
           └──────┬───────┘
                  ▼
           ┌──────────────┐        ┌──────────────────────────────┐
           │  monitor.ts  │───────▶│ eneba/client.ts              │
           │ (ciclo,      │        │  1. GraphQL em lote (APQ)    │──▶ graphql.eneba.com
           │  fallback,   │        │  2. fallback: HTML/JSON-LD   │──▶ www.eneba.com
           │  intervalo)  │        └──────────────────────────────┘
           └──┬────────┬──┘                   ▲
              │        │                      │ httpFetch (timeout,
              ▼        ▼                      │ headers, retry)
      ┌──────────┐  ┌──────────────┐
      │  db.ts   │  │  alerts.ts   │──▶ console · Telegram · Discord
      │ (SQLite) │  │ (regras)     │
      └──────────┘  └──────────────┘
```

Fluxo de um ciclo:

1. Lê os produtos ativos do banco.
2. Divide em lotes de `BATCH_SIZE` e consulta o GraphQL, um lote por vez.
3. Produtos que não voltaram no lote, ou cujo lote falhou, vão para o fallback HTML, um por vez.
4. Para cada leitura: grava snapshot, atualiza o nome, compara com a leitura anterior e avalia as regras de alerta.
5. Calcula o próximo intervalo (adaptativo) e aguarda, com variação aleatória de ±15%.

### Decisões de design

- **TypeScript rodando direto.** Node 24 remove os tipos em tempo de execução
  (`erasableSyntaxOnly`), então não há etapa de build.
- **Validação com Zod em todas as respostas externas.** Se o formato mudar, o erro é
  explícito (`ParseError`) em vez de gravar dado errado.
- **Estado de "GraphQL desativado" só em memória.** Ao reiniciar, o monitor tenta o GraphQL de novo.
- **Um único processo, sem fila.** Para poucos produtos, uma fila como BullMQ seria
  excesso de complexidade.

---

## 5. Funcionalidades

### Implementadas e testadas

- [x] Cadastro de produto por URL completa ou slug, com validação do domínio e do formato
- [x] Recusa de produto inexistente com mensagem clara (HTTP 404)
- [x] Verificação em lote via GraphQL (até 10 produtos por requisição)
- [x] Fallback automático para HTML/JSON-LD quando a API falha ou não reconhece um slug
- [x] Detecção de hash desatualizado (`PersistedQueryNotFound`) com aviso no log
- [x] Histórico completo de leituras em SQLite
- [x] Alerta de preço-alvo (dispara na transição, não a cada ciclo)
- [x] Alerta de queda percentual em relação à leitura anterior
- [x] Alerta de retorno ao estoque
- [x] Listagem com preço atual, mínimo histórico e alvo
- [x] Listagem de vendedores e preços de um produto (`offers`)
- [x] Intervalo adaptativo: recua em erros, acelera de volta quando normaliza
- [x] Variação aleatória (jitter) no intervalo
- [x] Saída formatada em reais (pt-BR)

### Implementadas, mas não testadas de ponta a ponta

- [ ] Envio de alertas para **Telegram** (código pronto, falta um token real)
- [ ] Envio de alertas para **Discord** (código pronto, falta um webhook real)
- [ ] Encerramento limpo com **Ctrl+C** (o sinal foi tratado no código, mas o teste automatizado não conseguiu enviá-lo no Windows)
- [ ] Comportamento sob **bloqueio real (429/403)** do lado da Eneba (só simulado pela lógica de intervalo)

### Não implementadas

- Painel web ou API HTTP
- Execução agendada como serviço do sistema (systemd, Windows Service, Docker)
- Notificação por e-mail
- Suporte a múltiplas regiões ao mesmo tempo
- Testes automatizados (unitários) no repositório
- Coleta por Playwright (plano B, não necessária até agora)

---

## 6. Estrutura do código

```
eneba-monitor/
├── PROJETO.md              ← este documento
├── README.md               ← guia de uso rápido
├── package.json            ← scripts e dependências
├── tsconfig.json           ← configuração do TypeScript (strict)
├── .env.example           ← modelo de configuração (versionado)
├── .gitignore              ← ignora .env, data/ e node_modules/
└── src/
    ├── cli.ts              ← ponto de entrada: comandos da linha de comando
    ├── config.ts           ← leitura de variáveis de ambiente e valores padrão
    ├── monitor.ts          ← ciclo de coleta, fallback, intervalo adaptativo
    ├── db.ts               ← SQLite: produtos e histórico de preços
    ├── alerts.ts           ← regras de alerta e envio (console/Telegram/Discord)
    ├── log.ts              ← log com timestamp
    └── eneba/
        ├── client.ts       ← chamadas à Eneba: GraphQL e HTML, validação
        ├── http.ts         ← fetch com timeout, headers e retry
        ├── queries.ts      ← hashes das persisted queries (ponto de manutenção)
        └── schemas.ts      ← schemas Zod das respostas
```

### Responsabilidade de cada módulo

| Arquivo | Responsabilidade | Pontos de atenção |
|---|---|---|
| `cli.ts` | Interpreta argumentos (`parseArgs`), chama a lógica certa, trata Ctrl+C no `run` | Valida `--target` e `--drop` como números positivos |
| `config.ts` | Centraliza todos os parâmetros (intervalo, lote, região, timeouts, alertas) | Limita `BATCH_SIZE` a 25 |
| `monitor.ts` | Ciclo completo, decisão GraphQL ou HTML, intervalo adaptativo | Estado de GraphQL desativado é em memória |
| `db.ts` | Schema, upsert, histórico, mínimo histórico | Cria o banco e as tabelas na importação |
| `alerts.ts` | Avalia as regras e envia as mensagens | A regra de alvo só dispara na transição |
| `eneba/client.ts` | Duas fontes de preço e a busca de ofertas | Converte centavos em reais |
| `eneba/http.ts` | `fetch` com `AbortSignal.timeout`, uma nova tentativa para falhas de rede e 5xx | 429/403 não são repetidos aqui, quem decide é o loop |
| `eneba/queries.ts` | Hashes APQ, com comentário de como atualizar | Ponto único de manutenção |
| `eneba/schemas.ts` | Valida tudo que vem da Eneba | Usa `.loose()` para aceitar campos extras |

---

## 7. Modelo de dados

Banco SQLite em `data/monitor.db` (ou o caminho em `DB_PATH`). Modo WAL ativado.

```sql
CREATE TABLE products (
  slug          TEXT PRIMARY KEY,
  name          TEXT,
  target_price  REAL,        -- preço-alvo (alerta ao atingir)
  drop_percent  REAL,        -- queda percentual para alertar
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

CREATE TABLE snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT NOT NULL REFERENCES products(slug) ON DELETE CASCADE,
  captured_at   TEXT NOT NULL,   -- ISO 8601 UTC
  price         REAL,            -- em unidades (12.99), não centavos
  currency      TEXT NOT NULL,   -- BRL
  in_stock      INTEGER NOT NULL,
  offers_count  INTEGER,         -- nulo no modo lote
  source        TEXT NOT NULL    -- 'graphql' ou 'html'
);

CREATE INDEX idx_snapshots_slug_time ON snapshots(slug, captured_at DESC);
```

Decisões:

- **Histórico completo, sem limpeza automática.** Cada leitura vira uma linha. Para
  10 produtos a cada 5 min, são cerca de 2.900 linhas por dia. Não é um problema.
- **Preço em reais (REAL), não em centavos.** A conversão acontece na borda (`client.ts`).
- **Remover um produto apaga o histórico dele.** É intencional, mas vale saber.

---

## 8. Comandos da CLI

| Comando | Função | Exemplo |
|---|---|---|
| `add <url\|slug>` | Cadastra ou atualiza um produto | `npm run cli -- add steam-gift-terraria-steam-gift-global --target 11.50 --drop 5` |
| `remove <slug>` | Remove o produto e seu histórico | `npm run cli -- remove steam-gift-terraria-steam-gift-global` |
| `list` | Tabela com preço atual, mínimo, alvo, queda e última leitura | `npm run cli -- list` |
| `history <slug> [--limit N]` | Últimas leituras | `npm run cli -- history steam-gift-terraria-steam-gift-global --limit 20` |
| `offers <url\|slug>` | Vendedores e preços no momento | `npm run cli -- offers steam-gift-project-zomboid-steam-gift-global` |
| `once` | Uma rodada de verificação | `npm run cli -- once` |
| `run` (ou `npm start`) | Loop contínuo, Ctrl+C para parar | `npm start` |

Comportamentos de `add`:

- Consulta o produto antes de gravar, então produto inexistente nunca entra no banco.
- A primeira leitura vira a base de comparação.
- Se o preço atual já estiver no alvo, avisa que o alerta só dispara quando o preço subir e voltar a cair.

---

## 9. Configuração

Variáveis de ambiente, lidas do `.env` (modelo em `.env.example`):

| Variável | Padrão | Descrição |
|---|---|---|
| `INTERVAL_MINUTES` | `5` | Intervalo base entre ciclos |
| `BATCH_SIZE` | `10` | Produtos por chamada GraphQL (máximo 25) |
| `DB_PATH` | `data/monitor.db` | Caminho do banco SQLite |
| `ENEBA_COUNTRY` | `BR` | País do contexto de preço |
| `ENEBA_REGION` | `brazil` | Região do contexto |
| `ENEBA_LANGUAGE` | `pt_BR` | Idioma |
| `ENEBA_CURRENCY` | `BRL` | Moeda de exibição |
| `TELEGRAM_BOT_TOKEN` | vazio | Token do bot (opcional) |
| `TELEGRAM_CHAT_ID` | vazio | Chat de destino (opcional) |
| `DISCORD_WEBHOOK_URL` | vazio | Webhook do Discord (opcional) |

Constantes internas em `config.ts`, sem variável de ambiente:

| Constante | Valor | Motivo |
|---|---|---|
| `maxIntervalMs` | 60 min | Teto do recuo em caso de bloqueio |
| `jitterRatio` | 0,15 | Evita bater sempre no mesmo segundo |
| `slowCycleMs` | 10 s | Ciclo mais lento que isso indica possível limitação |
| `requestTimeoutMs` | 20 s | Tempo máximo por requisição |
| `htmlFallbackDelayMs` | 2–4 s | Pausa entre requisições de HTML |

---

## 10. Regras de alerta

Avaliadas a cada leitura, comparando com a leitura anterior (`alerts.ts`):

| Regra | Dispara quando | Detalhe |
|---|---|---|
| **Preço-alvo** | O preço cai para o alvo ou abaixo | Só dispara na **transição** (a leitura anterior estava acima do alvo, ou não existia). Não repete a cada ciclo. |
| **Queda percentual** | A queda em relação à leitura anterior é de X% ou mais | Calculada como `(anterior - atual) / anterior`. Usa a última leitura, não a média. |
| **Retorno ao estoque** | O produto estava sem estoque e voltou | Só compara com a leitura imediatamente anterior. |

Canais de envio:

- **Console**: sempre ativo.
- **Telegram**: via `sendMessage` da Bot API, se `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID` estiverem definidos.
- **Discord**: via webhook, se `DISCORD_WEBHOOK_URL` estiver definido.

Falha de envio é registrada como aviso e não interrompe o monitor.

---

## 11. Estratégia de coleta e intervalo adaptativo

### Hierarquia de fontes

1. **GraphQL em lote.** Uma requisição por até 10 produtos. Caminho normal.
2. **HTML/JSON-LD, um produto por vez.** Usado quando:
   - a API falha por rede ou erro de servidor;
   - o hash está desatualizado (`PersistedQueryNotFound`), e nesse caso o GraphQL fica
     desativado por 6 horas;
   - a API não devolve um produto do lote.
3. **Bloqueio.** Se houver 429, 403 ou 503, o ciclo para de tentar e o intervalo cresce.

### Intervalo adaptativo (`monitor.ts`)

| Situação | Ação |
|---|---|
| Erro, 429, 403 ou 503 | Dobra o intervalo (até 60 min) |
| Ciclo lento (acima de 10 s) | Aumenta 50% |
| Tudo normal | Reduz pela metade, sem ir abaixo do base (5 min) |

Antes de cada espera, aplica ±15% de variação aleatória.

Com o intervalo base de 5 min, o consumo normal é de cerca de **12 requisições por hora**
(uma em lote por ciclo), mais o fallback quando necessário.

---

## 12. Testes realizados

### 12.1 Testes de viabilidade (antes do código)

| Teste | Resultado |
|---|---|
| `robots.txt` acessível | 200, páginas de produto não bloqueadas |
| HTML de produto, User-Agent de navegador | 200, ~1 s |
| 10 páginas em sequência, 1 s entre elas | 10 de 10 com 200 |
| User-Agent `curl/8` | **429** |
| GraphQL sem cookies, chamado do Node | 200, dados completos |
| Polling de 1 min por 10 min (30 requisições) | 30 de 30 com 200, preços coerentes entre as três fontes |

### 12.2 Testes do código

| Teste | Resultado |
|---|---|
| Typecheck (`tsc`, modo strict) | Passou sem erros |
| `add` com URL válida | Cadastrou e gravou a primeira leitura |
| `add` com slug de produto inexistente | Recusado: "Produto não encontrado na Eneba" (após correção) |
| `add` com URL de outro domínio | Recusado |
| `once` com 3 produtos | 3 ok, 0 falhas, 0,7 s, via GraphQL |
| Queda de preço simulada (R$ 14,00 → R$ 12,99) | Alerta "caiu 7.2%" disparado |
| Retorno ao estoque simulado | Alerta "voltou ao estoque" disparado |
| `history` e `list` | Saída correta, com histórico em ordem |
| `offers` em produto com 10 ofertas | Mostrou as 3 primeiras e o total |
| Fallback HTML direto (Valheim) | R$ 120,01, 19 ofertas, fonte `html` |
| `run` (loop contínuo) por ~1 min | 4 ciclos seguidos, todos com 3 ok e intervalo ~0,1 a 0,2 min (intervalo de teste) |
| Hash alterado no início | `PersistedQueryNotFound` confirmado |

### 12.3 O que ainda não foi testado

- Envio real para Telegram e Discord.
- Ctrl+C num terminal interativo.
- Resposta do monitor a um bloqueio real (429/403) da Eneba.
- Execução por horas ou dias (o teste mais longo foi de 1 minuto).
- Ciclo com o fallback HTML para vários produtos em sequência, com pausas reais.
- Comportamento com mais de 10 produtos (mais de um lote).

---

## 13. Desafios enfrentados

### 13.1 Anti-bot (Cloudflare)

**Esperado:** que o site bloqueasse coleta automatizada e exigisse navegador real ou
resolução de CAPTCHA.

**Observado:** nenhum desafio interativo apareceu em HTTP comum com User-Agent de
navegador. A única barreira foi um 429 para um User-Agent genérico.

**Resultado:** o projeto ficou muito mais simples do que o plano original. Playwright,
proxies e serviços de CAPTCHA não foram necessários.

**Ressalva:** isso vale para volume baixo. Se o volume aumentar, o comportamento pode mudar.

### 13.2 Hashes de persisted queries

**Problema:** a API só aceita hashes que correspondam à versão atual do frontend.
Quando a Eneba publica uma versão nova, os hashes mudam e a API para de responder.

**Solução em camadas:**
1. O código detecta `PersistedQueryNotFound` e avisa no log.
2. Desativa o GraphQL por 6 horas e usa só o HTML, que não depende de hash.
3. Os hashes ficam num único arquivo (`queries.ts`), com instruções de atualização.

**Pendência:** hoje a atualização dos hashes é manual. Uma automação que redescobre os
hashes lendo o bundle JavaScript da página seria o próximo passo natural.

### 13.3 Erros de tipo e validação

- Os schemas Zod precisaram de `.loose()` para aceitar campos extras da API sem quebrar.
- O schema do JSON-LD precisou aceitar tanto `lowPrice` quanto `price`, porque as páginas usam formatos diferentes.
- O `offerCount` pode vir como texto ou número. Por isso `z.coerce.number()`.

### 13.4 Mensagem de erro enganosa para produto inexistente

**Problema:** um slug que não existe devolvia só `HTTP 404 em <url>`, sem explicar o motivo.

**Solução:** `fetchPriceFromHtml` converte o 404 em "Produto não encontrado na Eneba".

### 13.5 Regra de alvo disparando a cada ciclo

**Problema potencial:** se o preço ficasse abaixo do alvo, um alerta a cada ciclo seria spam.

**Solução:** a regra só dispara quando o preço **cruza** o alvo, comparando com a leitura anterior.

**Efeito colateral:** se você cadastra um alvo que o preço já atingiu, o alerta não dispara
de imediato. O comando `add` avisa isso.

### 13.6 Processo deixado rodando no Windows

**Problema:** o teste do loop contínuo usou `timeout -s INT`, que não funcionou no Windows.
O processo continuou rodando depois do tempo limite. Além disso, o `npm run` não estava
encerrado corretamente.

**Solução:** o processo foi encerrado à força e o banco de teste foi removido. Uma nota
na seção 12.3 registra que o Ctrl+C ainda precisa ser validado num terminal normal.

### 13.7 Teste do hash alterado

**Problema:** o primeiro teste de "hash vencido" alterou o final do hash, e a API respondeu
normalmente. Isso parecia contradizer a hipótese de validação.

**Esclarecimento:** pelos testes, a validação parece depender só da parte principal do
hash (os primeiros 64 caracteres). Alterar o sufixo não gerou erro. Alterar a parte principal
gerou `PersistedQueryNotFound`. Isso é uma inferência a partir de poucos testes.

### 13.8 Execução em segundo plano

Parte dos testes precisou rodar em segundo plano por demorar mais que o limite da ferramenta.
Foi necessário parar um processo esquecido e conferir se o banco de teste foi limpo.

---

## 14. Situação atual

### Estado do código

- Projeto completo, com 8 módulos em `src/`.
- Typecheck limpo em modo `strict`.
- Dependências instaladas: `zod`, `typescript`, `@types/node`.
- Nenhum teste automatizado no repositório ainda.

### Estado do banco e da configuração

- `data/` está vazio ou com dados de teste. **Não é versionado.**
- `.env` existe, criado a partir de `.env.example`, com os campos de alerta vazios.
  **Não é versionado.**
- O banco de teste foi removido. O banco real ainda não foi criado com produtos do usuário.

### Estado do repositório

- Git inicializado localmente, com commit inicial na branch `main`.
- **Ainda não publicado no GitHub.** O envio depende de um repositório remoto criado pelo usuário.

### O que funciona agora, de ponta a ponta

Cadastrar produtos, verificar preços, gravar histórico e disparar alertas no console,
inclusive num loop contínuo, contra a Eneba real.

### O que ainda não foi validado

Alertas no Telegram e no Discord, Ctrl+C num terminal normal, execução prolongada (horas
ou dias) e comportamento sob bloqueio real.

---

## 15. Limitações conhecidas

| Limitação | Impacto | Mitigação |
|---|---|---|
| Hashes APQ dependem da versão do frontend | Sem o GraphQL, a coleta fica mais lenta e depende de HTML | Fallback automático, atualização manual documentada |
| Preço depende de região e moeda | Trocar `ENEBA_COUNTRY` muda os valores | Configuração explícita no `.env` |
| `offers` mostra só 3 vendedores | Visão parcial do mercado | Aviso do total de ofertas; paginação é trabalho futuro |
| Estado de "GraphQL desativado" fica em memória | Ao reiniciar, tenta o GraphQL de novo | Comportamento aceitável |
| Sem testes automatizados | Regressões dependem de teste manual | Próximo passo recomendado |
| Sem execução como serviço | O processo precisa ficar aberto | Pode-se usar Task Scheduler, systemd ou Docker |
| Um único processo, sem fila | Não escala para centenas de produtos | Não é necessário para o caso de uso |
| Remover um produto apaga o histórico | Perda de dados se feito por engano | Comando explícito, sem confirmação |
| `DB_PATH` relativo | O banco é criado na pasta de execução | Usar caminho absoluto se rodar como serviço |

---

## 16. Riscos, termos de uso e ética

### Termos e robots.txt

- O `robots.txt` da Eneba não bloqueia páginas de produto. As rotas bloqueadas (checkout,
  pagamento, busca, `redeem-keys`) não são acessadas pelo monitor.
- Os **Termos de Uso** da Eneba não foram lidos neste projeto. Antes de uso contínuo,
  vale conferir se há cláusula sobre coleta automatizada.
- O `robots.txt` também lista um bot específico (`idealo-bot`) com regras próprias. O monitor
  não se identifica como esse bot, nem deve fazê-lo.

### Uso responsável adotado

- Baixo volume: cerca de 12 requisições por hora, no total, para qualquer quantidade de produtos até 10.
- Intervalo mínimo de 5 min por padrão, e recuo automático diante de qualquer limitação.
- Uso pessoal: nenhum dado é revendido ou publicado.
- Nada de rotação de IP, proxies ou resolução de CAPTCHA.
- User-Agent de navegador comum, sem identificação falsa de outro bot.

### Alternativa recomendada, se o uso crescer

A Eneba tem programa de afiliados. Se houver acesso a um feed oficial de produtos,
ele substitui a coleta por completo e evita qualquer atrito com o site.

### Riscos residuais

- A Eneba pode mudar a proteção a qualquer momento e passar a bloquear o monitor.
- Mudanças no frontend quebram os hashes e o JSON-LD, o que exige manutenção.
- O projeto depende de endpoints não documentados. Eles podem sumir sem aviso.

---

## 17. Manutenção

### Quando a coleta falhar

| Sintoma no log | Causa provável | Ação |
|---|---|---|
| `PersistedQueryNotFound` | Hash vencido | Atualizar `src/eneba/queries.ts` (ver abaixo) |
| `HTTP 429` ou `HTTP 403` | Limitação ou bloqueio | Nada a fazer; o monitor recua sozinho. Se persistir, aumentar `INTERVAL_MINUTES` |
| `Desafio anti-bot` | Cloudflare pediu verificação | Aguardar; o monitor recua. Se persistir, reavaliar a estratégia |
| `JSON-LD de produto não encontrado` | Layout da página mudou | Ajustar `fetchPriceFromHtml` |
| `Formato inesperado em ...` | Schema da API mudou | Ajustar `schemas.ts` |
| `Produto não encontrado` | Slug mudou ou foi removido | Conferir o slug e usar `remove` + `add` |

### Como atualizar os hashes

1. Abrir uma página de produto no navegador, com o DevTools aberto na aba **Network**.
2. Filtrar por `graphql`.
3. Localizar as requisições `GetProductPageAlgoliaRecommendations` e `ProductNoCache`.
4. Copiar `extensions.persistedQuery.sha256Hash` de cada uma.
5. Atualizar `src/eneba/queries.ts` e rodar `npm run cli -- once`.

### Verificação rápida de saúde

```powershell
npm run cli -- once
```

Se o resultado for `N ok, 0 falha(s)` e o log não mostrar `PersistedQueryNotFound`,
está tudo funcionando.

---

## 18. Próximos passos

Em ordem de prioridade sugerida:

1. **Testar os alertas** no Telegram ou no Discord com um token real.
2. **Validar o Ctrl+C** num terminal normal.
3. **Rodar por algumas horas** para observar estabilidade, latência e eventuais 429.
4. **Escrever testes automatizados** para as regras de alerta e para os parsers
   (JSON-LD e schemas), com dados de exemplo salvos.
5. **Automatizar a atualização dos hashes**: redescobrir as operações lendo o bundle JS
   da página, ou com Playwright como plano B.
6. **Executar como serviço**: Task Scheduler no Windows, ou Docker.
7. **Paginação em `offers`**, para listar todos os vendedores.
8. **Painel simples** ou um comando de relatório com gráfico de histórico.
9. **Avaliar o programa de afiliados** caso o volume ou o uso mude.

---

## 19. Glossário

| Termo | Significado |
|---|---|
| **APQ (Automatic Persisted Queries)** | Mecanismo em que o cliente envia um hash em vez da query completa. O servidor só executa queries já conhecidas. |
| **Persisted query** | Query registrada no servidor e identificada por hash. |
| **Hash SHA-256** | Impressão digital da query. Muda se o texto da query mudar. |
| **Cloudflare** | Serviço de CDN e proteção anti-bot usado pela Eneba. |
| **JSON-LD** | Dados estruturados em JSON dentro da página, no padrão schema.org. |
| **schema.org/Product** | Vocabulário padrão para descrever produtos, com preço e disponibilidade. |
| **Polling** | Consultar um recurso periodicamente, em vez de receber um aviso quando algo muda. |
| **Jitter** | Variação aleatória num intervalo, para não repetir sempre no mesmo momento. |
| **Circuit breaker / recuo** | Parar ou desacelerar após falhas repetidas, para não agravar o problema. |
| **Snapshot** | Uma leitura de preço gravada com data e hora. |
| **Slug** | Parte final da URL de um produto, ex.: `steam-gift-terraria-steam-gift-global`. |
| **BRL / EUR** | Real brasileiro / Euro. A Eneba informa preço nas duas moedas. |
