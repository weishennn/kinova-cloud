export const INVESTMENT_TRADE_REQUEST_EVENT = 'cashflow:investment-trade-request';

export type InvestmentTradeAction = 'BUY' | 'SELL';

export function requestInvestmentTrade(action: InvestmentTradeAction) {
  window.dispatchEvent(new CustomEvent(INVESTMENT_TRADE_REQUEST_EVENT, { detail: { action } }));
}
