import { afterEach, expect, it, vi } from 'vitest';
import { loadScan } from '../../src/storage';
import { newScan } from '../../src/runner';
import { pageIdentity } from '../../src/core';
import { context, evm, historyToken } from '../fixtures';
afterEach(() => vi.unstubAllGlobals());
function stored() {
  const state = newScan(context(), { walletLimit: 50, tokensPerWallet: 5 });
  state.buyersCollected = true;
  const buyer = { address: evm(100), firstBuyAt: 1, tradeId: 'tx' };
  state.buyers = [buyer];
  state.wallets = [{ buyer, tokens: [historyToken(2)], status: 'included', fetchedAt: 1 }];
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async () => ({
          [`ew.ui.scan.newest.no-fresh.${pageIdentity(state.context)}`]: state,
        })),
      },
    },
  });
  return state;
}
it('restores interrupted scans as paused with completed wallet data', async () => {
  stored();
  const result = await loadScan(context());
  expect(result?.status).toBe('paused');
  expect(result?.wallets).toHaveLength(1);
});
it('migrates compatible histories and drops current MC before collecting ATH', async () => {
  const state = stored();
  Object.assign(state, {
    version: 4,
    quoteMetric: undefined,
    status: 'complete',
    quotes: { x: { usd: 50000, fetchedAt: 1, source: 'axiom-page' } },
  });
  const result = await loadScan(context());
  expect(result).toMatchObject({
    version: 5,
    quoteMetric: 'ath-market-cap',
    status: 'paused',
    quotes: {},
  });
  expect(result?.wallets).toEqual(state.wallets);
  expect(result?.message).toContain('ATH');
  expect(state.quotes).toHaveProperty('x');
});
it('rejects current MC masquerading as an ATH scan', async () => {
  const state = stored();
  Object.assign(state.quotes, { x: { usd: 50000, fetchedAt: 1, source: 'axiom-page' } });
  expect(await loadScan(context())).toBeNull();
});
it('does not resume legacy oldest histories from their old storage namespace', async () => {
  const legacy = { ...stored(), version: 2 };
  const legacyKey = `ew.ui.scan.${pageIdentity(legacy.context)}`;
  vi.stubGlobal('chrome', {
    storage: { local: { get: vi.fn(async () => ({ [legacyKey]: legacy })) } },
  });
  expect(await loadScan(context())).toBeNull();
  expect(chrome.storage.local.get).toHaveBeenCalledWith(
    `ew.ui.scan.newest.no-fresh.${pageIdentity(legacy.context)}`,
  );
  expect(legacy.wallets).toHaveLength(1);
});
it('rejects an old format or selection rule even in the newest namespace', async () => {
  Object.assign(stored(), { version: 2 });
  expect(await loadScan(context())).toBeNull();
  Object.assign(stored(), { historyOrder: 'oldest' });
  expect(await loadScan(context())).toBeNull();
  Object.assign(stored(), { version: 3 });
  expect(await loadScan(context())).toBeNull();
  Object.assign(stored(), { excludeFresh: false });
  expect(await loadScan(context())).toBeNull();
});
it('preserves Fresh exclusions and rejects Fresh wallets counted as included', async () => {
  const state = stored();
  state.buyers[0]!.fresh = true;
  expect(await loadScan(context())).toBeNull();
  state.wallets[0] = {
    buyer: state.buyers[0]!,
    tokens: [],
    status: 'excluded',
    exclusionReason: 'fresh',
    fetchedAt: 1,
  };
  expect((await loadScan(context()))?.wallets[0]?.exclusionReason).toBe('fresh');
});
it('rejects corrupt quotes and duplicate buyer entries', async () => {
  const first = stored();
  first.quotes.x = { usd: NaN, fetchedAt: 1, source: 'axiom-page-ath' };
  expect(await loadScan(context())).toBeNull();
  const second = stored();
  second.buyers.push(second.buyers[0]!);
  expect(await loadScan(context())).toBeNull();
});
it('rejects mismatched chain history and false empty-wallet states', async () => {
  const first = stored();
  first.wallets[0]!.tokens = [historyToken(2, 'robinhood')];
  expect(await loadScan(context())).toBeNull();
  const second = stored();
  second.wallets[0]!.status = 'excluded';
  expect(await loadScan(context())).toBeNull();
});
