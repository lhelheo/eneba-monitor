import { z } from "zod";

const Money = z.object({ amount: z.number(), currency: z.string() });

const GraphqlError = z.object({
  message: z.string(),
  extensions: z.object({ code: z.string().optional() }).loose().optional(),
});

export const GraphqlEnvelope = z.object({
  data: z.unknown().optional(),
  errors: z.array(GraphqlError).optional(),
});

export const MultipleProductsData = z.object({
  multipleProducts: z.array(
    z
      .object({
        slug: z.string(),
        name: z.string(),
        cheapestAuction: z
          .object({
            isInStock: z.boolean(),
            price: Money,
          })
          .loose()
          .nullable(),
      })
      .loose()
      .nullable(),
  ),
});

export const ProductOffersData = z.object({
  productNoCache: z
    .object({
      slug: z.string(),
      auctions: z.object({
        totalCount: z.number(),
        edges: z.array(
          z.object({
            node: z
              .object({
                id: z.string(),
                isInStock: z.boolean(),
                price: Money,
                merchant: z.object({ displayname: z.string() }).loose().nullable(),
              })
              .loose(),
          }),
        ),
      }),
    })
    .loose()
    .nullable(),
});

/** schema.org Product embutido em <script type="application/ld+json">. */
export const JsonLdProduct = z
  .object({
    "@type": z.literal("Product"),
    name: z.string(),
    offers: z
      .object({
        lowPrice: z.coerce.number().optional(),
        price: z.coerce.number().optional(),
        priceCurrency: z.string(),
        offerCount: z.coerce.number().optional(),
        availability: z.string().optional(),
      })
      .loose(),
  })
  .loose();
