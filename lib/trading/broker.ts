/**
 * Paper brokerage only. All monetary and position mutations are committed in
 * a single MongoDB transaction (requires replica-set / sharded deployment).
 * There is no real broker adapter in this application.
 */
import mongoose, { type ClientSession } from "mongoose";
import { connectToDatabase } from "@/database/mongoose";
import { TradingAccount } from "@/database/models/trading-account.model";
import { TradingPosition } from "@/database/models/trading-position.model";
import { TradingOrder, type ITradingOrder } from "@/database/models/trading-order.model";
import { getQuote } from "@/lib/actions/tw.actions";
import {
  calcFee, calcTax, STARTING_CASH_TWD,
  type Account, type Order, type PlaceOrderInput, type Position
} from "@/lib/trading/types";

export interface AccountSummary extends Account {
  marketValueTWD: number;
  totalValueTWD: number;
  unrealizedPnlTWD: number;
  availableCashTWD: number;
}
export interface PositionView extends Position {
  currentPrice?: number;
  marketValueTWD: number;
  unrealizedPnlTWD: number;
  unrealizedPnlPct?: number;
  availableQty: number;
}
export interface BrokerAdapter {
  placeOrder(userId: string, input: PlaceOrderInput): Promise<Order>;
  cancelOrder(userId: string, orderId: string): Promise<Order>;
  getOrders(userId: string, limit?: number): Promise<Order[]>;
  getPositions(userId: string): Promise<PositionView[]>;
  getAccount(userId: string): Promise<AccountSummary>;
}
const toOrder = (d: ITradingOrder): Order => ({
  id: String(d._id), userId: d.userId, clientOrderId: d.clientOrderId,
  symbol: d.symbol, side: d.side, qty: d.qty,
  orderType: d.orderType, limitPrice: d.limitPrice,
  status: d.status, rejectReason: d.rejectReason,
  createdAt: d.createdAt, filledAt: d.filledAt, fillPrice: d.fillPrice,
  fee: d.fee, tax: d.tax,
});
const normalize = (input: PlaceOrderInput): PlaceOrderInput => {
  const symbol = String(input.symbol || "").trim().toUpperCase();
  if (!/^(TWSE|TPEX):[0-9]{4}[A-Z]?$/.test(symbol)) throw new Error("Invalid Taiwan stock symbol");
  if (input.side !== "buy" && input.side !== "sell") throw new Error("Invalid side");
  if (input.orderType !== "market" && input.orderType !== "limit") throw new Error("Invalid order type");
  if (!Number.isSafeInteger(input.qty) || input.qty <= 0 || input.qty > 1_000_000) throw new Error("Invalid quantity");
  if (input.orderType === "limit" && (!Number.isFinite(input.limitPrice) || !(input.limitPrice! > 0))) {
    throw new Error("Positive limit price required");
  }
  if (input.clientOrderId && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(input.clientOrderId)) {
    throw new Error("Invalid clientOrderId (8–128 ASCII characters)");
  }
  return {
    symbol, side: input.side, qty: input.qty, orderType: input.orderType,
    ...(input.orderType === "limit" ? {limitPrice: input.limitPrice} : {}),
    ...(input.clientOrderId ? {clientOrderId: input.clientOrderId} : {})
  };
};
const sameIntent = (order: ITradingOrder, input: PlaceOrderInput) =>
  order.symbol === input.symbol && order.side === input.side &&
  order.qty === input.qty && order.orderType === input.orderType &&
  (order.limitPrice ?? undefined) === (input.limitPrice ?? undefined);
const reservationAmount = (input: PlaceOrderInput) =>
  input.limitPrice! * input.qty + calcFee(input.limitPrice! * input.qty);
const marketable = (input: PlaceOrderInput, price: number) =>
  input.orderType === "market" ||
  (input.side === "buy" ? input.limitPrice! >= price : input.limitPrice! <= price);

async function ensureAccount(userId: string, session?: ClientSession) {
  const account = await TradingAccount.findOneAndUpdate({userId}, {
    $setOnInsert: {userId, cashTWD: STARTING_CASH_TWD, reservedCashTWD: 0}
  }, {upsert:true, new:true, session});
  if (!account) throw new Error("Paper account initialization failed");
  return account;
}
/** Fail closed for legacy/stale pending-order reservations before a new write.
 * A pre-reservation pending order must be reconciled explicitly; otherwise
 * new orders could consume buying power or stock that should be locked.
 */
