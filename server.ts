import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { InventoryError, InventoryStore, type Product } from "./inventory.js";

const json = (data: unknown) => JSON.stringify(data, null, 2);

function ok(summary: string, data: unknown) {
  return { content: [{ type: "text" as const, text: `${summary}\n\n${json(data)}` }] };
}

function fail(error: unknown) {
  const message = error instanceof InventoryError ? `${error.code}: ${error.message}` : `UNEXPECTED: ${String(error)}`;
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function status(p: Product): "ok" | "low" | "out" {
  if (p.stock === 0) return "out";
  return p.stock < p.minStock ? "low" : "ok";
}

export function createServer(store: InventoryStore = new InventoryStore()): McpServer {
  const server = new McpServer({ name: "patagon-inventory-mcp", version: "1.0.0" });

  // ---------------------------------------------------------------- tools

  server.registerTool(
    "list_products",
    {
      title: "List products",
      description: "List inventory products, optionally filtered by a text query that matches SKU or name.",
      inputSchema: { query: z.string().optional().describe("Text to search in SKU or product name") },
      annotations: { readOnlyHint: true },
    },
    async ({ query }) => {
      const products = query ? store.search(query) : store.listProducts();
      return ok(`${products.length} product(s) found.`, products.map((p) => ({ ...p, status: status(p) })));
    },
  );

  server.registerTool(
    "get_stock",
    {
      title: "Get stock",
      description:
        "Get the current stock of one product by SKU. Always use this before telling a user how much stock there is — never guess.",
      inputSchema: { sku: z.string().min(1).describe("Product SKU, e.g. EPP-CASCO") },
      annotations: { readOnlyHint: true },
    },
    async ({ sku }) => {
      try {
        const p = store.getProduct(sku);
        return ok(`${p.name}: ${p.stock} ${p.unit} (minimum ${p.minStock}, status ${status(p)}).`, { ...p, status: status(p) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "register_movement",
    {
      title: "Register stock movement",
      description:
        "Register a stock entry (in) or exit (out). Idempotent: send the same idempotency_key when retrying so the movement is never counted twice.",
      inputSchema: {
        sku: z.string().min(1).describe("Product SKU"),
        type: z.enum(["in", "out"]).describe("'in' adds stock, 'out' removes stock"),
        quantity: z.number().int().positive().describe("Whole number of units"),
        idempotency_key: z
          .string()
          .min(8)
          .describe("Unique key for this real-world movement, e.g. the chat message ID. Reuse it only for retries."),
        note: z.string().max(200).optional().describe("Optional context, e.g. 'north site crew'"),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ sku, type, quantity, idempotency_key, note }) => {
      try {
        const r = store.registerMovement({ sku, type, quantity, note, idempotencyKey: idempotency_key });
        const verb = type === "in" ? "Added" : "Removed";
        let summary = r.duplicate
          ? `Already registered earlier (idempotent replay) — stock unchanged at ${r.product.stock} ${r.product.unit}.`
          : `${verb} ${quantity} ${r.product.unit} of ${r.product.name}. Stock: ${r.movement.stockBefore} → ${r.movement.stockAfter}.`;
        if (r.crossedMinimum) summary += ` ⚠️ Now below minimum (${r.product.minStock}). Consider restocking.`;
        return ok(summary, r);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "list_low_stock",
    {
      title: "List low stock",
      description: "List products whose stock is below their configured minimum.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const low = store.lowStock();
      return ok(
        low.length ? `${low.length} product(s) below minimum.` : "All products are at or above minimum stock.",
        low.map((p) => ({ ...p, missing: p.minStock - p.stock })),
      );
    },
  );

  server.registerTool(
    "get_movement_history",
    {
      title: "Movement history",
      description: "Most recent stock movements, newest first. Optionally filter by SKU.",
      inputSchema: {
        sku: z.string().optional().describe("Filter by product SKU"),
        limit: z.number().int().min(1).max(100).optional().describe("Max movements to return (default 20)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sku, limit }) => {
      const history = store.history(sku, limit ?? 20);
      return ok(`${history.length} movement(s).`, history);
    },
  );

  // ------------------------------------------------------------ resources

  server.registerResource(
    "product-catalog",
    "inventory://products",
    { title: "Product catalog", description: "Full inventory snapshot", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: json(store.listProducts()) }] }),
  );

  server.registerResource(
    "product",
    new ResourceTemplate("inventory://products/{sku}", {
      list: async () => ({
        resources: store.listProducts().map((p) => ({ uri: `inventory://products/${p.sku}`, name: `${p.sku} — ${p.name}` })),
      }),
      complete: {
        sku: (value) => store.listProducts().map((p) => p.sku).filter((s) => s.startsWith(value.toUpperCase())),
      },
    }),
    { title: "Product detail", description: "One product with its recent movements", mimeType: "application/json" },
    async (uri, { sku }) => {
      const code = Array.isArray(sku) ? sku[0] : sku;
      const product = store.getProduct(code);
      return {
        contents: [
          { uri: uri.href, mimeType: "application/json", text: json({ product, recentMovements: store.history(code, 10) }) },
        ],
      };
    },
  );

  // -------------------------------------------------------------- prompts

  server.registerPrompt(
    "stock_report",
    {
      title: "Stock report",
      description: "Generate a short inventory status report for a team chat.",
      argsSchema: { audience: z.string().optional().describe("Who will read it, e.g. 'site supervisors'") },
    },
    ({ audience }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Write a short inventory status report${audience ? ` for ${audience}` : ""}.`,
              "1. Call list_low_stock and list_products to get real numbers.",
              "2. Start with items below minimum and how many units are missing.",
              "3. Then one line with the overall status.",
              "Rules: use only numbers returned by the tools — never estimate or invent stock. Keep it under 120 words.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  return server;
}
