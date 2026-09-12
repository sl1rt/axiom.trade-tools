import { describe, expect, it, vi } from 'vitest';
import { aggregate, tokenKey } from '../../src/core';
import { UiError } from '../../src/ui-errors';
import { newScan, ScanRunner } from '../../src/runner';
import type { DataSource, ScanState } from '../../src/types';
import { context, evm, historyToken } from '../fixtures';
function fixture() {
  const buyers = [100, 101, 102].map((n) => ({
    address: evm(n),
    firstBuyAt: n,
    tradeId: String(n),
  }));
  const source: DataSource = {
    getContext: vi.fn(async (c) => c),
    getBuyers: vi.fn(async (_c, _l, _s, progress, visit) => {
      for (let i = 0; i < buyers.length; i++) {
        progress(i + 1);
        await visit?.(buyers[i]!);
      }
      return { buyers, complete: true };
    }),
    getHistory: vi.fn(async (_c, w) => ({
      tokens: w === evm(102) ? [] : [historyToken(2)],
      empty: w === evm(102),
    })),
    getQuote: vi.fn(async () => ({
      usd: 50_000,
      fetchedAt: Date.now(),
      source: 'axiom-page-ath' as const,
    })),
  };
  const state = newScan(context(), { walletLimit: 3, tokensPerWallet: 5 });
  return { source, state };
}
const execute = (source: DataSource, state: ScanState) =>
  new ScanRunner(source, async () => {}, 0).run(state, new AbortController().signal);