async function assertReservationIntegrity(userId: string, session: ClientSession) {
  const account = await ensureAccount(userId,session);
  const pending = await TradingOrder.find({userId,status:"pending"}).session(session);
  let expectedCash = 0;
  const expectedShares = new Map<string,number>();
  for (const order of pending) {
    if (order.orderType !== "limit" || !(order.limitPrice && order.limitPrice > 0)) {
      throw new Error("Legacy pending order missing valid limit; reconcile before placing new orders");
    }
    if (order.side === "buy") expectedCash += reservationAmount(order);
    else expectedShares.set(order.symbol,(expectedShares.get(order.symbol)??0)+order.qty);
  }
  if (Math.abs(expectedCash-(account.reservedCashTWD??0)) > 0.001) {
    throw new Error("Legacy pending buy orders have no reserved cash; reconcile before placing new orders");
  }
  const positions = await TradingPosition.find({userId}).session(session);
  for (const pos of positions) {
    const expected=expectedShares.get(pos.symbol)??0;
    if ((pos.reservedQty??0) !== expected) {
      throw new Error("Legacy pending sell orders have no reserved position; reconcile before placing new orders");
    }
    expectedShares.delete(pos.symbol);
  }
  if (expectedShares.size) {
    throw new Error("Legacy pending sell orders have no reserved position; reconcile before placing new orders");
  }
}
function retriable(err: unknown) {
  const error = err as { code?: number; hasErrorLabel?: (value: string) => boolean };
  return [11000, 112, 251].includes(error?.code ?? 0) ||
    Boolean(error?.hasErrorLabel?.("TransientTransactionError"));
}
/** Transactional retry for MongoDB transient write conflicts. */
async function withPaperTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  for (let attempt=0; attempt<32; attempt++) {
    const session = await mongoose.startSession();
    try {
      let result!: T;
      await session.withTransaction(async()=>{ result = await fn(session); });
      return result;
    } catch (error) {
      if (!retriable(error) || attempt === 31) throw error;
      await new Promise(resolve => setTimeout(resolve, 7*(attempt+1)));
    } finally {
      await session.endSession();
    }
  }
  throw new Error("Paper transaction retry exhausted");
}

async function createOrder(userId: string, input: PlaceOrderInput,
                           status: Order["status"], session: ClientSession,
                           extra: Partial<ITradingOrder> = {}) {
  const [order] = await TradingOrder.create([{userId, ...input, status, ...extra}], {session});
  return order;
}
async function settle(userId: string, input: PlaceOrderInput, price: number,
                      session: ClientSession, pending?: ITradingOrder): Promise<Order> {
  if (!Number.isFinite(price) || price <= 0) throw new Error("Invalid execution quote");
  if (input.orderType==="limit" && !marketable(input,price)) throw new Error("Limit is not marketable");
  const gross = price*input.qty, fee=calcFee(gross),
        tax=input.side==="sell" ? calcTax(gross) : 0;
  const release = pending?.side==="buy" ? reservationAmount(input) : 0;
  const reject = async (reason: string): Promise<Order> => {
    if (pending) {
      if (input.side==="buy") {
        const released=await TradingAccount.updateOne({userId,reservedCashTWD:{$gte:release}},
          {$inc:{reservedCashTWD:-release}},{session});
        if (!released.matchedCount) throw new Error("Unable to release reserved cash");
      } else {
        const released=await TradingPosition.updateOne({userId,symbol:input.symbol,reservedQty:{$gte:input.qty}},
          {$inc:{reservedQty:-input.qty}},{session});
        if (!released.matchedCount) throw new Error("Unable to release reserved position");
      }
      pending.status="rejected"; pending.rejectReason=reason;
      await pending.save({session});
      return toOrder(pending);
    }
    return toOrder(await createOrder(userId,input,"rejected",session,{rejectReason:reason}));
  };
  const existingAccount = await ensureAccount(userId,session);
  if (pending && input.side === "buy" && (existingAccount.reservedCashTWD ?? 0) < release) {
    throw new Error("Legacy pending order has no reserved cash; reconcile before matching");
  }
  if (input.side === "buy") {
    const cost=gross+fee;
    const account=await TradingAccount.findOneAndUpdate({
      userId,
      $expr: {$gte:[{$subtract:["$cashTWD", {$subtract:[{$ifNull:["$reservedCashTWD",0]},release]}]},cost]}
    }, {$inc:{cashTWD:-cost, reservedCashTWD:-release}}, {new:true,session});
    if (!account) return reject("Insufficient available cash");
    const pos=await TradingPosition.findOne({userId,symbol:input.symbol}).session(session);
    if (pos) {
      pos.avgCost=(pos.qty*pos.avgCost+gross+fee)/(pos.qty+input.qty);
      pos.qty+=input.qty;
      await pos.save({session});
    } else {
      await TradingPosition.create([{
        userId,symbol:input.symbol,qty:input.qty,avgCost:(gross+fee)/input.qty,reservedQty:0
      }],{session});
    }
  } else {
    const pos = await TradingPosition.findOne({userId,symbol:input.symbol}).session(session);
    const reservedQty=pos?.reservedQty??0;
    const availableQty=(pos?.qty??0) - reservedQty + (pending ? input.qty : 0);
    if (!pos || availableQty < input.qty || (pending && reservedQty < input.qty)) {
      return reject("Insufficient available position");
    }
    pos.qty-=input.qty;
    if (pending) pos.reservedQty-=input.qty;
    if (pos.qty === 0) await pos.deleteOne({session});
    else await pos.save({session});
    await TradingAccount.updateOne({userId},{$inc:{cashTWD:gross-fee-tax}},{session});
  }
  const changes={status:"filled" as const, fillPrice:price,fee,tax,filledAt:new Date()};
  if (pending) {
    Object.assign(pending,changes);
    await pending.save({session});
    return toOrder(pending);
  }
  return toOrder(await createOrder(userId,input,"filled",session,changes));
}

