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

## Verified local integration — 2026-11-19

GitHub source moved to `Jeff-Hsu024/OpenStockTW`; the `main` branch
was pushed with the original Git history and MCP commit `bde7346`.
GitHub migration and npm package ownership are independent: the Queqiao
adapter still installs from `@tibame201020/queqiao-mcp@0.1.1`.

Verified through ChatGPT → Queqiao Gateway → `pc-wins` Worker →
`dev.queqiao.mcp@0.1.1` → OpenStockTW Streamable HTTP `/api/mcp`:

- `servers`: OpenStockTW registered and enabled.
- `search`: eight MCP tools discovered.
- `describe`: `stock_get_quote` schema retrieved.
- `call`: `stock_get_quote(TWSE:2330)` returned an indicative quote.
- `call`: `portfolio_get_account` returned TWD 1,000,000 for the
  dedicated POC id `mcp-local-smoke-test`.
- `call`: `trading_preview_order` calculated virtual quantity, fees,
  limit price and buying power without writing any order.
- `call`: `trading_get_orders` and `portfolio_get_positions` returned
  empty lists after preview (no mutation).
- `call`: `stock_get_candles` returned three TWSE:2330 bars after a
  bounded `--days=5 --skip-tpex` TWSE backfill.
- Direct MCP HTTP smoke: unauthenticated requests rejected, `initialize`,
  `tools/list`, and read-only `tools/call` passed.

POC database is an isolated `mongo:7` container running inside WSL at
`127.0.0.1:27019`, using a Docker volume
`openstocktw-mcp-mongo-data`. This test DB was intentionally created
without database credentials and bound to loopback only. **Do not expose
it publicly** or reuse it for financial records; add MongoDB authentication
before production deployment. The Next.js server is launched in an Orca
terminal on port 3000. The `.env.local` file is Git-ignored.

The Queqiao MCP adapter resolves its bearer token from the Worker process
environment (not from `.env.local`). For this Windows POC the token was
also stored as the current user's `OPENSTOCK_MCP_TOKEN` environment
variable. A managed Worker restart initiated **from within that Worker**
uses Queqiao's deferred-restart helper and may not inherit newly added
environment variables. An independent Orca terminal can load the Windows
user-scoped variable and run the supported
`queqiao worker restart --worker pc-wins` command, then validate with
`servers → search → describe → call`.

Paper-order writes are still disabled by
`OPENSTOCK_MCP_ENABLE_TRADING=false`. No live-broker connections or
autonomous trading runtime have been installed. Historical market data is
currently limited to the short POC backfill and is not full 3m/6m/1y coverage.

Orca's durable project metadata might still display the original
`tibame201020/OpenStockTW` source identity even after the Git origin
is migrated; the repository's Git `origin` and GitHub remote are
authoritative for this migration, not the cached project icon.
