import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";
import type { PriceResult, PriceSource } from "./eneba/client.ts";

export interface Product {
  slug: string;
  name: string | null;
  targetPrice: number | null;
  dropPercent: number | null;
  active: boolean;
  createdAt: string;
}

export interface Snapshot {
  slug: string;
  capturedAt: string;
  price: number | null;
  currency: string;
  inStock: boolean;
  offersCount: number | null;
  source: PriceSource;
}

mkdirSync(dirname(config.dbPath), { recursive: true });
const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS products (
    slug          TEXT PRIMARY KEY,
    name          TEXT,
    target_price  REAL,
    drop_percent  REAL,
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE IF NOT EXISTS snapshots (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    slug          TEXT NOT NULL REFERENCES products(slug) ON DELETE CASCADE,
    captured_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    price         REAL,
    currency      TEXT NOT NULL,
    in_stock      INTEGER NOT NULL,
    offers_count  INTEGER,
    source        TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_snapshots_slug_time ON snapshots(slug, captured_at DESC);
`);

type Row = Record<string, string | number | null>;

const toProduct = (r: Row): Product => ({
  slug: String(r.slug),
  name: r.name == null ? null : String(r.name),
  targetPrice: r.target_price == null ? null : Number(r.target_price),
  dropPercent: r.drop_percent == null ? null : Number(r.drop_percent),
  active: Number(r.active) === 1,
  createdAt: String(r.created_at),
});

const toSnapshot = (r: Row): Snapshot => ({
  slug: String(r.slug),
  capturedAt: String(r.captured_at),
  price: r.price == null ? null : Number(r.price),
  currency: String(r.currency),
  inStock: Number(r.in_stock) === 1,
  offersCount: r.offers_count == null ? null : Number(r.offers_count),
  source: String(r.source) as PriceSource,
});

export function upsertProduct(p: {
  slug: string;
  name: string | null;
  targetPrice: number | null;
  dropPercent: number | null;
}): void {
  db.prepare(
    `INSERT INTO products (slug, name, target_price, drop_percent, active)
     VALUES (?, ?, ?, ?, 1)
     ON CONFLICT(slug) DO UPDATE SET
       name = COALESCE(excluded.name, products.name),
       target_price = excluded.target_price,
       drop_percent = excluded.drop_percent,
       active = 1`,
  ).run(p.slug, p.name, p.targetPrice, p.dropPercent);
}

export function removeProduct(slug: string): boolean {
  db.prepare("DELETE FROM snapshots WHERE slug = ?").run(slug);
  return Number(db.prepare("DELETE FROM products WHERE slug = ?").run(slug).changes) > 0;
}

export function setName(slug: string, name: string): void {
  db.prepare("UPDATE products SET name = ? WHERE slug = ? AND (name IS NULL OR name <> ?)").run(name, slug, name);
}

export function listProducts(onlyActive = false): Product[] {
  const sql = `SELECT * FROM products ${onlyActive ? "WHERE active = 1" : ""} ORDER BY created_at`;
  return (db.prepare(sql).all() as Row[]).map(toProduct);
}

export function insertSnapshot(r: PriceResult): void {
  db.prepare(
    `INSERT INTO snapshots (slug, price, currency, in_stock, offers_count, source)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(r.slug, r.price, r.currency, r.inStock ? 1 : 0, r.offersCount, r.source);
}

export function lastSnapshot(slug: string): Snapshot | null {
  const row = db
    .prepare("SELECT * FROM snapshots WHERE slug = ? ORDER BY captured_at DESC, id DESC LIMIT 1")
    .get(slug) as Row | undefined;
  return row ? toSnapshot(row) : null;
}

export function history(slug: string, limit = 50): Snapshot[] {
  return (
    db
      .prepare("SELECT * FROM snapshots WHERE slug = ? ORDER BY captured_at DESC, id DESC LIMIT ?")
      .all(slug, limit) as Row[]
  ).map(toSnapshot);
}

export function lowestEver(slug: string): number | null {
  const row = db.prepare("SELECT MIN(price) AS p FROM snapshots WHERE slug = ? AND price IS NOT NULL").get(slug) as
    | Row
    | undefined;
  return row?.p == null ? null : Number(row.p);
}
