import type { Chain, HistoryToken, TokenContext, Trade } from '../src/types';
// Synthetic public addresses and UI rows, never captured account data.
export const evm = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const base58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const sol = (n: number) =>
  'S'.repeat(30) + base58[Math.floor(n / 58) % 58]! + base58[n % 58]!;
export const addr = (chain: Chain, n: number) => (chain === 'sol' ? sol(n) : evm(n));
export const time = Date.parse('2026-09-01T00:00:00Z');
export function context(chain: Chain = 'bnb'): TokenContext {
  const address = addr(chain, 1),
    pairAddress = addr(chain, 900);
  return {
    chain,
    address,
    pairAddress,
    scope: chain === 'sol' ? 'pair' : 'token',
    pageUrl: `https://axiom.trade/${chain === 'sol' ? 'meme/' + pairAddress : 'token/' + address}?chain=${chain}`,
    symbol: 'SOURCE',
    name: 'Source token',
  };
}
export function historyToken(n: number, chain: Chain = 'bnb'): HistoryToken {
  return {
    chain,
    address: addr(chain, n),
    pairAddress: chain === 'sol' ? addr(chain, n + 900) : undefined,
    symbol: `T${n}`,
    name: `Token ${n}`,
    openedAt: time + n * 1000,
    buyCount: 1,
    tokensBought: 100,
  };
}
export function trade(
  n: number,
  wallet: number,
  type: Trade['type'] = 'buy',
  chain: Chain = 'bnb',
): Trade {
  return { id: `tx${n}`, wallet: addr(chain, wallet), type, at: time + n * 1000 };
}
