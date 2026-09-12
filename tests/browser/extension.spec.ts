import { test as base, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { Chain } from '../../src/types';
import { addr, context, historyToken } from '../fixtures';
import { newScan } from '../../src/runner';
import { pageIdentity } from '../../src/core';
import { axiomPage, marketCapHeader } from '../ui-fixture';
const test = base.extend<{ extension: BrowserContext }>({
  extension: async ({}, use, info) => {
    const extension = await chromium.launchPersistentContext(info.outputPath('profile'), {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1360, height: 960 },
      args: [
        `--disable-extensions-except=${resolve('dist')}`,
        `--load-extension=${resolve('dist')}`,
      ],
    });
    await use(extension);
    await extension.close();
  },
});
async function setup(
  extension: BrowserContext,
  chain: Chain,
  broken = false,
  virtual = false,
  behaviour: {
    slowHistoryMs?: number;
    slowImage?: boolean;
    missingQuote?: boolean;
    emptyWallet?: boolean;
    emptyNoHeader?: boolean;
    transientEmptyMs?: number;
    closeDelayMs?: number;
    headerQuote?: boolean;
    holdSecondHistory?: boolean;
    initialOpened?: 'Opened' | 'Opened ↑' | 'Opened ↓';
    freshWallet?: boolean;
    zeroBought?: boolean;
    slowAthMs?: number;
    searchMode?: 'missing' | 'wrong-result' | 'wrong-modal' | 'wrong-chain';
    searchDelayMs?: number;
  } = {},
) {
  const unexpected: string[] = [];
  const images = { requested: 0, finished: 0 };
  extension.on('request', (request) => {
    const u = new URL(request.url());
    if (u.hostname.endsWith('.axiom.trade')) unexpected.push(request.url());
  });
  await extension.route('https://axiom.trade/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/slow-image.png') {
      images.requested++;
      await new Promise((resolve) => setTimeout(resolve, 8000));
      images.finished++;
      await route.fulfill({ status: 204 }).catch(() => {});
      return;
    }
    if (url.pathname.startsWith('/images/')) {
      await route.fulfill({ status: 204 });
      return;
    }
    const n =
      [2, 3].find(
        (i) => url.pathname.includes(addr(chain, i)) || url.pathname.includes(addr(chain, 900 + i)),
      ) ?? 1;
    let body = axiomPage(chain, n, broken, virtual, behaviour.slowHistoryMs, behaviour);
    if (n !== 1 && behaviour.headerQuote)
      body = body
        .replace(/<title>.*?<\/title>/, '<title>Axiom</title>')
        .replace(marketCapHeader('$50K', '$125K'), marketCapHeader());
    if (n !== 1 && behaviour.slowImage)
      body = body.replace('</body>', '<img src="/slow-image.png"></body>');
    if (n !== 1 && behaviour.missingQuote) body = body.replace('$125K', '—');
    if (n !== 1 && behaviour.slowAthMs) {
      body = body.replace('$125K', '—').replace(
        '</body>',
        `<script>setTimeout(() => {
        const label = [...document.querySelectorAll('.token-summary span')].find(el => el.textContent === 'ATH');
        label.nextElementSibling.innerHTML = '<span>$125K</span>';
      }, ${behaviour.slowAthMs});</script></body>`,
      );
    }
    await route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body,
    });
  });
  const page = await extension.newPage();
  await page.goto(context(chain).pageUrl);
  await page.getByRole('button', { name: 'Early Wallets', exact: false }).click();
  await page.getByRole('spinbutton', { name: 'Кошельков', exact: true }).fill('3');
  // Native tabs.create can navigate before Playwright attaches its network route.
  // Start test helper tabs locally, carrying their actual target in the fragment,
  // then navigate under the route. The real MV3 reader/messaging/cleanup still run.
  const worker = extension.serviceWorkers()[0] ?? (await extension.waitForEvent('serviceworker'));
  await worker.evaluate(() => {
    const create = chrome.tabs.create.bind(chrome.tabs);
    chrome.tabs.create = (async (options: chrome.tabs.CreateProperties) =>
      await create({
        ...options,
        // Chromium lowercases about: URL fragments. Encode every character so
        // case-sensitive Solana addresses survive the test-only handoff intact.
        url: `about:blank#${Array.from(options.url ?? '', (char) => char.charCodeAt(0).toString(16)).join('-')}`,
      })) as typeof chrome.tabs.create;
  });
  extension.on('page', (helper) => {
    void (async () => {
      try {
        await helper.waitForURL((url) => url.protocol === 'about:' && !!url.hash, {
          waitUntil: 'domcontentloaded',
        });
        const target = String.fromCharCode(
          ...new URL(helper.url()).hash
            .slice(1)
            .split('-')
            .map((hex) => parseInt(hex, 16)),
        );
        await helper.goto(target);
      } catch {}
    })();
  });
  return { page, unexpected, images };
}
const analyze = (page: Page) =>
  page.getByRole('button', { name: 'Анализировать', exact: true }).click();
