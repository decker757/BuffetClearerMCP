import { z } from "zod";
import { isMoney, normalize, toCents } from "../money.js";

/**
 * A fresh money schema. Two fields of one tool's input schema must not share an
 * instance: the JSON Schema generator emits the second as `{"$ref": "..."}`, and
 * a tool schema published to a model is not a place for internal pointers
 * (REVIEW-LOG phase 7). Use `money()` in tool inputs; `MoneySchema` elsewhere.
 */
export const money = () =>
  z
    .string()
    .refine(isMoney, { message: "money must be a decimal string with <= 2 fractional digits" })
    .transform(normalize);

/** Accepts "12", "12.5", " 12.50 "; always outputs the canonical "12.50". */
export const MoneySchema = money();

/** Product object per CLAUDE.md §15.2. `description` is seller text: untrusted. */
export const ProductSchema = z.object({
  id: z.string().min(1),
  shop_id: z.string().min(1),
  product_name: z.string().min(1).max(200),
  description: z.string().max(2000),
  price: MoneySchema,
  currency: z.literal("RLUSD"),
  product_rating: z.number().min(0).max(5),
  shop_rating: z.number().min(0).max(5),
  quantity_sold: z.number().int().min(0),
  stock: z.number().int().min(0),
});
export type Product = z.infer<typeof ProductSchema>;

export const BrowseQuerySchema = z
  .object({
    q: z.string().min(1).max(200),
    min_price: MoneySchema,
    max_price: MoneySchema,
  })
  .refine((q) => toCents(q.min_price) <= toCents(q.max_price), {
    message: "min_price must be <= max_price",
    path: ["min_price"],
  });
export type BrowseQuery = z.infer<typeof BrowseQuerySchema>;

export const BrowseResultSchema = z.object({
  products: z.array(ProductSchema),
  /** Up to 3 items just outside the range, only when `products` is empty (EC1). */
  nearest: z.array(ProductSchema).max(3),
});
export type BrowseResult = z.infer<typeof BrowseResultSchema>;
