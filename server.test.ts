import { describe, expect, it, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";

type TextBlock = { type: "text"; text: string };
const text = (r: { content: unknown }) => (r.content as TextBlock[])[0].text;

describe("MCP server (end to end over an in-memory transport)", () => {
  let client: Client;

  beforeEach(async () => {
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  it("exposes the expected tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["get_movement_history", "get_stock", "list_low_stock", "list_products", "register_movement"].sort(),
    );
  });

  it("registers a movement and is idempotent on retry", async () => {
    const args = { sku: "EPP-CASCO", type: "out", quantity: 10, idempotency_key: "whatsapp-msg-123" };
    const first = await client.callTool({ name: "register_movement", arguments: args });
    expect(text(first)).toContain("38 → 28");
    const retry = await client.callTool({ name: "register_movement", arguments: args });
    expect(text(retry)).toContain("idempotent replay");
    const stock = await client.callTool({ name: "get_stock", arguments: { sku: "EPP-CASCO" } });
    expect(text(stock)).toContain("28 units");
  });

  it("returns a tool error (not a crash) for unknown products", async () => {
    const r = await client.callTool({ name: "get_stock", arguments: { sku: "UNKNOWN" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("NOT_FOUND");
  });

  it("serves the product resource template", async () => {
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates[0].uriTemplate).toBe("inventory://products/{sku}");
    const res = await client.readResource({ uri: "inventory://products/EPP-GUANTE" });
    const body = JSON.parse((res.contents[0] as { text: string }).text);
    expect(body.product.stock).toBe(12);
  });

  it("provides the stock_report prompt", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain("stock_report");
    const p = await client.getPrompt({ name: "stock_report", arguments: { audience: "site supervisors" } });
    expect((p.messages[0].content as TextBlock).text).toContain("never estimate or invent stock");
  });
});