test('waits for ATH while current market cap and title are already visible', async ({
  extension,
}) => {
  const { page } = await setup(extension, 'robinhood', false, false, { slowAthMs: 2500 });
  await page.getByRole('spinbutton', { name: 'Кошельков', exact: true }).fill('1');
  await page.getByRole('spinbutton', { name: 'Других токенов', exact: true }).fill('1');
  await analyze(page);
  await expect
    .poll(() =>
      extension
        .pages()
        .some(
          (p) =>
            p !== page && p.url().includes('/token/') && p.url() !== context('robinhood').pageUrl,
        ),
    )
    .toBe(true);
  await expect(page.getByRole('cell', { name: '$50K', exact: true })).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveText('Готово', { timeout: 20000 });
  await expect(page.getByRole('cell', { name: '$125K', exact: true })).toHaveCount(1);
});
test('reuses version 4 histories but recollects ATH instead of keeping current MC', async ({
  extension,
}) => {
  const { page } = await setup(extension, 'bnb');
  await analyze(page);
  await expect(page.getByRole('status')).toHaveText('Готово', { timeout: 25000 });
  const worker = extension.serviceWorkers()[0]!;
  await worker.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const key = Object.keys(all).find((k) => k.startsWith('ew.ui.scan.newest.no-fresh.'))!;
    const scan = all[key] as {
      version: number;
      quoteMetric?: string;
      quotes: Record<string, { usd: number; source: string }>;
    };
    scan.version = 4;
    delete scan.quoteMetric;
    for (const quote of Object.values(scan.quotes) as { usd: number; source: string }[]) {
      quote.usd = 50000;
      quote.source = 'axiom-page';
    }
    await chrome.storage.local.set({ [key]: scan });
  });
  await page.reload();
  await page.getByRole('button', { name: 'Early Wallets', exact: false }).click();
  await expect(page.getByRole('status')).toContainText('History сохранена');
  await expect(page.getByRole('cell', { name: '$50K', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Продолжить / повторить' }).click();
  await expect(page.getByRole('status')).toHaveText('Готово', { timeout: 15000 });
  await expect(page.getByRole('cell', { name: '$125K', exact: true })).toHaveCount(2);
  expect(await page.locator('body').getAttribute('data-actions')).toBeNull();
});
test('Fresh wallet skips History, continues, and persists the reason with the full address', async ({
  extension,
}) => {
  const { page, unexpected } = await setup(extension, 'robinhood', false, false, {
    freshWallet: true,
  });
  await page.getByRole('spinbutton', { name: 'Кошельков', exact: true }).fill('2');
  await page.getByRole('spinbutton', { name: 'Других токенов', exact: true }).fill('1');
  await analyze(page);
  await expect(page.getByRole('status')).toHaveText('Готово', { timeout: 15000 });
  const actions = await page.locator('body').getAttribute('data-actions');
  expect(actions).not.toContain('History:0');
  expect(actions).toContain('History:1');
  expect(actions).not.toContain('wallet:2');
  await page.getByText('Причины пропуска (1)', { exact: true }).click();
  await expect(page.getByText('Fresh — метка Axiom', { exact: true })).toBeVisible();
  await expect(page.getByText(addr('robinhood', 100), { exact: true })).toBeVisible();
  await expect(
    page.getByRole('row').filter({ has: page.getByRole('link', { name: 'T2', exact: true }) }),
  ).toContainText('100.0%');
  await expect(page.getByRole('link', { name: 'T3', exact: true })).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Early Wallets', exact: false }).click();
  await page.getByText('Причины пропуска (1)', { exact: true }).click();
  await expect(page.getByText('Fresh — метка Axiom', { exact: true })).toBeVisible();
  expect(unexpected).toEqual([]);
});
test('History with only Bought = 0 is excluded with its own reason and continues', async ({
  extension,
}) => {
  const { page } = await setup(extension, 'bnb', false, false, { zeroBought: true });
  await page.getByRole('spinbutton', { name: 'Кошельков', exact: true }).fill('2');
  await page.getByRole('spinbutton', { name: 'Других токенов', exact: true }).fill('1');
  await analyze(page);
  await expect(page.getByRole('status')).toHaveText('Готово', { timeout: 20000 });
  await page.getByText('Причины пропуска (1)', { exact: true }).click();
  await expect(
    page.getByText('Нет покупок других токенов: только исходный токен или Bought = 0', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'T3', exact: true })).toHaveCount(0);
  expect(await page.locator('body').getAttribute('data-actions')).toContain('History:1');
});
for (const chain of ['bnb', 'sol', 'robinhood'] as const)
  test(`header ATH with generic Axiom tab title: ${chain}`, async ({ extension }) => {
    const { page, unexpected } = await setup(extension, chain, false, false, { headerQuote: true });
    const tabs = extension.pages().length;
    await analyze(page);
    await expect(page.getByRole('status')).toHaveText('Готово', { timeout: 25000 });
    await expect(page.getByRole('cell', { name: '$169M', exact: true })).toHaveCount(2);
    await expect(
      page.getByRole('columnheader', { name: 'ATH MC · USD', exact: true }),
    ).toBeVisible();
    await expect.poll(() => extension.pages().length).toBe(tabs);
    expect(unexpected).toEqual([]);
  });
