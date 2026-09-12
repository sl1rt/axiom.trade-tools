export type Chain = 'bnb' | 'sol' | 'robinhood';
export interface TokenRef {
  chain: Chain;
  address: string;
  pairAddress?: string;
  symbol: string;
  name: string;
}
export interface TokenContext extends TokenRef {
  pageUrl: string;
  scope: 'token' | 'pair';
}
export interface Trade {
  id: string;
  wallet: string;
  type: 'buy' | 'sell' | 'add' | 'remove';
  at: number;
}
export interface Buyer {
  address: string;
  firstBuyAt: number;
  tradeId: string;
  firstBuyLabel?: string;
  firstBuyTotalLabel?: string;
  firstBuyAmountLabel?: string;
  fresh?: boolean;
}
export interface HistoryToken extends TokenRef {
  openedAt: number;
  openedLabel?: string;
  bought?: boolean;
  buyCount: number | null;
  tokensBought: number | null;
}
export interface HistoryPage {
  tokens: HistoryToken[];
  nextCursor: string | null;
}
export interface WalletHistory {
  tokens: HistoryToken[];
  empty: boolean;
}
export interface Quote {
  usd: number | null;
  fetchedAt: number;
  source: 'axiom-page-ath';
  error?: string;
}
export interface WalletResult {
  buyer: Buyer;
  status: 'included' | 'excluded' | 'error';
  tokens: HistoryToken[];
  error?: string;
  fetchedAt: number;
  exclusionReason?: 'fresh' | 'empty-history' | 'no-other-purchases';
}
export interface ResultRow {
  token: TokenRef;
  wallets: string[];
  count: number;
  percentage: number;
  quote?: Quote;
}
export interface ScanOptions {
  walletLimit: number;
  tokensPerWallet: number;
}
export interface ScanState {
  version: 5;
  quoteMetric: 'ath-market-cap';
  historyOrder: 'newest';
  excludeFresh: true;
  id: string;
  context: TokenContext;
  options: ScanOptions;
  status: 'collecting' | 'wallets' | 'quotes' | 'paused' | 'complete' | 'error';
  startedAt: number;
  updatedAt: number;
  buyers: Buyer[];
  buyersCollected: boolean;
  selectionComplete: boolean;
  selectionNote?: string;
  wallets: WalletResult[];
  quotes: Record<string, Quote>;
  message: string;
}
export type ApiReply =
  | { ok: true; data: unknown }
  | { ok: false; error: string; status?: number; retryAfterMs?: number };
export interface DataSource {
  getContext(context: TokenContext, signal: AbortSignal): Promise<TokenContext>;
  getBuyers(
    context: TokenContext,
    limit: number,
    signal: AbortSignal,
    progress: (count: number) => void,
    visit?: (buyer: Buyer) => Promise<void>,
  ): Promise<{ buyers: Buyer[]; complete: boolean; note?: string }>;
  getHistory(
    context: TokenContext,
    wallet: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<WalletHistory>;
  getQuote(token: TokenRef, signal: AbortSignal): Promise<Quote>;
}
