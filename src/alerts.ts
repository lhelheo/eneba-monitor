import { config } from "./config.ts";
import type { Product, Snapshot } from "./db.ts";
import { productUrl, type PriceResult } from "./eneba/client.ts";
import { log } from "./log.ts";

export const money = (value: number | null, currency: string) =>
  value == null
    ? "—"
    : new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(value);

/**
 * Regras de alerta, comparando a leitura atual com a anterior:
 *  - preço atingiu (ou ficou abaixo de) o alvo — só no momento em que cruza;
 *  - queda de X% ou mais desde a última leitura;
 *  - voltou ao estoque.
 */
export function evaluate(product: Product, prev: Snapshot | null, curr: PriceResult): string[] {
  const reasons: string[] = [];
  const price = curr.price;

  if (price != null && product.targetPrice != null && price <= product.targetPrice) {
    const wasAbove = prev?.price == null || prev.price > product.targetPrice;
    if (wasAbove) reasons.push(`atingiu o preço-alvo (${money(product.targetPrice, curr.currency)})`);
  }

  if (price != null && prev?.price != null && product.dropPercent != null && prev.price > 0) {
    const drop = ((prev.price - price) / prev.price) * 100;
    if (drop >= product.dropPercent) {
      reasons.push(`caiu ${drop.toFixed(1)}% (de ${money(prev.price, prev.currency)})`);
    }
  }

  if (prev && !prev.inStock && curr.inStock) reasons.push("voltou ao estoque");

  return reasons;
}

export function formatAlert(curr: PriceResult, reasons: string[]): string {
  return `🔔 ${curr.name}\n${money(curr.price, curr.currency)} — ${reasons.join("; ")}\n${productUrl(curr.slug)}`;
}

/**
 * Envia para console + Telegram/Discord (os configurados no .env).
 * Retorna quantos canais falharam (0 = todos enviaram ou nenhum canal configurado).
 */
export async function notify(message: string): Promise<number> {
  log.info("ALERTA\n" + message);
  const { telegramToken, telegramChatId, discordWebhook } = config.alerts;
  const jobs: Promise<unknown>[] = [];

  if (telegramToken && telegramChatId) {
    jobs.push(
      fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: telegramChatId, text: message, disable_web_page_preview: false }),
      }).then((r) => {
        if (!r.ok) throw new Error(`Telegram HTTP ${r.status}`);
      }),
    );
  }
  if (discordWebhook) {
    jobs.push(
      fetch(discordWebhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: message }),
      }).then((r) => {
        if (!r.ok) throw new Error(`Discord HTTP ${r.status}`);
      }),
    );
  }

  let failures = 0;
  for (const result of await Promise.allSettled(jobs)) {
    if (result.status === "rejected") {
      failures++;
      log.warn(`Falha ao enviar alerta: ${result.reason}`);
    }
  }
  return failures;
}