for (const chain of ['bnb', 'sol', 'robinhood'] as const)
  test(`UI-only MV3: ${chain}, unique buyers, History, cap and persistence`, async ({
    extension,
  }) => {
    const { page, unexpected } = await setup(extension, chain);
    const tabs = extension.pages().length;
    const started = Date.now();
    await analyze(page);
    await expect(page.getByRole('status')).toHaveText('Готово', { timeout: 35000 });
    if (chain === 'bnb' && process.env.EW_BENCHMARK) {
      await mkdir('artifacts', { recursive: true });
      const phase = process.env.EW_BENCHMARK === 'before' ? 'before' : 'after';
      await writeFile(
        `artifacts/performance-${phase}.json`,
        JSON.stringify(
          {
            scanMs: Date.now() - started,
            wallets: 3,
            tokensPerWallet: 5,
            scenario: 'synthetic UI; two quoted tokens; one source-only wallet',
          },
          null,
          2,
        ),
      );
    }
    const row = page
      .getByRole('row')
      .filter({ has: page.getByRole('link', { name: 'T2', exact: true }) });
    await expect(row).toContainText('100.0%');
    await expect(row).toContainText('$125K');
    await expect(page.locator('.metric').filter({ hasText: 'ПРОПУЩЕНО' })).toContainText('1');
    const actions = await page.locator('body').getAttribute('data-actions');
    expect(actions).toContain('Age ↑');
    expect(actions?.match(/History:/g)).toHaveLength(3);
    expect(actions?.match(/Opened ↓/g)).toHaveLength(3);
    expect(unexpected).toEqual([]);
    await expect.poll(() => extension.pages().length).toBe(tabs);
    await row.getByRole('button').click();
    await expect(page.getByText(addr(chain, 100), { exact: true })).toBeVisible();
    const entry = (n: number) =>
      page.locator('.wallet-entry').filter({ has: walletButton(page, chain, n) });
    await expect(entry(100).locator('.wallet-amount')).toHaveText('Total: $1.27KAmount: 279M(T1)');
    await expect(entry(101).locator('.wallet-amount')).toHaveText('Total: $200Amount: 10M(T1)');
    await page.getByText('Причины пропуска (1)', { exact: true }).click();
    await expect(entry(102).locator('.wallet-amount')).toHaveText('Total: $300Amount: 15M(T1)');
    if (chain === 'bnb') {
      await mkdir('artifacts', { recursive: true });
      await page.screenshot({ path: 'artifacts/extension-preview.png' });
      const downloadEvent = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Экспорт JSON' }).click();
      const download = await downloadEvent;
      const data = JSON.parse(await readFile((await download.path())!, 'utf8'));
      expect(data.version).toBe(5);
      expect(data.quoteMetric).toBe('ath-market-cap');
      expect(
        data.buyers.map((buyer: { firstBuyTotalLabel: string; firstBuyAmountLabel: string }) => [
          buyer.firstBuyTotalLabel,
          buyer.firstBuyAmountLabel,
        ]),
      ).toEqual([
        ['$1.27K', '279M'],
        ['$200', '10M'],
        ['$300', '15M'],
      ]);
      expect(data.wallets[0].buyer.firstBuyAmountLabel).toBe('279M');
      expect(
        Object.values(data.quotes).every(
          (q: any) => q.source === 'axiom-page-ath' && q.usd === 125000,
        ),
      ).toBe(true);
      expect(data.historyOrder).toBe('newest');
      expect(data.excludeFresh).toBe(true);
      expect(data.wallets.map((w: { status: string }) => w.status)).toEqual([
        'included',
        'included',
        'excluded',
      ]);
    }
    await page.reload();
    await page.getByRole('button', { name: 'Early Wallets', exact: false }).click();
    await expect(page.getByRole('status')).toHaveText('Готово');
    await page.getByRole('button', { name: 'Показать 2 кошельков: T2', exact: true }).click();
    await expect(entry(100).locator('.wallet-amount')).toHaveText('Total: $1.27KAmount: 279M(T1)');
    await expect(entry(101).locator('.wallet-amount')).toHaveText('Total: $200Amount: 10M(T1)');
    await walletButton(page, chain, 100).click();
    await expect(page.locator('[data-wallet-message]')).toHaveText(
      'History кошелька открыта в Axiom.',
    );
  });
