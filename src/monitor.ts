import { setTimeout as delay } from "node:timers/promises";
import { evaluate, formatAlert, money, notify } from "./alerts.ts";
import { config } from "./config.ts";
import { insertSnapshot, lastSnapshot, listProducts, setName, type Product } from "./db.ts";
import {
  fetchPriceFromHtml,
  fetchPricesBatch,
  PersistedQueryNotFoundError,
  type PriceResult,
} from "./eneba/client.ts";
import { HttpError, randomBetween, sleep } from "./eneba/http.ts";
import { log } from "./log.ts";

export interface CycleStats {
  checked: number;
  failed: number;
  rateLimited: boolean;
  durationMs: number;
}

/** Quando os hashes GraphQL vencem, usamos só HTML e tentamos GraphQL de novo depois disso. */
const GRAPHQL_RETRY_AFTER_MS = 6 * 60 * 60_000;
let graphqlDisabledUntil = 0;

const chunk = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size));

const isRateLimit = (e: unknown) => e instanceof HttpError && e.rateLimited;

/** Busca o preço de um único produto (GraphQL, com fallback para HTML). */
export async function fetchPrice(slug: string): Promise<PriceResult> {
  if (Date.now() >= graphqlDisabledUntil) {
    try {
      const [result] = await fetchPricesBatch([slug]);
      if (result) return result;
    } catch (e) {
      if (e instanceof PersistedQueryNotFoundError) disableGraphql(e);
      else if (isRateLimit(e)) throw e;
    }
  }
  return fetchPriceFromHtml(slug);
}

function disableGraphql(e: Error) {
  graphqlDisabledUntil = Date.now() + GRAPHQL_RETRY_AFTER_MS;
  log.warn(`${e.message}. Usando só HTML pelas próximas 6h — atualize src/eneba/queries.ts.`);
}

/** Uma rodada completa: consulta todos os produtos ativos, grava e alerta. */
export async function checkOnce(): Promise<CycleStats> {
  const started = Date.now();
  const products = listProducts(true);
  const bySlug = new Map(products.map((p) => [p.slug, p]));
  const stats: CycleStats = { checked: 0, failed: 0, rateLimited: false, durationMs: 0 };
  if (products.length === 0) {
    log.info("Nenhum produto cadastrado. Use: npm run cli -- add <url-da-eneba>");
    return stats;
  }

  const results: PriceResult[] = [];
  const needHtml: string[] = [];

  // 1) GraphQL em lote (1 requisição para até BATCH_SIZE produtos)
  for (const slugs of chunk([...bySlug.keys()], config.batchSize)) {
    if (stats.rateLimited || Date.now() < graphqlDisabledUntil) {
      needHtml.push(...slugs);
      continue;
    }
    try {
      const batch = await fetchPricesBatch(slugs);
      results.push(...batch);
      const found = new Set(batch.map((r) => r.slug));
      needHtml.push(...slugs.filter((s) => !found.has(s)));
    } catch (e) {
      if (e instanceof PersistedQueryNotFoundError) disableGraphql(e);
      else if (isRateLimit(e)) stats.rateLimited = true;
      else log.warn(`GraphQL falhou (${(e as Error).message}); usando HTML para este lote`);
      needHtml.push(...slugs);
    }
  }

  // 2) Fallback HTML, um produto por vez, devagar. Não insiste se já tomou 429/403.
  for (const [i, slug] of needHtml.entries()) {
    if (stats.rateLimited) {
      stats.failed += needHtml.length - i;
      break;
    }
    if (i > 0) await sleep(randomBetween(...config.htmlFallbackDelayMs));
    try {
      results.push(await fetchPriceFromHtml(slug));
    } catch (e) {
      stats.failed++;
      if (isRateLimit(e)) stats.rateLimited = true;
      log.warn(`${slug}: ${(e as Error).message}`);
    }
  }

  // 3) Grava e avalia alertas
  for (const result of results) {
    const product = bySlug.get(result.slug);
    if (!product) continue;
    await record(product, result);
    stats.checked++;
  }

  stats.durationMs = Date.now() - started;
  if (stats.rateLimited) log.warn("Eneba respondeu com bloqueio/limite (429/403/503).");
  return stats;
}

async function record(product: Product, result: PriceResult): Promise<void> {
  const prev = lastSnapshot(product.slug);
  insertSnapshot(result);
  setName(product.slug, result.name);

  const delta =
    prev?.price != null && result.price != null && prev.price !== result.price
      ? ` (${result.price > prev.price ? "▲" : "▼"} ${money(prev.price, prev.currency)})`
      : "";
  const stock = result.inStock ? "" : " [sem estoque]";
  log.info(`${result.name}: ${money(result.price, result.currency)}${delta}${stock} via ${result.source}`);

  const reasons = evaluate(product, prev, result);
  if (reasons.length) await notify(formatAlert(result, reasons));
}

/**
 * Loop principal com intervalo adaptativo:
 *  - 429/403/falhas  → dobra o intervalo (até 60 min);
 *  - ciclo lento     → aumenta 50% (possível throttling);
 *  - tudo ok         → volta gradualmente ao intervalo base.
 */
export async function runLoop(signal: AbortSignal): Promise<void> {
  let interval = config.intervalMs;
  log.info(`Monitor iniciado. Intervalo base: ${config.intervalMs / 60_000} min. Ctrl+C para parar.`);

  while (!signal.aborted) {
    let stats: CycleStats;
    try {
      stats = await checkOnce();
    } catch (e) {
      log.error(`Ciclo falhou: ${(e as Error).stack ?? e}`);
      stats = { checked: 0, failed: 1, rateLimited: false, durationMs: 0 };
    }

    if (stats.rateLimited || stats.failed > 0) interval = Math.min(interval * 2, config.maxIntervalMs);
    else if (stats.durationMs > config.slowCycleMs) interval = Math.min(interval * 1.5, config.maxIntervalMs);
    else interval = Math.max(config.intervalMs, interval / 2);

    const wait = interval * (1 + randomBetween(-config.jitterRatio, config.jitterRatio));
    log.info(
      `Ciclo: ${stats.checked} ok, ${stats.failed} falha(s), ${(stats.durationMs / 1000).toFixed(1)}s. ` +
        `Próxima verificação em ${(wait / 60_000).toFixed(1)} min.`,
    );
    try {
      await delay(wait, undefined, { signal });
    } catch {
      break; // abortado (Ctrl+C)
    }
  }
  log.info("Monitor encerrado.");
}
