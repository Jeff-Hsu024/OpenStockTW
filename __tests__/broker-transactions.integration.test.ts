import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { STARTING_CASH_TWD } from "@/lib/trading/types";
import { TradingAccount } from "@/database/models/trading-account.model";
import { TradingPosition } from "@/database/models/trading-position.model";
import { TradingOrder } from "@/database/models/trading-order.model";
import { MockBroker } from "@/lib/trading/broker";

vi.mock("@/lib/actions/tw.actions", () => ({
  getQuote: vi.fn(async () => ({ c: 100, t: 1795059600 }))
}));

const uri = process.env.OPENSTOCK_INTEGRATION_MONGODB_URI;
describe.skipIf(!uri)("MockBroker transactional paper fills (isolated replica-set DB)", () => {
  const broker = new MockBroker();
  const account = "transaction-integration-user";

  beforeAll(async () => {
    await mongoose.connect(uri!);
    await Promise.all([TradingAccount.init(), TradingPosition.init(), TradingOrder.init()]);
  });

  beforeEach(async () => {
    await Promise.all([TradingOrder.deleteMany({}), TradingPosition.deleteMany({}), TradingAccount.deleteMany({})]);
  });

  afterAll(async () => { await mongoose.disconnect(); });

  it("replays the same idempotency key without double charge", async () => {
    const order = { symbol: "TWSE:2330", side: "buy" as const, qty: 1000,
      orderType: "market" as const, clientOrderId: "idempotent-1" };
    const [a, b] = await Promise.all([broker.placeOrder(account, order), broker.placeOrder(account, order)]);
    expect(a.id).toBe(b.id);
    expect(a.status).toBe("filled");
    expect((await broker.getPositions(account))[0].qty).toBe(1000);
    expect((await broker.getAccount(account)).cashTWD).toBe(STARTING_CASH_TWD - 100000 - 143);
  });

  it("does not allow concurrent distinct orders to overspend the account", async () => {
    const attempted = await Promise.all(Array.from({length: 15}, (_,i) => broker.placeOrder(account, {
      symbol: "TWSE:2330", side: "buy", qty: 1000, orderType: "market", clientOrderId: "cash-order-"+i
    })));
    const filled = attempted.filter((r)=>r.status==="filled").length;
    const rejected = attempted.filter((r)=>r.status==="rejected").length;
    expect(filled).toBe(9);
    expect(rejected).toBe(6);
    expect((await broker.getPositions(account))[0].qty).toBe(9000);
    expect((await broker.getAccount(account)).cashTWD).toBe(STARTING_CASH_TWD - 9*100143);
  });

  it("cannot sell shares twice when concurrent orders overlap", async () => {
    await broker.placeOrder(account, {symbol:"TWSE:2330",side:"buy",qty:1000,orderType:"market"});
    const [a,b] = await Promise.all([
      broker.placeOrder(account, {symbol:"TWSE:2330",side:"sell",qty:1000,orderType:"market",clientOrderId:"sell-order-1"}),
      broker.placeOrder(account, {symbol:"TWSE:2330",side:"sell",qty:1000,orderType:"market",clientOrderId:"sell-order-2"})
    ]);
    expect([a.status,b.status].sort()).toEqual(["filled","rejected"]);
    expect(await broker.getPositions(account)).toEqual([]);
  });

  it("rejects mismatched retries sharing a clientOrderId", async () => {
    const order = {symbol:"TWSE:2330",side:"buy" as const,qty:10,orderType:"market" as const,clientOrderId:"unique-key"};
    await broker.placeOrder(account,order);
    await expect(broker.placeOrder(account,{...order,qty:20})).rejects.toThrow(/Idempotency/);
  });

  it("matches only marketable pending orders and preserves their original order ID", async () => {
    const input = {symbol:"TWSE:2330",side:"buy" as const,qty:10,orderType:"limit" as const,limitPrice:90,clientOrderId:"resting-1"};
    const resting=await broker.placeOrder(account,input);
    expect(resting.status).toBe("pending");
    expect((await broker.matchPendingOrders({prices:{"TWSE:2330":100}})).filled).toBe(0);
    const settled=await broker.matchPendingOrders({prices:{"TWSE:2330":89}});
    expect(settled.filled).toBe(1);
    expect((await broker.getOrders(account))[0].id).toBe(resting.id);
    expect((await broker.getPositions(account))[0].qty).toBe(10);
    expect((await broker.getAccount(account)).reservedCashTWD).toBe(0);
  });

  it("reserves buying power for pending bids; releases on cancel and never double-fills", async () => {
    const buy = {symbol:"TWSE:2330",side:"buy" as const,qty:5000,orderType:"limit" as const,
      limitPrice:90,clientOrderId:"pending-reserved-1"};
    const pending=await broker.placeOrder(account,buy);
    expect(pending.status).toBe("pending");
    expect((await broker.getAccount(account)).availableCashTWD).toBe(STARTING_CASH_TWD - (450000 + 641));
    const duplicate=await broker.placeOrder(account,{...buy,clientOrderId:"pending-reserved-2"});
    expect(duplicate.status).toBe("pending");
    const denied=await broker.placeOrder(account,{symbol:"TWSE:2330",side:"buy",qty:1100,orderType:"market"});
    expect(denied.status).toBe("rejected");
    await broker.cancelOrder(account,pending.id);
    expect((await broker.getAccount(account)).reservedCashTWD).toBe(450641);
    await broker.cancelOrder(account,duplicate.id);
    expect((await broker.getAccount(account)).reservedCashTWD).toBe(0);
  });

  it("reserves stock for resting sell and releases after cancellation", async () => {
    await broker.placeOrder(account,{symbol:"TWSE:2330",side:"buy",qty:1000,orderType:"market"});
    const pending=await broker.placeOrder(account,{
      symbol:"TWSE:2330",side:"sell",qty:800,orderType:"limit",limitPrice:110
    });
    expect(pending.status).toBe("pending");
    expect((await broker.getPositions(account))[0].availableQty).toBe(200);
    const denied=await broker.placeOrder(account,{symbol:"TWSE:2330",side:"sell",qty:300,orderType:"market"});
    expect(denied.status).toBe("rejected");
    await broker.cancelOrder(account,pending.id);
    expect((await broker.getPositions(account))[0].availableQty).toBe(1000);
  });

  it("fails closed on pre-reservation legacy pending orders", async () => {
    const legacy=await TradingOrder.create({
      userId:account,symbol:"TWSE:2330",side:"buy",qty:10,
      orderType:"limit",limitPrice:90,status:"pending"
    });
    await expect(broker.cancelOrder(account,String(legacy._id))).rejects.toThrow(/Legacy pending/);
    await expect(broker.matchPendingOrders({prices:{"TWSE:2330":89}})).rejects.toThrow(/Legacy pending/);
    expect((await TradingOrder.findById(legacy._id))?.status).toBe("pending");
    expect((await broker.getAccount(account)).reservedCashTWD).toBe(0);
    await expect(broker.placeOrder(account,{
      symbol:"TWSE:2330",side:"buy",qty:1,orderType:"market",clientOrderId:"new-after-legacy"
    })).rejects.toThrow(/Legacy pending/);
  });
});