export class MockBroker implements BrokerAdapter {
  async placeOrder(userId: string, supplied: PlaceOrderInput): Promise<Order> {
    const input=normalize(supplied);
    await connectToDatabase();
    const duplicate=async():Promise<Order|null>=>{
      if (!input.clientOrderId) return null;
      const previous=await TradingOrder.findOne({userId,clientOrderId:input.clientOrderId});
      if (!previous) return null;
      if (!sameIntent(previous,input)) throw new Error("Idempotency key reused with different order intent");
      return toOrder(previous);
    };
    const previous=await duplicate();
    if (previous) return previous;
    const quote=await getQuote(input.symbol);
    const price=quote?.c;
    if (!price || !Number.isFinite(price) || price <= 0) {
      throw new Error("No valid paper quote available (no order created)");
    }
    try {
      return await withPaperTransaction(async session=>{
        if (input.clientOrderId) {
          const prior=await TradingOrder.findOne({userId,clientOrderId:input.clientOrderId}).session(session);
          if (prior) {
            if (!sameIntent(prior,input)) throw new Error("Idempotency key reused with different order intent");
            return toOrder(prior);
          }
        }
        await assertReservationIntegrity(userId,session);
        if (marketable(input,price)) return settle(userId,input,price,session);
        await ensureAccount(userId,session);
        if (input.side==="buy") {
          const amount=reservationAmount(input);
          const acct=await TradingAccount.findOneAndUpdate({
            userId,$expr:{$gte:[{$subtract:["$cashTWD",{$ifNull:["$reservedCashTWD",0]}]},amount]}
          },{$inc:{reservedCashTWD:amount}},{session,new:true});
          if (!acct) return toOrder(await createOrder(userId,input,"rejected",session,{rejectReason:"Insufficient available cash to reserve"}));
        } else {
          const pos=await TradingPosition.findOne({userId,symbol:input.symbol}).session(session);
          if (!pos || pos.qty-(pos.reservedQty??0)<input.qty) {
            return toOrder(await createOrder(userId,input,"rejected",session,{rejectReason:"Insufficient available position to reserve"}));
          }
          pos.reservedQty=(pos.reservedQty??0)+input.qty;
          await pos.save({session});
        }
        return toOrder(await createOrder(userId,input,"pending",session));
      });
    } catch(error) {
      const replay=await duplicate();
      if (replay) return replay;
      throw error;
    }
  }

