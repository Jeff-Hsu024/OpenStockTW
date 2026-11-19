export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit";
export type OrderStatus = "pending" | "filled" | "cancelled" | "rejected";
export interface Order {
  id: string;
  userId: string;
  clientOrderId?: string;
  symbol: string;
  side: OrderSide;
  qty: number;
  orderType: OrderType;
  limitPrice?: number;
  status: OrderStatus;
  rejectReason?: string;
  createdAt: Date;
  filledAt?: Date;
  fillPrice?: number;
  fee?: number;
  tax?: number;
}
export interface Position {
  userId: string;
  symbol: string;
  qty: number;
  avgCost: number;
  reservedQty?: number;
}
export interface Account {
  userId: string;
  cashTWD: number;
  reservedCashTWD?: number;
}
export const FEE_RATE = 0.001425;
export const FEE_MIN_TWD = 20;
export const TAX_RATE_SELL = 0.003;
export const STARTING_CASH_TWD = 1_000_000;
export const calcFee = (amount: number) => Math.max(Math.round(amount * FEE_RATE), FEE_MIN_TWD);
export const calcTax = (amount: number) => Math.round(amount * TAX_RATE_SELL);
export interface PlaceOrderInput {
  symbol: string;
  side: OrderSide;
  qty: number;
  orderType: OrderType;
  limitPrice?: number;
  clientOrderId?: string;
}
