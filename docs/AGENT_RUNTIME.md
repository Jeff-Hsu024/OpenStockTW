# Agent paper-trading runtime (2026-11-19)

## Current scope

`OpenStockTW` is now a **paper-only** financial backend usable by ChatGPT
through Queqiao's `dev.queqiao.mcp` extension. It also has a separate,
durable, **read-only** quote-observation runner. It is *not* an LLM-driven
autonomous trading strategy, and does not connect to a real broker.

Path: ChatGPT → Queqiao PC → MCP extension → Next.js `/api/mcp` →
MongoDB (local, independent `mongo:7` single-node replica set).

## Transactional MockBroker

All paper-order writes are executed inside MongoDB transactions:

- Deduplicate retries by `(userId,clientOrderId)` partial unique index.
  `clientOrderId` is required by the **MCP placement** tool (8–128
  ASCII `A-Z,a-z,0-9,_.:-` chars). Calling it twice with identical intent
  returns the same order ID, never another fill.
- Buying power and sellable share availability are checked **inside** the
  transaction, protecting from concurrent overdrafts/double-selling.
- Non-marketable buy limits reserve their limit-value buying power including
  fees; pending sell orders reserve shares. Cancel and fill release reserves.
- The explicit `trading_match_pending` MCP tool matches only pending orders
  of the **bound MCP test account**, using the current *indicative* quote.
  It never accepts caller-supplied prices. Matching is not run automatically.
- Legacy pending orders created before reservation fields existed **cannot
  safely be filled/cancelled** without reconciling their reservations first.
  New code fails closed rather than going negative. Do not point the POC at
  a legacy production trading database without a migration.
- MongoDB must support transactions (replica set or sharded cluster).
  Standalone MongoDB is intentionally **unsupported** for writes.
- Fees and simulated fills are simplified; delayed public quotes are not
  exchange executions.

MCP paper writes are gated by `OPENSTOCK_MCP_ENABLE_TRADING=true`; absent
or `false` means read-only/preview/watch mode.

## Durable observation worker

`scripts/agent-worker.mjs` polls durable `agentwatches` documents,
atomically leases due work, queries `stock_get_quote` over MCP, writes
`agentobservations` and advances `nextRunAt`. It handles a restart
between recording and rescheduling without duplicating an observation,
retries transient failures, and writes a two-minute heartbeat.

MCP tools: `agent_watch_upsert`, `agent_watch_list`,
`agent_watch_pause`, `agent_observations_list`,
`agent_runner_status`. Watch cadence is 5–1440 minutes, maximum 50
per fixed service account. No Agent tool submits a trade on a timer.

Run a one-shot check:

```powershell
$env:OPENSTOCK_AGENT_ENABLE='true'
node scripts/agent-worker.mjs --once
```

Run continuously:

```powershell
$env:OPENSTOCK_AGENT_ENABLE='true'
node scripts/agent-worker.mjs
```

For the local Windows POC two **Windows Task Scheduler** tasks run as the
logged-in user: `OpenStockTW MCP Server` and `OpenStockTW Agent Watcher`.
They start at logon, restart on failures (up to five attempts) and are
configured to ignore duplicate running instances. To prevent orphan
child processes during Task Scheduler restarts, the registered actions
invoke the installed Node executable **directly**, with:
`node_modules/next/dist/bin/next start --hostname 127.0.0.1`
and `scripts/agent-worker.mjs --run`. The `.cmd` scripts are separate
manual fallbacks, not the registered task actions. A third logon task
`OpenStockTW MCP Mongo` starts the isolated Mongo container via WSL.
Verify all three tasks with:

```powershell
Get-ScheduledTask -TaskName 'OpenStockTW*'
Get-ScheduledTaskInfo -TaskName 'OpenStockTW Agent Watcher'
```

These logon tasks are **not OS boot services**. The local Mongo Docker
daemon/WSL must be available. The MCP Server task uses a prebuilt
`.next` directory; after code changes, rebuild and restart that task.
The scheduler does not create an LLM process or silently permit trading.

## Isolated local POC setup

Database container: `openstocktw-mcp-mongo`, volume
`openstocktw-mcp-mongo-data`, TCP `127.0.0.1:27019→27017`,
`mongo:7 --replSet rs0 --bind_ip_all`. Initiated as replica set
`rs0`. Windows MongoDB URI:

```text
mongodb://127.0.0.1:27019/openstocktw_mcp_test?directConnection=true&replicaSet=rs0
```

The container has **no MongoDB user authentication**. Binding to
loopback prevents ordinary LAN access but does not make it production
grade. Add DB auth, isolated service credentials, HTTPS if exposed, and
secrets management before processing personal finance records.

Local `.env.local` and Queqiao's User-scoped `OPENSTOCK_MCP_TOKEN`
are intentionally not committed. Next.js and Worker must use the same
secret. Restart the managed Worker from an **independent** Orca terminal
to ensure the environment variable reaches its process.

## Verification

A local isolated transaction integration test uses its **own database**,
`openstocktw_trading_integration`. It clears the account/position/order
collections in that DB in `beforeEach`. Do not point it at personal data.

```powershell
$env:OPENSTOCK_INTEGRATION_MONGODB_URI='mongodb://127.0.0.1:27019/openstocktw_trading_integration?directConnection=true&replicaSet=rs0'
$env:MONGODB_URI=$env:OPENSTOCK_INTEGRATION_MONGODB_URI
npm test -- --reporter=dot
npm run build
```

Tests cover idempotent parallel fills, concurrent overspend/oversell
prevention, bid/ask reservations, cancellation, deterministic matching,
durable quote task claiming, crash-recovery deduplication and error retry.

The normal `npm test` run without the integration URI skips destructive
Mongo integration suites. The pre-existing three standalone TypeScript
errors were also resolved: the country selection form is now generic
over its controlling form type, and Better Auth's MongoDB adapter uses
an explicit type-boundary cast because the installed Mongoose and
Better Auth packages declare incompatible driver-private `Db` types
across their MongoDB 6.x minor versions. Verify with `npx tsc --noEmit`.
Next.js's existing build script still skips its separate type-validation
phase, so run the explicit compiler check in CI.

## Operational boundaries

Before enabling live customer accounts, add user-scoped OAuth, full
account/transaction audit logging, risk policy and position limits,
reconciliation of legacy pending orders, market-hours-aware matching,
realistic exchange matching and a production MongoDB replica set with
authentication. Never replace `getBroker()` with a real broker adapter
without redesigning this write gate and confirmation flow.
