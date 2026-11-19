# OpenStockTW ↔ Queqiao MCP integration

Repository: https://github.com/Jeff-Hsu024/OpenStockTW

## Architecture

ChatGPT/agent → Queqiao Gateway → pc-wins Worker → `dev.queqiao.mcp`
extension → Streamable HTTP → `/api/mcp` → OpenStockTW service
account → MongoDB/TWSE/TPEx. The site has **no embedded agent runtime**.

## Authentication (POC: one bound service account)

The MCP route is **disabled** until both environment values are set:

- `OPENSTOCK_MCP_TOKEN`: random secret, at least 32 characters.
- `OPENSTOCK_MCP_USER_ID`: an existing Better Auth user's **database ID** (not email).

For local testing, set the values in the Next.js server environment or
`.env.local` (never commit credentials). `OPENSTOCK_MCP_ENABLE_TRADING=true`
permits simulated order mutations; defaults to disabled. BrokerAdapter currently
returns MockBroker only; the MCP route does not connect to a live broker.

Create a dedicated test account, rather than sharing a live user's ID. The
service account is **not multi-tenant**. The caller is never allowed to choose
`userId`. Use TLS and proper secrets management when exposing MCP remotely.

## Install Queqiao extension on PC

```bash
queqiao extension install npm:@tibame201020/queqiao-mcp --attach-all
queqiao extension list
```

The npm scope is an independent publishing identity and is **not** automatically
renamed by moving a GitHub repository. The published package can still be
installed as long as npm serves it; source migration and package namespace
migration are separate operations.

Configure the Windows Queqiao MCP adapter at:
`%LOCALAPPDATA%\\Queqiao\\extensions\\mcp\\config.json`.

```json
{
  "servers": {
    "openstocktw": {
      "transport": "streamable-http",
      "url": "http://127.0.0.1:3000/api/mcp",
      "headers": {
        "Authorization": { "env": "OPENSTOCK_MCP_TOKEN", "prefix": "Bearer " }
      },
      "enabled": true,
      "timeoutMs": 30000
    }
  }
}
```

The Queqiao Worker process must receive the same
`OPENSTOCK_MCP_TOKEN` **via its environment**. Setting a new variable in a
terminal alone does not update a running Worker. Set the service environment
and restart the managed Worker before invoking downstream MCP.

## Tools

Read: `stock_get_quote`, `stock_get_candles`, `portfolio_get_account`,
`portfolio_get_positions`, `trading_get_orders`.

Preview: `trading_preview_order`.

Simulated writes: `trading_place_order`, `trading_cancel_order`
(requires `OPENSTOCK_MCP_ENABLE_TRADING=true`).

`stock_get_candles` reads **locally cached** MongoDB bars, not the public API
fallback. Run backfill if no bars exist. The MIS quote used by mock fills can
be delayed and may fall back to bid/ask or previous close.

## Acceptance

1. Request MCP `initialize` with an authorized bearer token.
2. List MCP tools and verify the eight names above.
3. Queqiao extension `servers` → `search` → `describe` → `call`
   for `stock_get_quote`.
4. Verify `portfolio_get_account` uses the designated test account only.
5. Preview a paper buy; ensure no order is created.
6. Keep writes disabled until idempotency and balance/position concurrency
   controls are added. The current MockBroker is **not** safe for concurrent
   autonomous trading.

## Known limits

This is a single-user **paper** integration. No generic user OAuth, realtime
quote guarantee, exchange-style matching, transaction isolation, or automatic
execution loop is provided yet.
