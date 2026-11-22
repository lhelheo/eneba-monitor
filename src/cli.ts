import { parseArgs } from "node:util";
import { money } from "./alerts.ts";
import { history, insertSnapshot, lastSnapshot, listProducts, lowestEver, removeProduct, upsertProduct } from "./db.ts";
import { fetchOffers, productUrl, toSlug } from "./eneba/client.ts";
import { log } from "./log.ts";
import { checkOnce, fetchPrice, runLoop } from "./monitor.ts";

const HELP = `
Monitor de preços Eneba

  npm run cli -- add <url|slug> [--target 49.90] [--drop 10]
        Cadastra (ou atualiza) um produto. --target: alerta quando o preço
        chegar a esse valor. --drop: alerta quando cair X% numa leitura.
  npm run cli -- remove <slug>
  npm run cli -- list
  npm run cli -- history <slug> [--limit 20]
  npm run cli -- offers <url|slug>       Lista os vendedores e preços agora
  npm run cli -- once                    Uma verificação de todos os produtos
  npm start                              Loop contínuo (padrão: a cada 5 min)
`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    target: { type: "string" },
    drop: { type: "string" },
    limit: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const optionalNumber = (v: string | undefined, name: string): number | null => {
  if (v === undefined) return null;
  const n = Number(v.replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} precisa ser um número positivo`);
  return n;
};

const [command, arg] = positionals;

async function main(): Promise<void> {
  switch (values.help ? "help" : command) {
    case "add": {
      if (!arg) throw new Error("Informe a URL ou o slug do produto");
      const slug = toSlug(arg);
      const targetPrice = optionalNumber(values.target, "target");
      const dropPercent = optionalNumber(values.drop, "drop");
      const result = await fetchPrice(slug); // valida que o produto existe
      const isNew = !listProducts().some((p) => p.slug === slug);
      upsertProduct({ slug, name: result.name, targetPrice, dropPercent });
      if (isNew) insertSnapshot(result); // primeira leitura vira a base de comparação
      log.info(
        `${isNew ? "Cadastrado" : "Atualizado"}: ${result.name} — agora ${money(result.price, result.currency)}` +
          (targetPrice ? ` | alvo ${money(targetPrice, result.currency)}` : "") +
          (dropPercent ? ` | queda ≥ ${dropPercent}%` : ""),
      );
      if (targetPrice && result.price != null && result.price <= targetPrice) {
        log.info("O preço atual já está no alvo — o alerta dispara quando ele subir e voltar a cair até o alvo.");
      }
      break;
    }

    case "remove": {
      if (!arg) throw new Error("Informe o slug");
      log.info(removeProduct(toSlug(arg)) ? "Removido." : "Produto não encontrado.");
      break;
    }

    case "list": {
      const products = listProducts();
      if (!products.length) return log.info("Nenhum produto cadastrado.");
      console.table(
        products.map((p) => {
          const last = lastSnapshot(p.slug);
          const cur = last?.currency ?? "BRL";
          return {
            produto: (p.name ?? p.slug).slice(0, 50),
            atual: money(last?.price ?? null, cur),
            minimo: money(lowestEver(p.slug), cur),
            alvo: money(p.targetPrice, cur),
            "queda%": p.dropPercent ?? "—",
            "última leitura": last ? new Date(last.capturedAt).toLocaleString("pt-BR") : "—",
            slug: p.slug,
          };
        }),
      );
      break;
    }

    case "history": {
      if (!arg) throw new Error("Informe o slug");
      const rows = history(toSlug(arg), optionalNumber(values.limit, "limit") ?? 20);
      if (!rows.length) return log.info("Sem histórico para esse produto.");
      console.table(
        rows.map((s) => ({
          quando: new Date(s.capturedAt).toLocaleString("pt-BR"),
          preco: money(s.price, s.currency),
          estoque: s.inStock ? "sim" : "não",
          fonte: s.source,
        })),
      );
      break;
    }

    case "offers": {
      if (!arg) throw new Error("Informe a URL ou o slug");
      const slug = toSlug(arg);
      const { total, offers } = await fetchOffers(slug);
      log.info(`${total} oferta(s) em ${productUrl(slug)} (mostrando ${offers.length})`);
      console.table(
        offers.map((o) => ({ vendedor: o.seller, preco: money(o.price, o.currency), estoque: o.inStock ? "sim" : "não" })),
      );
      break;
    }

    case "once": {
      const s = await checkOnce();
      log.info(`${s.checked} ok, ${s.failed} falha(s) em ${(s.durationMs / 1000).toFixed(1)}s`);
      if (s.failed > 0) process.exitCode = 1;
      break;
    }

    case "run": {
      const controller = new AbortController();
      const stop = () => {
        log.info("Encerrando após o ciclo atual…");
        controller.abort();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      await runLoop(controller.signal);
      break;
    }

    default:
      console.log(HELP);
  }
}

main().catch((e: Error) => {
  log.error(e.message);
  process.exitCode = 1;
});