describe('UI scan lifecycle', () => {
  it('excludes Fresh before reading History and continues without replacing the sampled wallet', async () => {
    const { source, state } = fixture();
    state.buyers = [100, 101, 102].map((n) => ({
      address: evm(n),
      firstBuyAt: n,
      tradeId: String(n),
      fresh: n === 100,
    }));
    state.buyersCollected = true;
    state.selectionComplete = true;
    await execute(source, state);
    expect(state.status).toBe('complete');
    expect(state.buyers).toHaveLength(3);
    expect(state.wallets[0]).toMatchObject({
      status: 'excluded',
      exclusionReason: 'fresh',
      tokens: [],
    });
    expect(source.getHistory).toHaveBeenCalledTimes(2);
    expect(source.getHistory).not.toHaveBeenCalledWith(
      state.context,
      evm(100),
      expect.anything(),
      expect.anything(),
    );
    expect(aggregate(state)[0]).toMatchObject({ count: 1, percentage: 100, wallets: [evm(101)] });
  });
  it('distinguishes a nonempty History with no other purchases from an empty History', async () => {
    const { source, state } = fixture();
    vi.mocked(source.getHistory).mockResolvedValueOnce({ tokens: [], empty: false });
    await execute(source, state);
    expect(state.wallets[0]?.exclusionReason).toBe('no-other-purchases');
    expect(state.wallets[2]?.exclusionReason).toBe('empty-history');
  });
  it('reads each open modal once, excludes empty without replacement and reads shared cap once', async () => {
    const { source, state } = fixture();
    await execute(source, state);
    expect(state.status).toBe('complete');
    expect(state.wallets.map((w) => w.status)).toEqual(['included', 'included', 'excluded']);
    expect(aggregate(state)[0]).toMatchObject({
      count: 2,
      percentage: 100,
      quote: { usd: 50_000 },
    });
    expect(source.getHistory).toHaveBeenCalledTimes(3);
    expect(source.getQuote).toHaveBeenCalledTimes(1);
  });
  it('saves during buyer selection and resumes without rereading completed History', async () => {
    const { source, state } = fixture();
    const controller = new AbortController();
    let saved = state;
    await new ScanRunner(
      source,
      async (next) => {
        saved = next;
        if (next.wallets.length === 1) controller.abort();
      },
      0,
    ).run(state, controller.signal);
    expect(saved.status).toBe('paused');
    expect(saved.buyersCollected).toBe(false);
    expect(saved.wallets).toHaveLength(1);
    await execute(source, saved);
    expect(saved.status).toBe('complete');
    expect(source.getHistory).toHaveBeenCalledTimes(3);
    expect(source.getBuyers).toHaveBeenCalledTimes(2);
  });
  it('keeps failed wallets separate from empty and retries once on resume', async () => {
    const { source, state } = fixture();
    vi.mocked(source.getHistory).mockRejectedValueOnce(new Error('unavailable'));
    await execute(source, state);
    expect(state.wallets[0]?.status).toBe('error');
    expect(aggregate(state)[0]?.count).toBe(1);
    await execute(source, state);
    expect(state.wallets.some((w) => w.status === 'error')).toBe(false);
    expect(aggregate(state)[0]?.count).toBe(2);
    expect(source.getHistory).toHaveBeenCalledTimes(4);
  });
  it('pauses on changed UI instead of excluding the wallet', async () => {
    const { source, state } = fixture();
    vi.mocked(source.getHistory).mockRejectedValue(new UiError('History changed'));
    await execute(source, state);
    expect(state.wallets).toHaveLength(0);
    expect(state.buyers).toHaveLength(1);
    expect(state.status).toBe('paused');
    expect(source.getHistory).toHaveBeenCalledTimes(1);
  });
  it('preserves counts when token page has no cap', async () => {
    const { source, state } = fixture();
    vi.mocked(source.getQuote).mockRejectedValue(new Error('no displayed cap'));
    await execute(source, state);
    expect(aggregate(state)[0]).toMatchObject({
      count: 2,
      quote: { usd: null, error: 'no displayed cap' },
    });
    expect(state.message).toContain('неполные');
  });
  it('reads new caps while buyers are still being collected and wakes an empty queue', async () => {
    const { source, state } = fixture();
    const buyers = [100, 101, 102].map((n) => ({
      address: evm(n),
      firstBuyAt: n,
      tradeId: String(n),
    }));
    const earlyQuotes: number[] = [];
    vi.mocked(source.getHistory).mockImplementation(async (_c, wallet) => ({
      tokens: wallet === evm(101) ? [historyToken(2), historyToken(3)] : [historyToken(2)],
      empty: false,
    }));
    vi.mocked(source.getBuyers).mockImplementation(async (_c, _l, _s, _progress, visit) => {
      await visit?.(buyers[0]!);
      await vi.waitFor(() => expect(state.quotes[tokenKey(historyToken(2))]?.usd).toBe(50000), {
        timeout: 300,
      });
      earlyQuotes.push(Object.keys(state.quotes).length);
      expect(state.buyersCollected).toBe(false);
      await visit?.(buyers[1]!);
      await vi.waitFor(() => expect(state.quotes[tokenKey(historyToken(3))]?.usd).toBe(50000), {
        timeout: 300,
      });
      earlyQuotes.push(Object.keys(state.quotes).length);
      await visit?.(buyers[2]!);
      return { buyers, complete: true };
    });
    await execute(source, state);
    expect(earlyQuotes).toEqual([1, 2]);
    expect(state.status).toBe('complete');
    expect(source.getQuote).toHaveBeenCalledTimes(2);
  });
});

it('loads at most three caps concurrently and serializes checkpoints without losing quotes', async () => {
  const { source, state } = fixture();
  const buyer = { address: evm(100), firstBuyAt: 0, tradeId: 'tx' };
  state.buyers = [buyer];
  state.buyersCollected = true;
  state.selectionComplete = true;
  state.wallets = [
    {
      buyer,
      tokens: [2, 3, 4, 5, 6].map((n) => historyToken(n)),
      status: 'included',
      fetchedAt: 0,
    },
  ];
  let active = 0,
    maximum = 0,
    saving = 0,
    maxSaving = 0;
  let persisted: ScanState = state;
  vi.mocked(source.getQuote).mockImplementation(async (token) => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, token.address === evm(2) ? 50 : 10));
    active--;
    return { usd: 50000, fetchedAt: Date.now(), source: 'axiom-page-ath' };
  });
  await new ScanRunner(source, async (next) => {
    saving++;
    maxSaving = Math.max(maxSaving, saving);
    await new Promise((resolve) => setTimeout(resolve, 5));
    persisted = next;
    saving--;
  }).run(state, new AbortController().signal);
  expect(maximum).toBe(3);
  expect(maxSaving).toBe(1);
  expect(persisted.status).toBe('complete');
  expect(Object.keys(persisted.quotes)).toHaveLength(5);
});

