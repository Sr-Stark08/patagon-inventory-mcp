import { describe, expect, it } from "vitest";
import { InventoryError, InventoryStore } from "../src/inventory.js";

const fixedNow = () => new Date("2026-09-28T12:00:00Z");

describe("InventoryStore", () => {
  it("registers an exit and updates stock", () => {
    const store = new InventoryStore(undefined, fixedNow);
    const r = store.registerMovement({ sku: "EPP-CASCO", type: "out", quantity: 10, idempotencyKey: "msg-0001" });
    expect(r.movement.stockBefore).toBe(38);
    expect(r.product.stock).toBe(28);
    expect(r.duplicate).toBe(false);
  });

  it("is idempotent: replaying the same key does not double-count", () => {
    const store = new InventoryStore();
    const input = { sku: "EPP-CASCO", type: "out" as const, quantity: 10, idempotencyKey: "msg-0002" };
    store.registerMovement(input);
    const replay = store.registerMovement(input);
    expect(replay.duplicate).toBe(true);
    expect(store.getProduct("EPP-CASCO").stock).toBe(28);
    expect(store.history("EPP-CASCO")).toHaveLength(1);
  });

  it("rejects reusing a key for a different movement", () => {
    const store = new InventoryStore();
    store.registerMovement({ sku: "EPP-CASCO", type: "out", quantity: 1, idempotencyKey: "msg-0003" });
    expect(() =>
      store.registerMovement({ sku: "EPP-CASCO", type: "out", quantity: 2, idempotencyKey: "msg-0003" }),
    ).toThrowError(expect.objectContaining({ code: "KEY_CONFLICT" }));
  });

  it("never lets stock go negative", () => {
    const store = new InventoryStore();
    expect(() =>
      store.registerMovement({ sku: "FLT-ACEITE", type: "out", quantity: 99, idempotencyKey: "msg-0004" }),
    ).toThrowError(InventoryError);
    expect(store.getProduct("FLT-ACEITE").stock).toBe(6);
  });

  it("rejects non-positive or fractional quantities", () => {
    const store = new InventoryStore();
    for (const quantity of [0, -3, 1.5]) {
      expect(() =>
        store.registerMovement({ sku: "EPP-LENTE", type: "in", quantity, idempotencyKey: `msg-q${quantity}` }),
      ).toThrowError(expect.objectContaining({ code: "INVALID_QUANTITY" }));
    }
  });

  it("reports unknown products instead of inventing them", () => {
    const store = new InventoryStore();
    expect(() => store.getProduct("NOPE")).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
  });

  it("flags when a movement crosses the minimum", () => {
    const store = new InventoryStore();
    const r = store.registerMovement({ sku: "EPP-LENTE", type: "out", quantity: 31, idempotencyKey: "msg-0005" });
    expect(r.crossedMinimum).toBe(true);
    expect(store.lowStock().map((p) => p.sku)).toContain("EPP-LENTE");
  });

  it("normalizes SKUs and searches by name", () => {
    const store = new InventoryStore();
    expect(store.getProduct(" epp-casco ").sku).toBe("EPP-CASCO");
    expect(store.search("gloves").map((p) => p.sku)).toEqual(["EPP-GUANTE"]);
  });
});
