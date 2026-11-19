import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { parseTwSymbol } from "@/lib/tw/symbols";
import { getQuote } from "@/lib/actions/tw.actions";
import { getBroker } from "@/lib/trading/broker";
import { connectToDatabase } from "@/database/mongoose";
import { DailyBar } from "@/database/models/daily-bar.model";
import { AgentWatch } from "@/database/models/agent-watch.model";
import { AgentObservation } from "@/database/models/agent-observation.model";
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
    limitPrice: z.number().positive().optional(),
    clientOrderId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/).optional()
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
      lastPrice: quote.c, quoteTimestamp: quote.t, cashTWD: account.availableCashTWD,
      heldQty: positions.find(p => p.symbol === stock)?.availableQty ?? 0
    });
  }));

  server.registerTool("trading_place_order", {
    title: "Place paper order",
    description: "MUTATES virtual paper portfolio. Disabled unless OPENSTOCK_MCP_ENABLE_TRADING=true. No real broker connected.",
    inputSchema: tradeInput.extend({ clientOrderId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/) })
  }, ({ symbol, side, qty, orderType, limitPrice, clientOrderId }) => wrap(async () => {
    if (process.env.OPENSTOCK_MCP_ENABLE_TRADING !== "true") {
      throw new Error("MCP paper order writes disabled by OPENSTOCK_MCP_ENABLE_TRADING");
    }
    return getBroker().placeOrder(mcpUserId(), {
      symbol: validSymbol(symbol), side, qty, orderType, limitPrice, clientOrderId
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
  server.registerTool("trading_match_pending", {
    title: "Match pending PAPER orders",
    description: "Matches pending simulated limits for the bound test account using indicative quotes. Requires OPENSTOCK_MCP_ENABLE_TRADING=true.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(50).default(20) })
  }, ({limit}) => wrap(async()=>{
    if (process.env.OPENSTOCK_MCP_ENABLE_TRADING!=="true") throw new Error("Paper matching is disabled");
    return getBroker().matchPendingOrders({userId:mcpUserId(),limit});
  }));

  server.registerTool("agent_runner_status", {
    title: "Read persistent observation worker heartbeat",
    description: "Returns whether a read-only agent worker heartbeat was observed in the last two minutes.",
    inputSchema: z.object({})
  },()=>wrap(async()=>{
    const connection=await connectToDatabase();
    const db=connection.connection.db;
    if (!db) throw new Error("MongoDB not ready");
    const rows=await db.collection("agentworkerheartbeats").find({
      lastSeenAt:{$gte:new Date(Date.now()-120000)}
    }).sort({lastSeenAt:-1}).limit(10).toArray();
    return {
      online:rows.length>0,
      workerCount:rows.length,
      workers:rows.map(row=>({owner:row.owner,lastSeenAt:row.lastSeenAt,kind:row.kind,pollMs:row.pollMs}))
    };
  }));

  server.registerTool("agent_watch_upsert", {
    title: "Schedule read-only price observations",
    description: "Durably schedule periodic indicative quote observations. No simulated or real orders are placed.",
    inputSchema: z.object({
      symbol:symbolSchema,intervalMinutes:z.number().int().min(5).max(1440).default(15)
    })
  }, ({symbol,intervalMinutes})=>wrap(async()=>{
    const userId=mcpUserId(), stock=validSymbol(symbol);
    await connectToDatabase();
    await AgentWatch.init();
    const existing=await AgentWatch.findOne({userId,symbol:stock});
    if (!existing && await AgentWatch.countDocuments({userId})>=50) throw new Error("Maximum 50 watches per service account");
    const watch=await AgentWatch.findOneAndUpdate({userId,symbol:stock},{
      $set:{active:true,intervalMinutes,nextRunAt:new Date(),lastError:null},
      $setOnInsert:{userId,symbol:stock}
    },{upsert:true,new:true});
    return {id:String(watch?._id),symbol:stock,intervalMinutes,active:true,nextRunAt:watch?.nextRunAt,
      note:"Read-only observation worker must be running separately."};
  }));

  server.registerTool("agent_watch_list", {
    title: "List scheduled agent observations",
    description: "List read-only market observation watches for the bound account.",
    inputSchema: z.object({})
  },()=>wrap(async()=>{
    await connectToDatabase();
    const rows=await AgentWatch.find({userId:mcpUserId()}).sort({symbol:1}).lean();
    return rows.map(r=>({
      id:String(r._id),symbol:r.symbol,active:r.active,
      intervalMinutes:r.intervalMinutes,nextRunAt:r.nextRunAt,
      lastRunAt:r.lastRunAt,lastStatus:r.lastStatus,lastError:r.lastError
    }));
  }));

  server.registerTool("agent_watch_pause", {
    title: "Pause an agent price watch",
    description: "Disable future observations of one symbol (an in-flight run may finish).",
    inputSchema: z.object({symbol:symbolSchema})
  },({symbol})=>wrap(async()=>{
    await connectToDatabase();
    const watch=await AgentWatch.findOneAndUpdate(
      {userId:mcpUserId(),symbol:validSymbol(symbol)},
      {$set:{active:false}},{new:true});
    if (!watch) throw new Error("Watch not found");
    return {symbol:watch.symbol,active:false};
  }));

  server.registerTool("agent_observations_list", {
    title: "Read agent observation history",
    description: "Read persistent quote observations, errors and timestamps; informational only.",
    inputSchema: z.object({limit:z.number().int().min(1).max(100).default(20)})
  },({limit})=>wrap(async()=>{
    await connectToDatabase();
    const docs=await AgentObservation.find({userId:mcpUserId()})
      .sort({observedAt:-1}).limit(limit).lean();
    return docs.map(d=>({
      id:String(d._id),symbol:d.symbol,status:d.status,scheduledAt:d.scheduledAt,
      observedAt:d.observedAt,quote:d.quote,detail:d.detail
    }));
  }));
}, { serverInfo: { name: "openstocktw", version: "0.2.0" } });

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
