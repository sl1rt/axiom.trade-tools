import { describe, expect, it } from 'vitest';
import {
  addressOf,
  aggregate,
  contextFromUrl,
  selectHistory,
  tokenKey,
  uniqueBuyers,
  validateOptions,
} from '../../src/core';

import { context, evm, historyToken, sol, trade } from '../fixtures';

describe('selection and aggregation', () => {
  it('takes 50 unique BUY wallets, ignoring earlier sells and repeated buys', () => {
    const feed = [
      trade(0, 999, 'sell'),
      ...Array.from({ length: 60 }, (_, i) => [
        trade(i * 2 + 1, i + 100),
        trade(i * 2 + 2, i + 100),
      ]).flat(),
    ];
    const buyers = uniqueBuyers(feed, 50);
    expect(buyers).toHaveLength(50);
    expect(buyers[0]?.address).toBe(evm(100));
    expect(buyers.at(-1)?.address).toBe(evm(149));
  });
  it('takes five other unique bought tokens in newest Opened order', () => {
    const rows = [
      historyToken(9),
      historyToken(9),
      { ...historyToken(8), buyCount: 0 },
      ...Array.from({ length: 7 }, (_, i) => historyToken(7 - i)),
    ];
    expect(selectHistory(rows, context(), 5).map((t) => t.address)).toEqual(
      [9, 7, 6, 5, 4].map(evm),
    );
  });
  it('uses 1–4 other tokens; zero other tokens stays empty', () => {
    expect(selectHistory([historyToken(1), historyToken(2)], context(), 5)).toHaveLength(1);
    expect(selectHistory([historyToken(1)], context(), 5)).toEqual([]);
  });
  it('counts each wallet once per full token address and excludes empty/failed wallets from the denominator', () => {
    const wallet = (
      n: number,
      tokens: ReturnType<typeof historyToken>[],
      status: 'included' | 'excluded' | 'error' = 'included',
    ) => ({
      buyer: { address: evm(n), firstBuyAt: 0, tradeId: String(n) },
      tokens,
      status,
      fetchedAt: 0,
    });
    const wallets = [
      wallet(100, [historyToken(2), historyToken(2), { ...historyToken(3), symbol: 'T2' }]),
      wallet(101, [historyToken(2)]),
      wallet(102, [historyToken(4)]),
      wallet(103, [], 'excluded'),
      wallet(104, [], 'error'),
    ];
    const rows = aggregate({ wallets, quotes: {} });
    expect(rows).toHaveLength(3);
    expect(rows[0]?.count).toBe(2);
    expect(rows[0]?.percentage).toBeCloseTo(200 / 3);
    expect(rows[0]?.wallets).toEqual([evm(100), evm(101)]);
  });
  it('keeps networks and case-sensitive Solana addresses separate', () => {
    expect(addressOf('bnb', '0x' + 'AB'.repeat(20))).toBe('0x' + 'ab'.repeat(20));
    expect(addressOf('sol', sol(1))).toBe(sol(1));
    expect(tokenKey(historyToken(2, 'bnb'))).not.toBe(tokenKey(historyToken(2, 'robinhood')));
    expect(selectHistory([historyToken(2, 'robinhood')], context('bnb'), 5)).toEqual([]);
  });
  it.each(['bnb', 'sol', 'robinhood'] as const)('recognizes %s token pages', (chain) => {
    const ctx = context(chain);
    expect(contextFromUrl(ctx.pageUrl)?.chain).toBe(chain);
  });
  it('ignores unrelated, unsupported-chain and shortened-address pages', () => {
    expect(contextFromUrl('https://axiom.trade/pulse')).toBeNull();
    expect(contextFromUrl(`https://axiom.trade/token/${evm(1)}?chain=base`)).toBeNull();
    expect(contextFromUrl('https://axiom.trade/token/0x123')).toBeNull();
  });
  it.each([
    { walletLimit: 0, tokensPerWallet: 5 },
    { walletLimit: 50, tokensPerWallet: NaN },
    { walletLimit: 201, tokensPerWallet: 5 },
    { walletLimit: 1.5, tokensPerWallet: 5 },
  ])('rejects invalid limits: %j', (options) => expect(() => validateOptions(options)).toThrow());
});
