import type {
  Buyer,
  Chain,
  HistoryToken,
  ResultRow,
  ScanOptions,
  ScanState,
  TokenContext,
  TokenRef,
  Trade,
} from './types';

export function addressOf(chain: Chain, value: unknown): string {
  if (
    typeof value !== 'string' ||
    !(chain !== 'sol' ? /^0x[0-9a-fA-F]{40}$/ : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/).test(value)
  )
    throw new Error(`Некорректный полный адрес ${chain.toUpperCase()}`);
  return chain !== 'sol' ? value.toLowerCase() : value;
}
export function tokenKey(token: Pick<TokenRef, 'chain' | 'address'>): string {
  return `${token.chain}:${addressOf(token.chain, token.address)}`;
}
export function validateOptions(options: ScanOptions): ScanOptions {
  if (
    !Number.isInteger(options.walletLimit) ||
    options.walletLimit < 1 ||
    options.walletLimit > 200 ||
    !Number.isInteger(options.tokensPerWallet) ||
    options.tokensPerWallet < 1 ||
    options.tokensPerWallet > 20
  )
    throw new Error('Допустимо 1–200 кошельков и 1–20 токенов.');
  return { ...options };
}
export function uniqueBuyers(trades: Trade[], limit: number): Buyer[] {
  const found = new Map<string, Buyer>();
  for (const trade of trades) {
    if (trade.type !== 'buy' || found.has(trade.wallet)) continue;
    found.set(trade.wallet, { address: trade.wallet, firstBuyAt: trade.at, tradeId: trade.id });
    if (found.size === limit) break;
  }
  return [...found.values()];
}
export function selectHistory(
  tokens: HistoryToken[],
  original: TokenRef,
  limit: number,
): HistoryToken[] {
  const found = new Map<string, HistoryToken>();
  for (const token of tokens) {
    const key = tokenKey(token);
    if (
      token.chain !== original.chain ||
      key === tokenKey(original) ||
      !(token.bought ?? ((token.buyCount ?? 0) > 0 && (token.tokensBought ?? 0) > 0)) ||
      found.has(key)
    )
      continue;
    found.set(key, token);
    if (found.size === limit) break;
  }
  return [...found.values()];
}
export function aggregate(state: Pick<ScanState, 'wallets' | 'quotes'>): ResultRow[] {
  const included = new Map(
    state.wallets.filter((w) => w.status === 'included').map((w) => [w.buyer.address, w]),
  );
  const rows = new Map<string, ResultRow>();
  for (const wallet of included.values()) {
    for (const token of wallet.tokens) {
      const key = tokenKey(token);
      const row = rows.get(key) ?? {
        token,
        wallets: [],
        count: 0,
        percentage: 0,
        quote: state.quotes[key],
      };
      if (!row.wallets.includes(wallet.buyer.address)) row.wallets.push(wallet.buyer.address);
      rows.set(key, row);
    }
  }
  return [...rows.values()]
    .map((row) => ({
      ...row,
      count: row.wallets.length,
      percentage: included.size ? (row.wallets.length / included.size) * 100 : 0,
    }))
    .sort((a, b) => b.count - a.count || tokenKey(a.token).localeCompare(tokenKey(b.token)));
}
export function contextFromUrl(pageUrl: string): TokenContext | null {
  const url = new URL(pageUrl);
  if (url.hostname !== 'axiom.trade' || url.protocol !== 'https:') return null;
  const match = url.pathname.match(/^\/(token|meme)\/([^/]+)\/?$/);
  if (!match) return null;
  const explicit = url.searchParams.get('chain');
  if (explicit && !['bnb', 'sol', 'robinhood'].includes(explicit)) return null;
  const chain: Chain = (explicit as Chain) || (match[1] === 'meme' ? 'sol' : 'bnb');
  try {
    const value = addressOf(chain, match[2]);
    if (match[1] === 'meme' && chain !== 'sol') return null;
    return {
      chain,
      address: value,
      pairAddress: match[1] === 'meme' ? value : undefined,
      scope: match[1] === 'meme' ? 'pair' : 'token',
      pageUrl,
      symbol: '',
      name: '',
    };
  } catch {
    return null;
  }
}
export function tokenUrl(token: TokenRef): string {
  const path =
    token.chain === 'sol' && token.pairAddress
      ? `/meme/${addressOf('sol', token.pairAddress)}`
      : `/token/${addressOf(token.chain, token.address)}`;
  return `https://axiom.trade${path}?chain=${token.chain}`;
}
export function pageIdentity(context: TokenContext): string {
  return `${context.chain}:${context.scope}:${context.scope === 'pair' ? context.pairAddress : context.address}`;
}
export function abortError(): Error {
  return new DOMException('Сканирование приостановлено', 'AbortError');
}
export function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}
export async function delay(ms: number, signal: AbortSignal): Promise<void> {
  checkAbort(signal);
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      signal.removeEventListener('abort', stop);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener('abort', stop, { once: true });
  });
}