  async cancelOrder(userId: string, orderId: string): Promise<Order> {
    await connectToDatabase();
    if (!mongoose.isValidObjectId(orderId)) throw new Error("Invalid order ID");
    return withPaperTransaction(async session=>{
      const order=await TradingOrder.findOne({_id:orderId,userId}).session(session);
      if (!order) throw new Error("Order not found");
      if (order.status!=="pending") throw new Error("Only pending orders may be cancelled");
      if (order.side==="buy") {
        const release = await TradingAccount.updateOne({
          userId,reservedCashTWD:{$gte:reservationAmount(order)}
        },{$inc:{reservedCashTWD:-reservationAmount(order)}},{session});
        if (!release.matchedCount) throw new Error("Legacy pending order has no reserved cash; reconcile before cancelling");
      } else {
        const release = await TradingPosition.updateOne({
          userId,symbol:order.symbol,reservedQty:{$gte:order.qty}
        },{$inc:{reservedQty:-order.qty}},{session});
        if (!release.matchedCount) throw new Error("Legacy pending order has no reserved position; reconcile before cancelling");
      }
      order.status="cancelled";
      await order.save({session});
      return toOrder(order);
    });
  }

  /** Explicit paper-only matcher. Pass prices in deterministic integration tests;
   * runtime caller must omit them to use indicative market quotes.
   */
  async matchPendingOrders(options: { prices?: Record<string,number>; limit?: number; userId?: string } = {}) {
    await connectToDatabase();
    const docs=await TradingOrder.find({status:"pending", ...(options.userId?{userId:options.userId}:{})}).sort({createdAt:1}).limit(Math.min(options.limit??50,200));
    let filled=0,rejected=0,skipped=0;
    for (const doc of docs) {
      const input=normalize({
        symbol:doc.symbol,side:doc.side,qty:doc.qty,orderType:doc.orderType,
        limitPrice:doc.limitPrice,clientOrderId:doc.clientOrderId
      });
      const price=options.prices?.[doc.symbol]??(await getQuote(doc.symbol))?.c;
      if (!price || !Number.isFinite(price) || price <= 0 || !marketable(input,price)) { skipped++; continue; }
      const result=await withPaperTransaction(async session=>{
        const existing=await TradingOrder.findOne({_id:doc._id,status:"pending"}).session(session);
        if (!existing) return null;
        return settle(existing.userId,input,price,session,existing);
      });
      if (result?.status==="filled") filled++;
      else if (result?.status==="rejected") rejected++;
      else skipped++;
    }
    return {filled,rejected,skipped,scanned:docs.length};
  }

  async getOrders(userId: string, limit = 50): Promise<Order[]> {
    await connectToDatabase();
    return (await TradingOrder.find({userId}).sort({createdAt:-1}).limit(limit)).map(toOrder);
  }

  async getPositions(userId: string): Promise<PositionView[]> {
    await connectToDatabase();
    const rows=await TradingPosition.find({userId}).sort({symbol:1});
    const views: PositionView[]=[];
    for (const row of rows) {
      const quote=await getQuote(row.symbol);
      const currentPrice=quote?.c;
      const marketValueTWD=currentPrice ? currentPrice*row.qty : row.avgCost*row.qty;
      const unrealizedPnlTWD=marketValueTWD-row.avgCost*row.qty;
      views.push({
        userId:row.userId,symbol:row.symbol,qty:row.qty,avgCost:row.avgCost,
        reservedQty:row.reservedQty??0,availableQty:row.qty-(row.reservedQty??0),
        currentPrice,marketValueTWD,unrealizedPnlTWD,
        unrealizedPnlPct:row.avgCost>0 ? unrealizedPnlTWD/(row.avgCost*row.qty)*100 : undefined
      });
    }
    return views;
  }

  async getAccount(userId: string): Promise<AccountSummary> {
    await connectToDatabase();
    const acct=await ensureAccount(userId);
    const positions=await this.getPositions(userId);
    const marketValueTWD=positions.reduce((sum,pos)=>sum+pos.marketValueTWD,0);
    const unrealizedPnlTWD=positions.reduce((sum,pos)=>sum+pos.unrealizedPnlTWD,0);
    return {
      userId,cashTWD:acct.cashTWD,reservedCashTWD:acct.reservedCashTWD??0,
      availableCashTWD:acct.cashTWD-(acct.reservedCashTWD??0),
      marketValueTWD,totalValueTWD:acct.cashTWD+marketValueTWD,unrealizedPnlTWD
    };
  }
}
export const getBroker=():MockBroker=>new MockBroker();