it.each([1, 3])(
  'reprioritizes pending caps by unique wallets while %i readers are active',
  async (concurrency) => {
    const { source, state } = fixture();
    state.options.tokensPerWallet = 6;
    const buyers = [100, 101, 102].map((n) => ({
      address: evm(n),
      firstBuyAt: n,
      tradeId: String(n),
    }));
    const started: string[] = [];
    const release = new Map<string, () => void>();
    const blocked = [2, 3, 4].slice(0, concurrency).map(evm);
    vi.mocked(source.getHistory).mockImplementation(async (_context, wallet) => ({
      tokens: (wallet === evm(100)
        ? [2, 3, 4, 5, 6, 7]
        : wallet === evm(101)
          ? [6, 6, 7]
          : [7]
      ).map((n) => historyToken(n)),
      empty: false,
    }));
    vi.mocked(source.getQuote).mockImplementation(async (token) => {
      started.push(token.address);
      if (blocked.includes(token.address))
        await new Promise<void>((resolve) => release.set(token.address, resolve));
      if (token.address === evm(5)) for (const resolve of release.values()) resolve();
      return { usd: 50000, fetchedAt: Date.now(), source: 'axiom-page-ath' };
    });
    vi.mocked(source.getBuyers).mockImplementation(async (_c, _l, _s, _progress, visit) => {
      for (const buyer of buyers) await visit?.(buyer);
      // All readers are busy when newer histories promote T7 (3 wallets), then T6 (2).
      release.get(evm(2))!();
      return { buyers, complete: true };
    });
    await new ScanRunner(source, async () => {}, 0, concurrency).run(
      state,
      new AbortController().signal,
    );
    expect(started).toEqual((concurrency === 3 ? [2, 3, 4, 7, 6, 5] : [2, 7, 6, 3, 4, 5]).map(evm));
    expect(new Set(started).size).toBe(6);
    expect(state.status).toBe('complete');
  },
);
it('pause aborts all in-flight quotes and does not start queued tokens', async () => {
  const { source, state } = fixture();
  const controller = new AbortController();
  const buyer = { address: evm(100), firstBuyAt: 0, tradeId: 'tx' };
  state.buyers = [buyer];
  state.buyersCollected = true;
  state.selectionComplete = true;
  state.wallets = [
    {
      buyer,
      tokens: [2, 3, 4, 5, 6].map((n) => historyToken(n)),
      status: 'included',
      fetchedAt: 0,
    },
  ];
  let started = 0,
    cancelled = 0;
  vi.mocked(source.getQuote).mockImplementation(async (_token, signal) => {
    started++;
    return await new Promise((_resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => {
          cancelled++;
          reject(new DOMException('aborted', 'AbortError'));
        },
        { once: true },
      );
      if (started === 3) setTimeout(() => controller.abort(), 0);
    });
  });
  await new ScanRunner(source, async () => {}).run(state, controller.signal);
  expect(started).toBe(3);
  expect(cancelled).toBe(3);
  expect(state.status).toBe('paused');
  expect(state.quotes).toEqual({});
});

it('a changed wallet UI cancels simultaneous caps and preserves the completed wallet', async () => {
  const { source, state } = fixture();
  let cancelled = 0;
  vi.mocked(source.getHistory)
    .mockResolvedValueOnce({ tokens: [historyToken(2), historyToken(3)], empty: false })
    .mockRejectedValueOnce(new UiError('History changed'));
  vi.mocked(source.getQuote).mockImplementation(
    async (_token, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            cancelled++;
            reject(new DOMException('aborted', 'AbortError'));
          },
          { once: true },
        );
      }),
  );
  await execute(source, state);
  expect(cancelled).toBe(2);
  expect(state.status).toBe('paused');
  expect(state.message).toBe('History changed');
  expect(state.wallets).toHaveLength(1);
  expect(state.wallets[0]?.status).toBe('included');
  expect(state.quotes).toEqual({});
});
