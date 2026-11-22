# Eneba Monitor

Monitor de preços de produtos da [Eneba](https://www.eneba.com) em TypeScript/Node.
Verifica os produtos cadastrados a cada ~5 minutos, grava o histórico em SQLite
e envia alertas (console, Telegram e/ou Discord).

## Requisitos

- Node.js **24+** (roda TypeScript direto, sem build, e usa o SQLite embutido `node:sqlite`)

## Instalação

```powershell
npm install
Copy-Item .env.example .env   # ajuste intervalo, região e alertas
```

## Uso

```powershell
# cadastrar produtos (URL completa ou slug)
npm run cli -- add https://www.eneba.com/br/steam-gift-terraria-steam-gift-global --target 11.50 --drop 5
npm run cli -- add steam-gift-project-zomboid-steam-gift-global --drop 3

npm run cli -- list                      # preço atual, mínimo histórico, alvo
npm run cli -- history <slug>            # leituras anteriores
npm run cli -- offers <slug>             # vendedores e preços agora
npm run cli -- remove <slug>
npm run cli -- once                      # uma verificação
npm start                                # loop contínuo (Ctrl+C para parar)
```

### Regras de alerta

| Opção | Dispara quando |
|---|---|
| `--target 11.50` | o menor preço chega a R$ 11,50 ou menos (no momento em que cruza o alvo) |
| `--drop 5` | o preço cai 5% ou mais em relação à leitura anterior |
| *(sempre)* | o produto volta ao estoque |

Para receber no celular, preencha `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`
ou `DISCORD_WEBHOOK_URL` no `.env`.

## Como funciona

```
cli.ts ──▶ monitor.ts ──▶ eneba/client.ts ──▶ GraphQL (lote)  ──┐
              │                     └──────▶ HTML / JSON-LD ──┤ fallback
              ├──▶ db.ts (SQLite: products, snapshots)        │
              └──▶ alerts.ts (regras + Telegram/Discord)  ◀───┘
```

1. **GraphQL em lote** (`graphql.eneba.com`, operação `GetProductPageAlgoliaRecommendations`):
   até `BATCH_SIZE` produtos numa única requisição, ou seja, ~12 requisições/hora no total com intervalo de 5 min.
2. **Fallback HTML**: se a API falhar ou não reconhecer um slug, lê o JSON-LD
   (`schema.org/Product`) da página do produto, um por vez, com pausa de 2–4 s.
3. **Intervalo adaptativo**: 429/403/falha → dobra o intervalo (até 60 min);
   ciclo lento (>10 s) → +50%; tudo ok → volta ao intervalo base. Há ±15% de variação aleatória.

## Manutenção: hashes do GraphQL

A API usa *persisted queries*. Quando a Eneba publica uma nova versão do site,
os hashes em [`src/eneba/queries.ts`](src/eneba/queries.ts) podem vencer. O monitor
detecta (`PersistedQueryNotFound`), avisa no log e passa a usar só o HTML por 6 h.

Para atualizar: abra uma página de produto com o DevTools → Network, filtre por
`graphql`, e copie `extensions.persistedQuery.sha256Hash` das operações
`GetProductPageAlgoliaRecommendations` e `ProductNoCache`.

## Limitações conhecidas

- `offers` mostra só a primeira página de vendedores (3 itens); o total vem no cabeçalho.
- Preços são do contexto configurado (padrão `BR`/`BRL`). Mudar região muda os preços.
- Uso pessoal e em baixo volume. Respeite os Termos de Uso da Eneba e não reduza
  o intervalo de forma agressiva.
