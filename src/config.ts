function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const env = process.env;

export const config = {
  intervalMs: num(env.INTERVAL_MINUTES, 5) * 60_000,
  /** Teto do intervalo quando o monitor recua por erros/429. */
  maxIntervalMs: 60 * 60_000,
  /** Variação aleatória aplicada ao intervalo (±15%) para não bater sempre no mesmo segundo. */
  jitterRatio: 0.15,
  /** Acima disso (ms por ciclo) o monitor considera sinal de throttling e desacelera. */
  slowCycleMs: 10_000,
  batchSize: Math.min(num(env.BATCH_SIZE, 10), 25),
  dbPath: env.DB_PATH ?? "data/monitor.db",
  requestTimeoutMs: 20_000,
  /** Pausa entre requisições de HTML no modo fallback (uma por produto). */
  htmlFallbackDelayMs: [2_000, 4_000] as const,

  eneba: {
    country: env.ENEBA_COUNTRY ?? "BR",
    region: env.ENEBA_REGION ?? "brazil",
    language: env.ENEBA_LANGUAGE ?? "pt_BR",
    currency: env.ENEBA_CURRENCY ?? "BRL",
    graphqlUrl: "https://graphql.eneba.com/graphql/",
    siteUrl: "https://www.eneba.com",
    /** Prefixo de idioma usado nas URLs de produto (ex.: /br/<slug>). */
    pathPrefix: (env.ENEBA_COUNTRY ?? "BR").toLowerCase(),
  },

  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",

  alerts: {
    telegramToken: env.TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: env.TELEGRAM_CHAT_ID || undefined,
    discordWebhook: env.DISCORD_WEBHOOK_URL || undefined,
  },
};
