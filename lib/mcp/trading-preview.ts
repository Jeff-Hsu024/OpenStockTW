import { calcFee, calcTax, type OrderSide, type OrderType } from "@/lib/trading/types";

export interface OrderPreviewInput {
  symbol: string;
  side: OrderSide;
  qty: number;
  orderType: OrderType;
  limitPrice?: number;
  lastPrice: number;
  quoteTimestamp?: number;
  cashTWD: number;
  heldQty: number;
}

/** Indicative mock fill estimate; NOT a real market execution quote. */
export function previewPaperOrder(input: OrderPreviewInput) {
  const qty = input.qty;
  if (!Number.isSafeInteger(qty) || qty <= 0) throw new Error("qty must be a positive integer");
  if (!Number.isFinite(input.lastPrice) || input.lastPrice <= 0) throw new Error("No valid quote");
  if (input.orderType === "limit" && !(Number(input.limitPrice) > 0)) {
    throw new Error("A positive limitPrice is required for limit orders");
  }
  const price = input.lastPrice;
  const marketable = input.orderType === "market" ||
    (input.side === "buy" ? input.limitPrice! >= price : input.limitPrice! <= price);
  const grossTWD = price * qty;
  const estimatedFeeTWD = calcFee(grossTWD);
  const estimatedTaxTWD = input.side === "sell" ? calcTax(grossTWD) : 0;
  const cashEffectTWD = input.side === "buy"
    ? -(grossTWD + estimatedFeeTWD)
    : grossTWD - estimatedFeeTWD - estimatedTaxTWD;
  const sufficientFunds = input.side !== "buy" || input.cashTWD >= -cashEffectTWD;
  const sufficientPosition = input.side !== "sell" || input.heldQty >= qty;

  return {
    symbol: input.symbol, side: input.side, qty,
    orderType: input.orderType, limitPrice: input.limitPrice,
    quoteTimestamp: input.quoteTimestamp,
    indicativePriceTWD: price, grossTWD, estimatedFeeTWD, estimatedTaxTWD,
    estimatedCashEffectTWD: cashEffectTWD,
    wouldFillImmediatelyInMock: marketable,
    sufficientFunds, sufficientPosition,
    canSubmitToMock: sufficientFunds && sufficientPosition,
    warning: "Paper trading only. The indicative TWSE/TPEx quote may be delayed; mock fills are not realistic live executions."
  };
}
