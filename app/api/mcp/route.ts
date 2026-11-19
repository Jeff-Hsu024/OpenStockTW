import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { parseTwSymbol } from "@/lib/tw/symbols";
import { getQuote } from "@/lib/actions/tw.actions";
import { getBroker } from "@/lib/trading/broker";
import { connectToDatabase } from "@/database/mongoose";
import { DailyBar } from "@/database/models/daily-bar.model";
import { isAuthorizedMcpRequest, isMcpConfigured, mcpUserId } from "@/lib/mcp/auth";
import { mcpError, mcpJson } from "@/lib/mcp/format";
import { previewPaperOrder } from "@/lib/mcp/trading-preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const symbolSchema = z.string().min(1).max(20).describe("TWSE:2330 or TPEX:5483");
const sideSchema = z.enum(["buy", "sell"]);
const orderTypeSchema = z.enum(["market", "limit"]);
const validSymbol = (symbol: string) => {
  const parsed = parseTwSymbol(symbol.trim().toUpperCase());
  if (!parsed || parsed.code === "t00") throw new Error("Invalid TWSE/TPEX stock symbol");
  return parsed.tvSymbol;
};
const wrap = async (fn: () => Promise<unknown>) => {
  try { return mcpJson(await fn()); } catch (e) { return mcpError(e); }
};

const handler = createMcpHandler((server) => {
  server.registerTool("stock_get_quote", {
    title: "Taiwan stock quote",
    description: "Get a TWSE/TPEx indicative quote. Values may be delayed (~20 minutes).",
    inputSchema: z.object({ symbol: symbolSchema })
  }, ({ symbol }) => wrap(async () => {
    const stock = validSymbol(symbol);
    return { symbol: stock, quote: await getQuote(stock), indicativeOnly: true };
  }));

  server.registerTool("stock_get_candles", {
    title: "Taiwan daily candles",
    description: "Read locally cached historical OHLCV bars. An empty result means backfill is required.",
    inputSchema: z.object({ symbol: symbolSchema, range: z.enum(["3m", "6m", "1y"]).default("3m") })
  }, ({ symbol, range }) => wrap(async () => {
    const stock = validSymbol(symbol);
    await connectToDatabase();
    const limit = ({ "3m": 63, "6m": 126, "1y": 252 } as const)[range];
    const docs = await DailyBar.find({ symbol: stock }).sort({ date: -1 }).limit(limit).lean();
    return {
      symbol: stock, range, source: "local-db", staleDataPossible: true,
      candles: docs.reverse().map((bar) => ({
        time: bar.date, open: bar.open, high: bar.high, low: bar.low,
        close: bar.close, volume: bar.volume
      })),
      note: docs.length === 0 ? "No cached bars; run scripts/backfill-tw-history.mjs or scripts/backfill-tpex-yahoo.mjs" : undefined
    };
  }));

  server.registerTool("portfolio_get_account", {
    title: "Paper account",
    description: "Read the bound service account's virtual cash and PnL.",
    inputSchema: z.object({})
  }, () => wrap(() => getBroker().getAccount(mcpUserId())));

  server.registerTool("portfolio_get_positions", {
    title: "Paper positions",
    description: "Read the bound service account's paper holdings.",
    inputSchema: z.object({})
  }, () => wrap(() => getBroker().getPositions(mcpUserId())));

  server.registerTool("trading_get_orders", {
    title: "Paper orders",
    description: "Read recent simulated orders for the bound service account.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(200).default(50) })
  }, ({ limit }) => wrap(() => getBroker().getOrders(mcpUserId(), limit)));

  const tradeInput = z.object({
    symbol: symbolSchema,
    side: sideSchema,
    qty: z.number().int().min(1).max(1_000_000),
    orderType: orderTypeSchema,
    limitPrice: z.number().positive().optional()
  });

  server.registerTool("trading_preview_order", {
    title: "Preview paper order",
    description: "Estimate fees, tax, buying power, and potential mock fill without placing an order.",
    inputSchema: tradeInput
  }, ({ symbol, side, qty, orderType, limitPrice }) => wrap(async () => {
    const stock = validSymbol(symbol);
    const [quote, account, positions] = await Promise.all([
      getQuote(stock), getBroker().getAccount(mcpUserId()), getBroker().getPositions(mcpUserId())
    ]);
    if (!quote?.c) throw new Error("Quote unavailable; cannot preview");
    return previewPaperOrder({
      symbol: stock, side, qty, orderType, limitPrice,
      lastPrice: quote.c, quoteTimestamp: quote.t, cashTWD: account.cashTWD,
      heldQty: positions.find(p => p.symbol === stock)?.qty ?? 0
    });
  }));

  server.registerTool("trading_place_order", {
    title: "Place paper order",
    description: "MUTATES virtual paper portfolio. Disabled unless OPENSTOCK_MCP_ENABLE_TRADING=true. No real broker connected.",
    inputSchema: tradeInput
  }, ({ symbol, side, qty, orderType, limitPrice }) => wrap(async () => {
    if (process.env.OPENSTOCK_MCP_ENABLE_TRADING !== "true") {
      throw new Error("MCP paper order writes disabled by OPENSTOCK_MCP_ENABLE_TRADING");
    }
    return getBroker().placeOrder(mcpUserId(), {
      symbol: validSymbol(symbol), side, qty, orderType, limitPrice
    });
  }));

  server.registerTool("trading_cancel_order", {
    title: "Cancel paper order",
    description: "Cancels a pending paper order. Disabled unless OPENSTOCK_MCP_ENABLE_TRADING=true.",
    inputSchema: z.object({ orderId: z.string().min(1).max(100) })
  }, ({ orderId }) => wrap(async () => {
    if (process.env.OPENSTOCK_MCP_ENABLE_TRADING !== "true") {
      throw new Error("MCP paper order writes disabled by OPENSTOCK_MCP_ENABLE_TRADING");
    }
    return getBroker().cancelOrder(mcpUserId(), orderId);
  }));
}, { serverInfo: { name: "openstocktw", version: "0.1.0" } });

async function protectedHandler(request: Request): Promise<Response> {
  if (!isMcpConfigured()) {
    return Response.json({ error: "MCP token or service user is not configured" }, { status: 503 });
  }
  if (!isAuthorizedMcpRequest(request)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json", "WWW-Authenticate": 'Bearer realm="openstocktw-mcp"' }
    });
  }
  const response = await handler(request);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export const GET = protectedHandler;
export const POST = protectedHandler;
export const DELETE = protectedHandler;
