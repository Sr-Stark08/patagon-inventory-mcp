/**
 * Inventory domain logic — deliberately independent from MCP.
 *
 * Design principles (learned running AI agents in production):
 *  1. The LLM never invents numbers: every stock figure comes from this store.
 *  2. Stock movements are idempotent: retrying the same request never double-counts.
 *  3. Invalid operations fail loudly with a clear message instead of silently succeeding.
 */

export type MovementType = "in" | "out";

export interface Product {
  sku: string;
  name: string;
  unit: string;
  stock: number;
  minStock: number;
}

export interface Movement {
  id: string;
  sku: string;
  type: MovementType;
  quantity: number;
  note?: string;
  idempotencyKey: string;
  stockBefore: number;
  stockAfter: number;
  createdAt: string;
}

export interface MovementResult {
  movement: Movement;
  product: Product;
  /** true when the idempotency key was already used and nothing changed */
  duplicate: boolean;
  /** true when this movement took the product below its minimum stock */
  crossedMinimum: boolean;
}

export class InventoryError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "INVALID_QUANTITY" | "INSUFFICIENT_STOCK" | "KEY_CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "InventoryError";
  }
}

export const SAMPLE_PRODUCTS: Product[] = [
  { sku: "EPP-CASCO", name: "Safety helmet", unit: "units", stock: 38, minStock: 15 },
  { sku: "EPP-GUANTE", name: "Work gloves", unit: "pairs", stock: 12, minStock: 15 },
  { sku: "EPP-LENTE", name: "Safety glasses", unit: "units", stock: 40, minStock: 10 },
  { sku: "FLT-ACEITE", name: "Oil filter", unit: "units", stock: 6, minStock: 4 },
  { sku: "MAT-CEMENTO", name: "Cement bag 25kg", unit: "bags", stock: 120, minStock: 50 },
];

export class InventoryStore {
  private products = new Map<string, Product>();
  private movements: Movement[] = [];
  private byIdempotencyKey = new Map<string, Movement>();
  private seq = 0;

  constructor(seed: Product[] = SAMPLE_PRODUCTS, private readonly now: () => Date = () => new Date()) {
    for (const p of seed) this.products.set(p.sku, { ...p });
  }

  listProducts(): Product[] {
    return [...this.products.values()].map((p) => ({ ...p }));
  }

  getProduct(sku: string): Product {
    const p = this.products.get(normalizeSku(sku));
    if (!p) throw new InventoryError("NOT_FOUND", `Product "${sku}" does not exist. Use list_products to see valid SKUs.`);
    return { ...p };
  }

  /** Case-insensitive search by SKU or name. */
  search(query: string): Product[] {
    const q = query.trim().toLowerCase();
    return this.listProducts().filter((p) => p.sku.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
  }

  lowStock(): Product[] {
    return this.listProducts().filter((p) => p.stock < p.minStock);
  }

  history(sku?: string, limit = 20): Movement[] {
    const filtered = sku ? this.movements.filter((m) => m.sku === normalizeSku(sku)) : this.movements;
    return filtered.slice(-limit).reverse().map((m) => ({ ...m }));
  }

  /**
   * Registers a stock movement exactly once per idempotency key.
   * Replaying the same key with the same payload returns the original result without changing stock.
   * Reusing a key with a different payload is rejected.
   */
  registerMovement(input: {
    sku: string;
    type: MovementType;
    quantity: number;
    idempotencyKey: string;
    note?: string;
  }): MovementResult {
    const sku = normalizeSku(input.sku);
    const existing = this.byIdempotencyKey.get(input.idempotencyKey);
    if (existing) {
      if (existing.sku !== sku || existing.type !== input.type || existing.quantity !== input.quantity) {
        throw new InventoryError(
          "KEY_CONFLICT",
          `Idempotency key "${input.idempotencyKey}" was already used for a different movement.`,
        );
      }
      return { movement: { ...existing }, product: this.getProduct(sku), duplicate: true, crossedMinimum: false };
    }

    if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
      throw new InventoryError("INVALID_QUANTITY", "Quantity must be a positive whole number.");
    }

    const product = this.products.get(sku);
    if (!product) throw new InventoryError("NOT_FOUND", `Product "${input.sku}" does not exist. Use list_products to see valid SKUs.`);

    const delta = input.type === "in" ? input.quantity : -input.quantity;
    const stockBefore = product.stock;
    const stockAfter = stockBefore + delta;
    if (stockAfter < 0) {
      throw new InventoryError(
        "INSUFFICIENT_STOCK",
        `Cannot remove ${input.quantity} ${product.unit} of ${product.name}: only ${stockBefore} available.`,
      );
    }

    product.stock = stockAfter;
    const movement: Movement = {
      id: `mov_${++this.seq}`,
      sku,
      type: input.type,
      quantity: input.quantity,
      note: input.note,
      idempotencyKey: input.idempotencyKey,
      stockBefore,
      stockAfter,
      createdAt: this.now().toISOString(),
    };
    this.movements.push(movement);
    this.byIdempotencyKey.set(input.idempotencyKey, movement);

    return {
      movement: { ...movement },
      product: { ...product },
      duplicate: false,
      crossedMinimum: stockBefore >= product.minStock && stockAfter < product.minStock,
    };
  }
}

export function normalizeSku(sku: string): string {
  return sku.trim().toUpperCase();
}
