import { config } from "dotenv";

config({ path: ".env.local", quiet: true });
const url = process.env.MCP_URL || "http://127.0.0.1:3000/api/mcp";
const token = process.env.OPENSTOCK_MCP_TOKEN;
if (!token) throw new Error("OPENSTOCK_MCP_TOKEN is required");

async function rpc(method, params, id) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-06-18"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status} ${text.slice(0, 300)}`);
  if (/text\/event-stream/.test(response.headers.get("content-type") || "")) {
    const line = text.split("\n").find((line) => line.startsWith("data: "));
    if (!line) throw new Error(`No SSE event for ${method}`);
    return JSON.parse(line.slice(6));
  }
  return JSON.parse(text);
}

const unauthorized = await fetch(url, { method: "POST" });
if (unauthorized.status !== 401) throw new Error(`Expected 401; received ${unauthorized.status}`);
const initialized = await rpc("initialize", {
  protocolVersion: "2025-06-18", capabilities: {},
  clientInfo: { name: "openstocktw-mcp-smoke", version: "0.1.0" }
}, 1);
if (initialized.error) throw new Error(JSON.stringify(initialized.error));
console.log("initialize OK", initialized.result?.serverInfo?.name || "");

const list = await rpc("tools/list", {}, 2);
if (list.error) throw new Error(JSON.stringify(list.error));
const names = (list.result?.tools || []).map((tool) => tool.name);
const expected = [
  "stock_get_quote", "stock_get_candles", "portfolio_get_account",
  "portfolio_get_positions", "trading_get_orders",
  "trading_preview_order", "trading_place_order", "trading_cancel_order"
];
const missing = expected.filter((name) => !names.includes(name));
if (missing.length) throw new Error("Missing tools: " + missing.join(", "));
console.log("tools/list OK:", names.join(", "));

const quote = await rpc("tools/call", {
  name: "stock_get_quote", arguments: { symbol: "TWSE:2330" }
}, 3);
if (quote.error || quote.result?.isError) {
  throw new Error("stock_get_quote failed: " + JSON.stringify(quote));
}
console.log("tools/call stock_get_quote OK:", quote.result?.content?.[0]?.text?.slice(0, 250));
