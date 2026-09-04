import { BrowseQuerySchema, ProductSchema, lte, toCents, type BrowseQuery, type BrowseResult, type Product } from "@buffet/shared";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Seed row: the public Product plus shop-internal fields that never leave the shop. */
const SeedProductSchema = ProductSchema.omit({ shop_rating: true }).extend({
  tags: z.array(z.string()).default([]),
  planted: z.boolean().default(false),
});
const SeedShopSchema = z.object({ shop_id: z.string(), name: z.string(), shop_rating: z.number().min(0).max(5) });
const SeedSchema = z.object({ shops: z.array(SeedShopSchema), products: z.array(SeedProductSchema) });

export type Shop = z.infer<typeof SeedShopSchema>;
type Row = Product & { tags: string[]; planted: boolean };

export class Catalog {
  readonly shops: Shop[];
  private readonly rows: Row[];
  private readonly stock = new Map<string, number>();
  /** invoice_ref -> held unit, released after `expires` if never committed */
  private readonly holds = new Map<string, { productId: string; expires: number }>();

  constructor(seed: unknown) {
    const parsed = SeedSchema.parse(seed);
    this.shops = parsed.shops;
    const ratingByShop = new Map(parsed.shops.map((s) => [s.shop_id, s.shop_rating]));
    this.rows = parsed.products.map((p) => {
      const shop_rating = ratingByShop.get(p.shop_id);
      if (shop_rating === undefined) throw new Error(`product ${p.id} references unknown shop ${p.shop_id}`);
      return { ...p, shop_rating };
    });
    for (const r of this.rows) this.stock.set(r.id, r.stock);
  }

  static fromFile(file = defaultSeedPath()): Catalog {
    return new Catalog(JSON.parse(fs.readFileSync(file, "utf8")));
  }

  get(id: string): Product | undefined {
    const r = this.rows.find((x) => x.id === id);
    return r ? this.publicView(r) : undefined;
  }

  all(): Product[] {
    return this.rows.map((r) => this.publicView(r));
  }

  /** Stock left net of live holds, tracked in memory; the seed value is the starting point. */
  stockOf(id: string): number {
    this.sweepHolds();
    let held = 0;
    for (const h of this.holds.values()) if (h.productId === id) held += 1;
    return Math.max(0, (this.stock.get(id) ?? 0) - held);
  }

  /**
   * Hold one unit for a quote (keyed by invoice_ref) until it is committed or expires.
   * Re-holding the same ref is a no-op success, so a re-issued 402 does not double-hold.
   */
  hold(id: string, ref: string, ttlMs: number): boolean {
    this.sweepHolds();
    const existing = this.holds.get(ref);
    if (existing && existing.productId === id) {
      existing.expires = Date.now() + ttlMs;
      return true;
    }
    if (this.stockOf(id) <= 0) return false;
    this.holds.set(ref, { productId: id, expires: Date.now() + ttlMs });
    return true;
  }

  /** Turn a hold into a sale. Returns false if there was no live hold for this ref. */
  commitHold(ref: string): boolean {
    this.sweepHolds();
    const h = this.holds.get(ref);
    if (!h) return false;
    this.holds.delete(ref);
    this.stock.set(h.productId, Math.max(0, (this.stock.get(h.productId) ?? 0) - 1));
    return true;
  }

  releaseHold(ref: string): void {
    this.holds.delete(ref);
  }

  private sweepHolds(): void {
    const now = Date.now();
    for (const [ref, h] of this.holds) if (h.expires <= now) this.holds.delete(ref);
  }

  /** Returns false if out of stock. */
  reserve(id: string): boolean {
    const n = this.stock.get(id) ?? 0;
    if (n <= 0) return false;
    this.stock.set(id, n - 1);
    return true;
  }

  /**
   * Browse per CLAUDE.md §15.2: token match on name/tags/description, price range
   * inclusive, sorted by quantity sold. `nearest` carries up to 3 items just outside
   * the range only when nothing is inside it (EC1), so the agent needs no second call.
   */
  browse(input: BrowseQuery): BrowseResult {
    const q = BrowseQuerySchema.parse(input);
    const terms = tokenize(q.q).filter((t) => !STOPWORDS.has(t));
    // Score by how many query terms hit the name or tags (whole tokens), keep the best group.
    const scored = this.rows.map((r) => ({ r, score: matchScore(r, terms) })).filter((x) => x.score > 0);
    const best = Math.max(0, ...scored.map((x) => x.score));
    // Best band first; if it is thin (under 5), let the next band in so "gaming laptop"
    // still shows other laptops after the one gaming laptop.
    let matches = scored.filter((x) => x.score === best).map((x) => x.r);
    if (matches.length < 5 && best > 1) {
      matches = scored.filter((x) => x.score >= best - 1).map((x) => x.r);
    }
    const min = toCents(q.min_price);
    const max = toCents(q.max_price);
    const inRange = matches
      .filter((r) => toCents(r.price) >= min && lte(r.price, q.max_price))
      .sort((a, b) => b.quantity_sold - a.quantity_sold);
    if (inRange.length > 0) return { products: inRange.map((r) => this.publicView(r)), nearest: [] };
    const distance = (r: Row): bigint => {
      const c = toCents(r.price);
      return c < min ? min - c : c - max;
    };
    const nearest = matches
      .slice()
      .sort((a, b) => Number(distance(a) - distance(b)))
      .slice(0, 3);
    return { products: [], nearest: nearest.map((r) => this.publicView(r)) };
  }

  private publicView(r: Row): Product {
    const { tags: _t, planted: _p, ...pub } = r;
    return { ...pub, stock: this.stockOf(r.id) };
  }
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9+"-]+/)
    .map((t) => t.replace(/^-+|-+$/g, ""))
    .filter((t) => t.length >= 2);
}

const STOPWORDS = new Set(["a", "an", "the", "for", "with", "and", "or", "of", "to", "in", "on", "my", "me", "new", "good", "best", "cheap"]);

/** Number of query terms that hit a tag or a whole word of the name. Description never counts. */
function matchScore(r: Row, terms: string[]): number {
  if (terms.length === 0) return 0;
  const nameTokens = new Set(tokenize(r.product_name));
  const tagTokens = new Set(r.tags.map((t) => t.toLowerCase()));
  let score = 0;
  for (const t of terms) if (tagTokens.has(t) || nameTokens.has(t)) score += 1;
  return score;
}

export function defaultSeedPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // packages/shops/src or packages/shops/dist -> data/catalog.json
  return path.resolve(here, "../../../data/catalog.json");
}
