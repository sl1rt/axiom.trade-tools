import { addressOf, pageIdentity, validateOptions } from './core';
import type { ScanState, TokenContext } from './types';
// Older scans may contain oldest histories or Fresh wallets; keep them untouched.
const key = (context: TokenContext) => `ew.ui.scan.newest.no-fresh.${pageIdentity(context)}`;
export async function saveScan(state: ScanState): Promise<void> {
  await chrome.storage.local.set({ [key(state.context)]: state });
}
export async function loadScan(context: TokenContext): Promise<ScanState | null> {
  const data = await chrome.storage.local.get(key(context));
  const value = structuredClone(data[key(context)]) as ScanState | undefined;
  if (!value) return null;
  try {
    const legacyCurrentMc = (value as { version: number }).version === 4;
    if (
      (!legacyCurrentMc && (value.version !== 5 || value.quoteMetric !== 'ath-market-cap')) ||
      value.historyOrder !== 'newest' ||
      value.excludeFresh !== true ||
      pageIdentity(value.context) !== pageIdentity(context) ||
      !Array.isArray(value.buyers) ||
      !Array.isArray(value.wallets) ||
      !value.quotes ||
      typeof value.quotes !== 'object' ||
      Array.isArray(value.quotes) ||
      typeof value.id !== 'string'
    )
      return null;
    if (
      !['collecting', 'wallets', 'quotes', 'paused', 'complete', 'error'].includes(value.status) ||
      !Number.isFinite(value.startedAt) ||
      !Number.isFinite(value.updatedAt) ||
      typeof value.buyersCollected !== 'boolean' ||
      typeof value.selectionComplete !== 'boolean'
    )
      return null;
    validateOptions(value.options);
    addressOf(context.chain, value.context.address);
    const buyers = new Set<string>();
    for (const buyer of value.buyers) {
      addressOf(context.chain, buyer.address);
      if (
        buyers.has(buyer.address) ||
        !Number.isFinite(buyer.firstBuyAt) ||
        typeof buyer.tradeId !== 'string' ||
        (buyer.fresh !== undefined && typeof buyer.fresh !== 'boolean')
      )
        return null;
      buyers.add(buyer.address);
    }
    const processed = new Set<string>();
    for (const wallet of value.wallets) {
      addressOf(context.chain, wallet.buyer.address);
      if (
        !buyers.has(wallet.buyer.address) ||
        processed.has(wallet.buyer.address) ||
        !Array.isArray(wallet.tokens) ||
        !['included', 'excluded', 'error'].includes(wallet.status)
      )
        return null;
      processed.add(wallet.buyer.address);
      if ((wallet.status === 'included') !== wallet.tokens.length > 0) return null;
      const buyer = value.buyers.find((b) => b.address === wallet.buyer.address)!;
      if (!!buyer.fresh !== !!wallet.buyer.fresh) return null;
      if (buyer.fresh && (wallet.status !== 'excluded' || wallet.exclusionReason !== 'fresh'))
        return null;
      if (wallet.status === 'excluded') {
        if (
          !['fresh', 'empty-history', 'no-other-purchases'].includes(wallet.exclusionReason ?? '')
        )
          return null;
        if ((wallet.exclusionReason === 'fresh') !== !!buyer.fresh) return null;
      } else if (wallet.exclusionReason !== undefined) return null;
      for (const token of wallet.tokens) {
        if (
          token.chain !== context.chain ||
          !Number.isFinite(token.openedAt) ||
          !(token.bought ?? ((token.buyCount ?? 0) > 0 && (token.tokensBought ?? 0) > 0))
        )
          return null;
        addressOf(token.chain, token.address);
        if (token.pairAddress) addressOf(token.chain, token.pairAddress);
      }
    }
    if (legacyCurrentMc) {
      // Keep compatible newest/Fresh-filtered histories and only replace current MC.
      value.version = 5;
      value.quoteMetric = 'ath-market-cap';
      value.quotes = {};
      value.status = 'paused';
      value.message = 'History сохранена. Нажмите «Продолжить», чтобы собрать ATH капитализации.';
    }
    for (const quote of Object.values(value.quotes))
      if (
        !quote ||
        !Number.isFinite(quote.fetchedAt) ||
        quote.source !== 'axiom-page-ath' ||
        (quote.usd !== null && (!Number.isFinite(quote.usd) || quote.usd <= 0))
      )
        return null;
    if (['collecting', 'wallets', 'quotes'].includes(value.status)) {
      value.status = 'paused';
      value.message = 'Предыдущий запуск прерван. Можно продолжить.';
    }
    return value;
  } catch {
    return null;
  }
}
