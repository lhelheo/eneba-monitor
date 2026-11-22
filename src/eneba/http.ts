import { config } from "../config.ts";

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
  get rateLimited(): boolean {
    return this.status === 429 || this.status === 403 || this.status === 503;
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const randomBetween = (min: number, max: number) => min + Math.random() * (max - min);

const baseHeaders = {
  "user-agent": config.userAgent,
  "accept-language": config.eneba.language.replace("_", "-") + ",pt;q=0.9,en;q=0.8",
};

/**
 * fetch com timeout, headers de navegador e 1 nova tentativa para falhas de rede/5xx.
 * 429/403 NÃO são repetidos aqui: quem decide recuar é o loop do monitor.
 */
export async function httpFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = { ...baseHeaders, ...(init.headers as Record<string, string> | undefined) };
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers,
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
      if (res.ok) return res;
      const err = new HttpError(res.status, `HTTP ${res.status} em ${url}`);
      if (res.status >= 500 && res.status !== 503 && attempt < 2) {
        await sleep(2_000);
        continue;
      }
      throw err;
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (attempt < 2) {
        await sleep(2_000);
        continue;
      }
      throw e;
    }
  }
}

/** Detecta página de desafio do Cloudflare que às vezes vem com status 200. */
export function looksLikeChallenge(html: string): boolean {
  return /<title>\s*(just a moment|attention required)/i.test(html) || html.includes("cf-turnstile");
}