test('resume after reload skips completed wallet histories', async ({ extension }) => {
  const { page } = await setup(extension, 'bnb');
  await analyze(page);
  await expect(page.locator('.metric').filter({ hasText: 'УЧТЕНО' })).toContainText('1', {
    timeout: 15000,
  });
  await page.getByRole('button', { name: 'Приостановить' }).click();
  await expect(page.getByRole('status')).toContainText('Приостановлено');
  await page.reload();
  await page.getByRole('button', { name: 'Early Wallets', exact: false }).click();
  await page.getByRole('button', { name: 'Продолжить / повторить' }).click();
  await expect(page.getByRole('status')).toHaveText('Готово', { timeout: 35000 });
  expect(await page.locator('body').getAttribute('data-actions')).not.toContain('History:0');
});
test('unrecognized Bought column pauses without excluding wallet', async ({ extension }) => {
  const { page, unexpected } = await setup(extension, 'robinhood', true);
  await analyze(page);
  await expect(page.getByRole('status')).toContainText('Не распознана колонка Bought', {
    timeout: 15000,
  });
  await expect(page.getByRole('button', { name: 'Продолжить / повторить' })).toBeVisible();
  await expect(page.locator('.metric').filter({ hasText: 'ПРОПУЩЕНО' })).toContainText('0');
  expect(unexpected).toEqual([]);
});
test('closing wallet during scan pauses and preserves data', async ({ extension }) => {
  const { page } = await setup(extension, 'bnb');
  await analyze(page);
  await page.getByRole('button', { name: 'Close wallet' }).click();
  await expect(page.getByRole('status')).toContainText('Модалка кошелька закрыта', {
    timeout: 15000,
  });
});
test('invalid settings do not click trades', async ({ extension }) => {
  const { page } = await setup(extension, 'bnb');
  await page.getByRole('spinbutton', { name: 'Кошельков', exact: true }).fill('0');
  await analyze(page);
  await expect(page.getByRole('alert')).toContainText('Допустимо 1–200');
  expect(await page.locator('body').getAttribute('data-actions')).toBeNull();
});
test('storage failure remains visible and export is available', async ({ extension }) => {
  const { page } = await setup(extension, 'bnb');
  const worker = extension.serviceWorkers()[0] ?? (await extension.waitForEvent('serviceworker'));
  await worker.evaluate(async () => {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  });
  await analyze(page);
  await expect(page.getByRole('status')).toContainText('Результат не удалось сохранить');
  await expect(page.getByRole('button', { name: 'Экспорт JSON' })).toBeEnabled();
});

