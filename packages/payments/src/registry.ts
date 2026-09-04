import type { RegisteredShop } from "./types.js";

/** Load the shop registry from the gateway once per session; policy checks 402s against it. */
export async function loadShopRegistry(shopsUrl: string, fetchImpl: typeof fetch = fetch): Promise<Record<string, RegisteredShop>> {
  const r = await fetchImpl(`${shopsUrl}/shops`);
  if (r.status !== 200) throw new Error(`shop registry unavailable: ${r.status}`);
  const body = (await r.json()) as { shops: RegisteredShop[] };
  const out: Record<string, RegisteredShop> = {};
  for (const s of body.shops) {
    if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(s.payTo)) throw new Error(`registry has a malformed payTo for ${s.shop_id}`);
    out[s.shop_id] = s;
  }
  return out;
}
