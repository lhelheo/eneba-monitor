/**
 * Hashes das persisted queries (Apollo APQ) usadas pelo frontend da Eneba.
 *
 * ATENÇÃO: mudam quando a Eneba publica uma nova versão do site. Quando isso
 * acontecer a API responde "PersistedQueryNotFound" e o monitor cai
 * automaticamente para o HTML (JSON-LD). Para atualizar: abra uma página de
 * produto com o DevTools > Network, filtre por "graphql" e copie o
 * `extensions.persistedQuery.sha256Hash` de cada operação abaixo.
 *
 * Capturados em 2026-11-21 (x-version 20261119-120217).
 */
export const PERSISTED_QUERIES = {
  /** Recebe uma lista de slugs e devolve o cheapestAuction de cada produto. */
  multipleProducts: {
    operationName: "GetProductPageAlgoliaRecommendations",
    sha256Hash:
      "791c0e0d7c5f4ad60e768af57d0e0c7d5820c0f0d084ac8d2ba56bf3bac585d1_28b947f387a939b66a344f10d6e94c4adfc3d9ea81ca91135a1ed877d345aa051ee3aa6ed8a52074bbbd49958e05b1836b156e5621bea7132f2d6b2b3b3f8605",
  },
  /** Todas as ofertas (vendedores) de um produto, sem cache. */
  productOffers: {
    operationName: "ProductNoCache",
    sha256Hash:
      "f378e16cb82bf94bee272fbe1a2b20862954141aeeff22d8e10821ce1c7fd0c6_5b2d8163844b78c59d8e13de0b60a700845d062b1f544b00bc68308875e7e71a8a9a0a390996f979b671343368c6a5ea851aeb0747e8367f1c446e9ba567bd00",
  },
} as const;

export type PersistedQuery = (typeof PERSISTED_QUERIES)[keyof typeof PERSISTED_QUERIES];