for (const initialOpened of ['Opened', 'Opened ↑', 'Opened ↓'] as const)
  test(`newest History skips source and duplicates starting with ${initialOpened}`, async ({
    extension,
  }) => {
    const { page, unexpected } = await setup(extension, 'bnb', false, true, { initialOpened });
    await page.getByRole('spinbutton', { name: 'Кошельков', exact: true }).fill('1');
    await analyze(page);
    await expect(page.locator('.metric').filter({ hasText: 'УЧТЕНО' })).toContainText('1', {
      timeout: 20000,
    });
    await page.getByRole('button', { name: 'Приостановить' }).click();
    await expect(page.getByRole('status')).toContainText('Приостановлено');
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Экспорт JSON' }).click();
    const download = await downloadEvent,
      data = JSON.parse(await readFile((await download.path())!, 'utf8'));
    expect(data.wallets[0].tokens.map((t: { address: string }) => t.address)).toEqual(
      [9, 8, 7, 6, 5].map((n) => addr('bnb', n)),
    );
    expect(await page.locator('body').getAttribute('data-actions')).toContain('History scroll');
    expect(unexpected).toEqual([]);
  });

test('delayed History ignores stale rows until loading finishes', async ({ extension }) => {
  const { page } = await setup(extension, 'bnb', false, false, { slowHistoryMs: 2200 });
  await page.getByRole('spinbutton', { name: 'Кошельков', exact: true }).fill('1');
  await page.getByRole('spinbutton', { name: 'Других токенов', exact: true }).fill('1');
  await analyze(page);
  await expect(page.locator('#positions')).toHaveAttribute('aria-busy', 'true', { timeout: 10000 });
  await expect(page.locator('.metric').filter({ hasText: 'УЧТЕНО' })).toContainText('0');
  await expect(page.getByRole('status')).toHaveText('Готово', { timeout: 20000 });
  await expect(page.getByRole('link', { name: 'T3', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'T9', exact: true })).toHaveCount(0);
  expect(await page.locator('body').getAttribute('data-actions')).toContain('History ready');
});
test('early quote reader finishes before token-page images load', async ({ extension }) => {
  const { page, images } = await setup(extension, 'bnb', false, false, { slowImage: true });
  await analyze(page);
  await expect(page.getByRole('cell', { name: '$125K', exact: true })).toHaveCount(2, {
    timeout: 25000,
  });
  expect(images.requested).toBeGreaterThan(0);
  expect(images.finished).toBe(0);
});
test('caps appear while the next trader History is still loading', async ({ extension }) => {
  const { page, unexpected } = await setup(extension, 'robinhood', false, false, {
    headerQuote: true,
    holdSecondHistory: true,
  });
  await analyze(page);
  await expect(page.getByRole('cell', { name: '$169M', exact: true })).toHaveCount(2, {
    timeout: 20000,
  });
  await expect(page.locator('#positions')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('.metric').filter({ hasText: 'ПОКУПАТЕЛЕЙ' })).toContainText('2');
  await expect(page.getByRole('status')).toContainText('MC: 2 / 2');
  await page.getByRole('button', { name: 'Finish loading History' }).click();
  await expect(page.getByRole('status')).toHaveText('Готово', { timeout: 20000 });
  expect(unexpected).toEqual([]);
});
test('pausing parallel quotes immediately closes owned helper tabs', async ({ extension }) => {
  const { page } = await setup(extension, 'bnb', false, false, { missingQuote: true });
  const tabs = extension.pages().length;
  await analyze(page);
  await expect.poll(() => extension.pages().length, { timeout: 20000 }).toBe(tabs + 2);
  await page.getByRole('button', { name: 'Приостановить' }).click();
  await expect(page.getByRole('status')).toContainText('Приостановлено');
  await expect.poll(() => extension.pages().length, { timeout: 4000 }).toBe(tabs);
});

