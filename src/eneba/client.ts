import type { z } from "zod";
import { config } from "../config.ts";
import { HttpError, httpFetch, looksLikeChallenge } from "./http.ts";
import { PERSISTED_QUERIES, type PersistedQuery } from "./queries.ts";
import {
  GraphqlEnvelope,
  JsonLdProduct,
  MultipleProductsData,
  ProductOffersData,
} from "./schemas.ts";

export type PriceSource = "graphql" | "html";

export interface PriceResult {
  slug: string;
  name: string;
  /** Menor preço, em unidades da moeda (ex.: 12.99). null = sem oferta. */
  price: number | null;
  currency: string;
  inStock: boolean;
  offersCount: number | null;
  source: PriceSource;
}

export interface Offer {
  seller: string;
  price: number;
  currency: string;
  inStock: boolean;
}

/** Os hashes do frontend mudaram: é preciso atualizar src/eneba/queries.ts. */
export class PersistedQueryNotFoundError extends Error {
  constructor(operation: string) {
    super(`Persisted query "${operation}" não encontrada (hash desatualizado)`);
    this.name = "PersistedQueryNotFoundError";
  }
}

/** A resposta não bate com o formato esperado: o site provavelmente mudou. */
export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Aceita URL completa da Eneba ou slug puro e devolve o slug. */
export function toSlug(input: string): string {
  let candidate = input.trim();
  if (/^https?:\/\//i.test(candidate)) {
    const url = new URL(candidate);
    if (!/(^|\.)eneba\.com$/i.test(url.hostname)) throw new Error(`Não é uma URL da Eneba: ${input}`);
    candidate = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
  }
  if (!SLUG_RE.test(candidate)) throw new Error(`Slug inválido: "${candidate}"`);
  return candidate;
}

export const productUrl = (slug: string) => `${config.eneba.siteUrl}/${config.eneba.pathPrefix}/${slug}`;

const context = () => ({
  country: config.eneba.country,
  region: config.eneba.region,
  language: config.eneba.language,
});

async function graphql<T extends z.ZodType>(
  query: PersistedQuery,
  variables: Record<string, unknown>,
  schema: T,
): Promise<z.infer<T>> {
  const res = await httpFetch(config.eneba.graphqlUrl, {
    method: "POST",
    headers: {
      accept: "*/*",
      "content-type": "application/json",
      origin: config.eneba.siteUrl,
      referer: config.eneba.siteUrl + "/",
    },
    body: JSON.stringify({
      operationName: query.operationName,
      variables,
      extensions: { persistedQuery: { version: 1, sha256Hash: query.sha256Hash } },
    }),
  });
  const envelope = GraphqlEnvelope.parse(await res.json());
  if (envelope.errors?.length) {
    const notFound = envelope.errors.some(
      (e) => e.message === "PersistedQueryNotFound" || e.extensions?.code === "PERSISTED_QUERY_NOT_FOUND",
    );
    if (notFound) throw new PersistedQueryNotFoundError(query.operationName);
    if (envelope.data == null) throw new ParseError(`GraphQL: ${envelope.errors[0]?.message}`);
  }
  const parsed = schema.safeParse(envelope.data);
  if (!parsed.success) throw new ParseError(`Formato inesperado em ${query.operationName}: ${parsed.error.message}`);
  return parsed.data;
}

/**
 * Busca o menor preço de vários produtos numa única requisição.
 * Slugs que a Eneba não reconhecer ficam fora do resultado.
 */
export async function fetchPricesBatch(slugs: string[]): Promise<PriceResult[]> {
  if (slugs.length === 0) return [];
  const data = await graphql(
    PERSISTED_QUERIES.multipleProducts,
    { context: context(), currency: config.eneba.currency, productSlugs: slugs },
    MultipleProductsData,
  );
  return data.multipleProducts.flatMap((p) => {
    if (!p) return [];
    const auction = p.cheapestAuction;
    return [
      {
        slug: p.slug,
        name: p.name,
        price: auction ? auction.price.amount / 100 : null,
        currency: auction?.price.currency ?? config.eneba.currency,
        inStock: auction?.isInStock ?? false,
        offersCount: null,
        source: "graphql" as const,
      },
    ];
  });
}

/** Fallback sem hash: lê o JSON-LD (schema.org Product) do HTML da página. */
export async function fetchPriceFromHtml(slug: string): Promise<PriceResult> {
  let res: Response;
  try {
    res = await httpFetch(productUrl(slug), {
      headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
    });
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) throw new Error(`Produto não encontrado na Eneba: ${slug}`);
    throw e;
  }
  const html = await res.text();
  if (looksLikeChallenge(html)) throw new HttpError(403, "Desafio anti-bot (Cloudflare) na página de produto");

  for (const [, raw] of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    let json: unknown;
    try {
      json = JSON.parse(raw ?? "");
    } catch {
      continue;
    }
    const candidates = Array.isArray(json) ? json : [json];
    for (const c of candidates) {
      const product = JsonLdProduct.safeParse(c);
      if (!product.success) continue;
      const o = product.data.offers;
      const price = o.lowPrice ?? o.price ?? null;
      return {
        slug,
        name: product.data.name,
        price,
        currency: o.priceCurrency,
        inStock: price !== null && (o.availability ?? "").endsWith("InStock"),
        offersCount: o.offerCount ?? null,
        source: "html",
      };
    }
  }
  throw new ParseError(`JSON-LD de produto não encontrado em ${productUrl(slug)}`);
}

/** Lista as ofertas (vendedores) de um produto, da mais barata para a mais cara. */
export async function fetchOffers(slug: string): Promise<{ total: number; offers: Offer[] }> {
  const data = await graphql(
    PERSISTED_QUERIES.productOffers,
    {
      context: context(),
      packContext: context(),
      currency: config.eneba.currency,
      language: config.eneba.language,
      slug,
      isCheapestAuctionIncluded: true,
      isProductVariantSearch: false,
      loadCoinsValue: false,
      abTests: [],
      utmValues: {},
      version: 7,
    },
    ProductOffersData,
  );
  if (!data.productNoCache) throw new ParseError(`Produto não encontrado: ${slug}`);
  const { totalCount, edges } = data.productNoCache.auctions;
  return {
    total: totalCount,
    offers: edges.map(({ node }) => ({
      seller: node.merchant?.displayname ?? "?",
      price: node.price.amount / 100,
      currency: node.price.currency,
      inStock: node.isInStock,
    })),
  };
}
