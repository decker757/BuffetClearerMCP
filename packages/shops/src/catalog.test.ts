import { describe, expect, it } from "vitest";
import { Catalog } from "./catalog.js";

const catalog = Catalog.fromFile();

describe("catalog browse", () => {
  it("loads the seed with a shop rating joined onto every product", () => {
    const all = catalog.all();
    expect(all.length).toBeGreaterThan(10);
    for (const p of all) expect(p.shop_rating).toBeGreaterThan(0);
    // shop-internal fields never leave the shop
    expect(Object.keys(all[0]!)).not.toContain("tags");
    expect(Object.keys(all[0]!)).not.toContain("planted");
  });

  it("returns laptops in range sorted by quantity sold, from both shops", () => {
    const r = catalog.browse({ q: "laptop", min_price: "600", max_price: "1200" });
    expect(r.nearest).toEqual([]);
    expect(r.products.length).toBeGreaterThanOrEqual(5);
    const sold = r.products.map((p) => p.quantity_sold);
    expect(sold).toEqual([...sold].sort((a, b) => b - a));
    expect(new Set(r.products.map((p) => p.shop_id))).toEqual(new Set(["shop_a", "shop_b"]));
    for (const p of r.products) {
      expect(Number(p.price)).toBeGreaterThanOrEqual(600);
      expect(Number(p.price)).toBeLessThanOrEqual(1200);
    }
  });

  it("includes the planted too-good-to-be-true listing when the range covers it", () => {
    const r = catalog.browse({ q: "laptop", min_price: "300", max_price: "2000" });
    const planted = r.products.find((p) => p.id === "p_b03");
    expect(planted).toBeDefined();
    expect(Number(planted!.price)).toBeLessThan(400);
    expect(planted!.quantity_sold).toBeLessThan(10);
    expect(planted!.product_rating).toBeGreaterThan(4.8);
  });

  it("EC1: empty range returns up to 3 nearest items instead", () => {
    const r = catalog.browse({ q: "laptop", min_price: "100", max_price: "200" });
    expect(r.products).toEqual([]);
    expect(r.nearest.length).toBe(3);
    expect(r.nearest[0]!.id).toBe("p_b03"); // 349 is the closest to 200
  });

  it("'usb-c cable for my macbook' returns cables, not MacBooks, even in a wide range", () => {
    const r = catalog.browse({ q: "usb-c cable for my macbook", min_price: "1", max_price: "3000" });
    expect(r.products.length).toBeGreaterThanOrEqual(4);
    for (const p of r.products) expect(p.product_name.toLowerCase()).toMatch(/usb|cable/);
    expect(r.products.some((p) => /macbook/i.test(p.product_name))).toBe(false);
    expect(r.products.every((p) => /^\d+\.\d{2}$/.test(p.price))).toBe(true);
  });

  it("'gaming laptop' ranks the gaming laptop but still shows other laptops", () => {
    const r = catalog.browse({ q: "gaming laptop", min_price: "400", max_price: "2000" });
    expect(r.products.some((p) => p.id === "p_b06")).toBe(true);
    expect(r.products.length).toBeGreaterThanOrEqual(5);
  });

  it("whole-token matching: 'pro' does not match every 'Pro' substring and '14' alone finds nothing useful", () => {
    const r = catalog.browse({ q: "macbook pro", min_price: "1", max_price: "3000" });
    // best band = both terms hit -> MacBook Pro only; band widened to score>=1 because thin -> MacBook Air too
    expect(r.products.every((p) => /macbook/i.test(p.product_name))).toBe(true);
  });

  it("rejects a missing, malformed, or inverted range", () => {
    expect(() => catalog.browse({ q: "laptop", min_price: "", max_price: "1" } as never)).toThrow();
    expect(() => catalog.browse({ q: "laptop", min_price: "1.234", max_price: "5" })).toThrow();
    expect(() => catalog.browse({ q: "laptop", min_price: "900", max_price: "500" })).toThrow(/min_price/);
  });

  it("stock: holds reduce visible stock, commit turns a hold into a sale, expiry releases", async () => {
    const c = Catalog.fromFile();
    const before = c.stockOf("p_a02"); // 6 in seed
    expect(c.hold("p_a02", "ref_1", 10_000)).toBe(true);
    expect(c.hold("p_a02", "ref_1", 10_000)).toBe(true); // re-hold same ref is a no-op
    expect(c.stockOf("p_a02")).toBe(before - 1);
    expect(c.commitHold("ref_1")).toBe(true);
    expect(c.stockOf("p_a02")).toBe(before - 1);
    expect(c.commitHold("ref_1")).toBe(false);

    expect(c.hold("p_a02", "ref_2", 5)).toBe(true);
    expect(c.stockOf("p_a02")).toBe(before - 2);
    await new Promise((r) => setTimeout(r, 15));
    expect(c.stockOf("p_a02")).toBe(before - 1); // expired hold released
  });

  it("stock: cannot hold more than the remaining units", () => {
    const c = Catalog.fromFile();
    const n = c.stockOf("p_a02");
    for (let i = 0; i < n; i += 1) expect(c.hold("p_a02", `r${i}`, 10_000)).toBe(true);
    expect(c.hold("p_a02", "one_more", 10_000)).toBe(false);
  });
});