for (const emptyNoHeader of [false, true])
  test(`empty History skips immediately and continues to next trader (header absent: ${emptyNoHeader})`, async ({
    extension,
  }) => {
    const { page } = await setup(extension, 'robinhood', false, false, {
      emptyWallet: true,
      emptyNoHeader,
    });
    await page.getByRole('spinbutton', { name: 'Кошельков', exact: true }).fill('2');
    await page.getByRole('spinbutton', { name: 'Других токенов', exact: true }).fill('1');
    await analyze(page);
    await expect(page.getByRole('status')).toHaveText('Готово', { timeout: 15000 });
    await expect(page.locator('.metric').filter({ hasText: 'ПРОПУЩЕНО' })).toContainText('1');
    await expect(page.locator('.metric').filter({ hasText: 'УЧТЕНО' })).toContainText('1');
    const timing = await page
      .locator('body')
      .evaluate((body) => Number(body.dataset.nextWalletAt) - Number(body.dataset.historyEmptyAt));
    expect(timing).toBeGreaterThanOrEqual(0);
    expect(timing).toBeLessThan(2000);
  });
test('temporary empty label with a loader is not excluded', async ({ extension }) => {
  const { page } = await setup(extension, 'bnb', false, false, { transientEmptyMs: 1500 });
  await page.getByRole('spinbutton', { name: 'Кошельков', exact: true }).fill('1');
  await page.getByRole('spinbutton', { name: 'Других токенов', exact: true }).fill('1');
  await analyze(page);
  await expect(page.getByRole('status')).toHaveText('Готово', { timeout: 15000 });
  await expect(page.locator('.metric').filter({ hasText: 'ПРОПУЩЕНО' })).toContainText('0');
  await expect(page.getByRole('link', { name: 'T3', exact: true })).toBeVisible();
});

for (const emptyWallet of [true, false])
  test(`animated modal close continues past the first trader (empty: ${emptyWallet})`, async ({
    extension,
  }) => {
    const { page } = await setup(extension, 'robinhood', false, false, {
      emptyWallet,
      closeDelayMs: 300,
    });
    await analyze(page);
    const status = page.getByRole('status');
    await expect(status).toHaveText(/Готово|Во время анализа открыта другая модалка/, {
      timeout: 25000,
    });
    await expect(status).toHaveText('Готово');
    await expect(page.locator('.metric').filter({ hasText: 'ПОКУПАТЕЛЕЙ' })).toContainText('3');
    const actions = await page.locator('body').getAttribute('data-actions');
    expect(actions).toContain('History:0');
    expect(actions).toContain('History:1');
    expect(actions).toContain('History:2');
  });

async function savedWallets(
  extension: BrowserContext,
  chain: Chain,
  behaviour: Parameters<typeof setup>[4] = {},
) {
  const result = await setup(extension, chain, false, false, behaviour);
  const scan = newScan(context(chain), { walletLimit: 2, tokensPerWallet: 1 });
  scan.buyers = [100, 101].map((n) => ({
    address: addr(chain, n),
    firstBuyAt: Date.now(),
    tradeId: 'saved-' + n,
  }));
  scan.buyersCollected = scan.selectionComplete = true;
  scan.status = 'complete';
  scan.message = 'Готово';
  scan.wallets = scan.buyers.map((buyer) => ({
    buyer,
    status: 'included',
    tokens: [historyToken(2, chain)],
    fetchedAt: Date.now(),
  }));
  const worker = extension.serviceWorkers()[0]!;
  await worker.evaluate(
    async ({ key, scan }) => {
      await chrome.storage.local.set({ [key]: scan });
    },
    { key: 'ew.ui.scan.newest.no-fresh.' + pageIdentity(scan.context), scan },
  );
  await result.page.reload();
  await result.page.getByRole('button', { name: 'Early Wallets', exact: false }).click();
  await result.page.getByRole('button', { name: 'Показать 2 кошельков: T2', exact: true }).click();
  return result;
}
const walletButton = (page: Page, chain: Chain, n: number) =>
  page.getByRole('button', { name: 'Открыть кошелёк ' + addr(chain, n) + ' в Axiom', exact: true });

