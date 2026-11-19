import { describe, expect, it } from "vitest";
import { isAuthorizedMcpRequest } from "@/lib/mcp/auth";
import { previewPaperOrder } from "@/lib/mcp/trading-preview";

const TEST_TOKEN = "a".repeat(48);
describe("MCP bearer authentication", () => {
  it("rejects absent, short and incorrect credentials", () => {
    expect(isAuthorizedMcpRequest(new Request("http://localhost/api/mcp"), TEST_TOKEN)).toBe(false);
    expect(isAuthorizedMcpRequest(new Request("http://localhost/api/mcp", {
      headers: { authorization: "Bearer " + "b".repeat(48) }
    }), TEST_TOKEN)).toBe(false);
    expect(isAuthorizedMcpRequest(new Request("http://localhost/api/mcp", {
      headers: { authorization: "Bearer 123" }
    }), "123")).toBe(false);
  });
  it("accepts only the exact bearer token", () => {
    const request = new Request("http://localhost/api/mcp", {
      headers: { Authorization: "Bearer " + TEST_TOKEN }
    });
    expect(isAuthorizedMcpRequest(request, TEST_TOKEN)).toBe(true);
  });
});
describe("Paper order preview", () => {
  const base = {
    symbol: "TWSE:2330", side: "buy" as const, qty: 100,
    orderType: "market" as const, lastPrice: 100, cashTWD: 100_000, heldQty: 0
  };
  it("estimates fee without changing cash", () => {
    const preview = previewPaperOrder(base);
    expect(preview.estimatedFeeTWD).toBe(20);
    expect(preview.estimatedCashEffectTWD).toBe(-10020);
    expect(preview.canSubmitToMock).toBe(true);
  });
  it("rejects insufficient funds and invalid qty", () => {
    expect(previewPaperOrder({ ...base, cashTWD: 100 }).canSubmitToMock).toBe(false);
    expect(() => previewPaperOrder({ ...base, qty: 0 })).toThrow();
  });
  it("estimates seller tax and checks position", () => {
    const preview = previewPaperOrder({ ...base, side: "sell", heldQty: 50 });
    expect(preview.estimatedTaxTWD).toBe(30);
    expect(preview.canSubmitToMock).toBe(false);
  });
  it("identifies a resting limit order", () => {
    expect(previewPaperOrder({ ...base, orderType: "limit", limitPrice: 90 }).wouldFillImmediatelyInMock).toBe(false);
  });
});