for (const chain of ['bnb', 'sol', 'robinhood'] as const)
  test(
    'wallet links open saved addresses through Axiom search: ' + chain,
    async ({ extension }) => {
      const { page, unexpected } = await savedWallets(extension, chain, { closeDelayMs: 300 });
      await expect(page.locator('.wallet-amount')).toHaveText([
        'Вход: нет данных(SOURCE)',
        'Вход: нет данных(SOURCE)',
      ]);
      await walletButton(page, chain, 101).click();
      await expect(page.locator('[data-wallet-message]')).toHaveText(
        'History кошелька открыта в Axiom.',
      );
      await expect(page.locator('#modal')).toHaveAttribute('data-max', 'true');
      await expect(page.locator('#modal #history')).toHaveAttribute('aria-selected', 'true');
      expect(await page.locator('body').getAttribute('data-actions')).toContain(
        'Search result:1|wallet:1|Max|History:1',
      );
      await walletButton(page, chain, 100).focus();
      await walletButton(page, chain, 100).press('Enter');
      await expect(page.locator('[data-wallet-message]')).toHaveText(
        'History кошелька открыта в Axiom.',
      );
      await expect(page.locator('body')).toHaveAttribute(
        'data-actions',
        /Search result:0\|wallet:0\|Max\|History:0/,
      );
      await expect(page.locator('#modal #opened')).toHaveText('Opened ↓');
      await expect(page.locator('#modal')).toHaveCount(1);
      expect(unexpected).toEqual([]);
    },
  );

for (const [mode, message] of [
  ['missing', 'не показал этот кошелёк'],
  ['wrong-result', 'Адрес результата поиска не совпал'],
  ['wrong-modal', 'Открыт другой кошелёк'],
  ['wrong-chain', 'другой сети'],
] as const)
  test('wallet links reject ' + mode + ' and allow retry', async ({ extension }) => {
    const { page } = await savedWallets(extension, 'robinhood', { searchMode: mode });
    await walletButton(page, 'robinhood', 100).click();
    await expect(page.locator('[data-wallet-message]')).toContainText(message, { timeout: 14000 });
    expect(await page.locator('body').getAttribute('data-actions')).not.toContain('History:');
    await expect(walletButton(page, 'robinhood', 100)).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Новый анализ', exact: true })).toBeEnabled();
  });

test('wallet links cancel delayed search without opening its late result', async ({
  extension,
}) => {
  const { page } = await savedWallets(extension, 'bnb', { searchDelayMs: 1400 });
  await walletButton(page, 'bnb', 100).dblclick();
  await expect(page.locator('#search-results')).toHaveAttribute('aria-busy', 'true');
  await page.getByRole('button', { name: 'Отменить открытие', exact: true }).click();
  await expect(page.locator('[data-wallet-message]')).toHaveText('Открытие кошелька отменено.');
  await expect(page.locator('#search-results')).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#modal')).toHaveCount(0);
  expect(
    (await page.locator('body').getAttribute('data-actions'))?.match(/Search input:/g),
  ).toHaveLength(1);
});

test('wallet links pause a running analysis and wait for its modal cleanup', async ({
  extension,
}) => {
  const { page } = await setup(extension, 'robinhood', false, false, {
    holdSecondHistory: true,
    closeDelayMs: 350,
  });
  await analyze(page);
  await expect(
    page.getByRole('button', { name: 'Finish loading History', exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: 'Показать 1 кошельков: T2', exact: true }).click();
  await walletButton(page, 'robinhood', 100).click();
  await expect(page.locator('[data-wallet-message]')).toHaveText(
    'History кошелька открыта в Axiom.',
    { timeout: 15000 },
  );
  await expect(
    page.getByRole('button', { name: 'Продолжить / повторить', exact: true }),
  ).toBeVisible();
  await expect(page.locator('#modal')).toHaveCount(1);
  expect(await page.locator('body').getAttribute('data-actions')).toContain(
    'Search result:0|wallet:0|Max|History:0',
  );
});

test('wallet links open an empty History without waiting for an Opened header', async ({
  extension,
}) => {
  const { page } = await savedWallets(extension, 'robinhood', {
    emptyWallet: true,
    emptyNoHeader: true,
  });
  await walletButton(page, 'robinhood', 100).click();
  await expect(page.locator('[data-wallet-message]')).toHaveText(
    'History кошелька открыта в Axiom.',
  );
  await expect(page.locator('#modal')).toContainText('No historic positions');
});
