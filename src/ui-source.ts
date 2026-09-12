import {
  addressOf,
  checkAbort,
  contextFromUrl,
  delay,
  pageIdentity,
  selectHistory,
  tokenKey,
} from './core';
import { findButton, readQuoteFromPage } from './dom';
import { UiError } from './ui-errors';
import { waitForDom } from './dom-wait';
import { messageRequest, quoteViaPage } from './transport';
import type {
  Buyer,
  Chain,
  DataSource,
  HistoryToken,
  TokenContext,
  TokenRef,
  WalletHistory,
} from './types';

const text = (el: Element | null | undefined) => el?.textContent?.trim().replace(/\s+/g, ' ') ?? '';
const visible = (el: Element) => el.getClientRects().length > 0;
const emptyHistoryText =
  /^(?:No (?:historic positions|historical positions|positions|history|transactions)|Nothing to show)[.!]?$/i;
function historyIsEmpty(root: HTMLElement): boolean {
  const history = findButton(/^History$/, root);
  const selected =
    history?.getAttribute('aria-selected') === 'true' ||
    !!history?.querySelector('[class*="border-textPrimary"]');
  if (
    !selected ||
    root.querySelector('[aria-busy="true"], [class*="animate-spin"], [class*="animate-pulse"]')
  )
    return false;
  if (root.querySelector<HTMLInputElement>('input[placeholder="Search by name or address"]')?.value)
    return false;
  if (
    [...root.querySelectorAll<HTMLAnchorElement>('a[href]')].some(
      (a) => visible(a) && contextFromUrl(a.href),
    )
  )
    return false;
  return [...root.querySelectorAll('span, p, div')].some(
    (el) => visible(el) && emptyHistoryText.test(text(el)),
  );
}
const txLink = (el: HTMLAnchorElement) =>
  /\/(?:tx|transaction)\//.test(new URL(el.href).pathname) &&
  /^(?:bscscan\.com|solscan\.io|rh-scan\.com)$/.test(new URL(el.href).hostname);

export function walletModal(doc: Document = document): HTMLElement | null {
  const explorer = [...doc.querySelectorAll<HTMLButtonElement>('button[aria-label]')].find(
    (b) =>
      /^Open in (?:BSCScan|Solscan|SolScan|RH Scan)$/i.test(b.getAttribute('aria-label') ?? '') &&
      visible(b),
  );
  for (let el = explorer?.parentElement; el && el !== doc.body; el = el.parentElement) {
    const buttons = [...el.querySelectorAll('button')];
    if (buttons.some((b) => text(b) === 'History') && buttons.some((b) => text(b) === 'Max'))
      return el;
  }
  return null;
}
function copyButton(root: ParentNode): HTMLButtonElement | null {
  return (
    [...root.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.querySelector('.ri-file-copy-line') && /\.{2,}|…/.test(text(b)),
    ) ?? null
  );
}
function scroller(el: Element): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(p).overflowY) && p.clientHeight > 0) return p;
  }
  return null;
}
export function isFreshTrader(row: Element): boolean {
  // Axiom's Fresh Wallets badge is a leaf, observed in the trader badge column.
  // ri-bard-fill / "First Buy" marks the first purchase of this token, not a Fresh wallet.
  return [...row.querySelectorAll('.ri-leaf-line, [title], [aria-label]')].some(
    (el) =>
      visible(el) &&
      (el.classList.contains('ri-leaf-line') ||
        /^(?:Fresh|Fresh wallet)s?$/i.test(el.getAttribute('title') ?? '') ||
        /^(?:Fresh|Fresh wallet)s?$/i.test(el.getAttribute('aria-label') ?? '')),
  );
}
export function tradeRows(root: ParentNode = document) {
  const rows: {
    id: string;
    row: HTMLElement;
    button: HTMLButtonElement;
    buy: boolean;
    fresh: boolean;
    age: string;
  }[] = [];
  for (const link of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    if (!txLink(link) || !visible(link)) continue;
    let row: HTMLElement | null = link.parentElement;
    while (row && row !== document.body && !row.querySelector('button')) row = row.parentElement;
    if (
      !row ||
      row === document.body ||
      row.querySelectorAll('a[href*="/tx/"]').length !== 1 ||
      row.closest('[data-ew-wallet-modal]')
    )
      continue;
    const button = row.querySelector<HTMLButtonElement>('button');
    const amount = row.querySelector<HTMLElement>(
      '[class*="text-increase"], [class*="text-decrease"]',
    );
    if (!button || !amount || row.getBoundingClientRect().height > 100) continue;
    // Include the rendered quantities to distinguish multiple swaps in one transaction.
    const id = `${link.href}|${text(row).replace(text(link), '').trim()}`;
    rows.push({
      id,
      row,
      button,
      buy: amount.className.includes('text-increase'),
      fresh: isFreshTrader(row),
      age: text(link),
    });
  }
  return rows;
}
export function relativeTime(label: string, now = Date.now()): number {
  const m = label.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d|w|mo|y)(?:\s|ago|$)/);
  const factor: Record<string, number> = {
    s: 1000,
    m: 60000,
    h: 3600000,
    d: 86400000,
    w: 604800000,
    mo: 2592000000,
    y: 31536000000,
  };
  return m ? now - Number(m[1]) * factor[m[2]!]! : now;
}
function numericText(el: Element | null): number | null {
  const value = text(el)
    .replace(/,/g, '')
    .match(/([\d]+(?:\.\d+)?)\s*([KMBT])?/i);
  if (!value) return null;
  return (
    Number(value[1]) * ({ K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[value[2]?.toUpperCase() ?? ''] ?? 1)
  );
}
export function historyRows(root: ParentNode, chain: Chain): HistoryToken[] {
  const result: HistoryToken[] = [];
  for (const link of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const route = contextFromUrl(link.href);
    if (!route || route.chain !== chain || !visible(link)) continue;
    const row = link.parentElement;
    if (!row || row.children.length < 4) continue;
    let address = route.address;
    if (chain === 'sol' && route.scope === 'pair') {
      // Solana token thumbnails expose the mint as their filename in the rendered DOM.
      const mint = [...link.querySelectorAll<HTMLImageElement>('img[src]')]
        .map((img) => {
          try {
            return new URL(img.src).pathname.split('/').at(-1)?.split('.')[0];
          } catch {
            return undefined;
          }
        })
        .find((value) => value && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value));
      if (!mint) throw new UiError('Не найден полный mint токена в строке History Solana.');
      address = mint;
    }
    const boughtCell = row.children[1]!;
    const boughtAmount = numericText(boughtCell.querySelector('.text-increase'));
    const quantityElement = boughtCell.querySelector('[class*="text-textTertiary"] span');
    const quantity = numericText(quantityElement);
    if (boughtAmount === null && quantity === null)
      throw new UiError('Не распознана колонка Bought в History.');
    const purchased = (boughtAmount ?? 0) > 0 || (quantity ?? 0) > 0;
    const name = text(link.querySelector('[class*="text-textSecondary"]'));
    const symbol = text(link.querySelector('[class*="text-textPrimary"]')) || name;
    const openedCell =
      [...row.children].find((el) => /last TX/.test(text(el))) ??
      row.children[row.children.length - 2];
    const openedLabel =
      text(openedCell?.querySelector('[class*="text-textSecondary"]')) ||
      text(openedCell).split('last TX')[0]!.trim();
    result.push({
      chain,
      address: addressOf(chain, address),
      pairAddress: chain === 'sol' ? route.pairAddress : undefined,
      symbol,
      name,
      openedAt: relativeTime(openedLabel),
      openedLabel,
      bought: purchased,
      buyCount: null,
      tokensBought: quantity,
    });
  }
  return result;
}

export class UiSource implements DataSource {
  private active: { root: HTMLElement; wallet: string; label: string } | null = null;
  private context: TokenContext | null = null;
  private known = new Map<string, Buyer>();
  private completed: Set<string>;
  constructor(buyers: Buyer[] = [], completed: string[] = []) {
    buyers.forEach((b) => this.known.set(b.tradeId, b));
    this.completed = new Set(completed);
  }
  private check(signal: AbortSignal) {
    checkAbort(signal);
    const current = contextFromUrl(location.href);
    if (this.context && (!current || pageIdentity(current) !== pageIdentity(this.context)))
      throw new UiError('Страница токена изменилась. Анализ остановлен.');
  }
  private requireModal(signal: AbortSignal): HTMLElement {
    this.check(signal);
    if (
      !this.active ||
      !this.active.root.isConnected ||
      walletModal() !== this.active.root ||
      text(copyButton(this.active.root)?.querySelector('span')) !== this.active.label
    )
      throw new UiError(
        'Модалка кошелька закрыта или изменена. Нажмите «Продолжить», чтобы повторить.',
      );
    return this.active.root;
  }
  async closeModal() {
    const active = this.active;
    if (!active) return;
    try {
      if (
        active.root.isConnected &&
        walletModal() === active.root &&
        text(copyButton(active.root)?.querySelector('span')) === active.label
      ) {
        const close = active.root.querySelector<HTMLElement>('.ri-close-line')?.closest('button');
        if (!close) throw new UiError('Не найдена кнопка закрытия модалки кошелька.');
        close.click();
        // Axiom keeps the modal mounted during its exit animation. Cleanup also runs on pause,
        // so it must finish independently of the already-aborted analysis signal.
        await waitForDom(() => (!active.root.isConnected || !visible(active.root) ? true : null), {
          signal: new AbortController().signal,
          timeoutMs: 3000,
          settleMs: 40,
          message: 'Модалка кошелька не закрылась. Закройте её и продолжите.',
        });
      }
    } finally {
      if (this.active === active) this.active = null;
    }
  }
  async getContext(context: TokenContext, signal: AbortSignal) {
    this.context = context;
    this.check(signal);
    if (walletModal())
      throw new UiError('Закройте открытую модалку кошелька и запустите анализ снова.');
    if (context.chain === 'sol') {
      const candidates = [...document.querySelectorAll<HTMLAnchorElement>('a[href]')]
        .filter((a) => {
          const u = new URL(a.href);
          return u.hostname === 'solscan.io' && /^\/token\//.test(u.pathname);
        })
        .map((a) => new URL(a.href).pathname.split('/')[2]!);
      if (new Set(candidates).size !== 1)
        throw new UiError('Не найден однозначный CA Solana в ссылке Solscan на странице.');
      context = { ...context, address: addressOf('sol', candidates[0]) };
    }
    const symbol = document.title.split(/[↑↓$|]/)[0]!.trim();
    this.context = { ...context, symbol, name: symbol };
    return this.context;
  }
  private async oldest(signal: AbortSignal) {
    this.check(signal);
    let age = findButton(/^Age(?:\s*[↑↓])?$/);
    if (!age) {
      findButton(/^Trades$/)?.click();
      await delay(500, signal);
      age = findButton(/^Age(?:\s*[↑↓])?$/);
    }
    if (!age)
      throw new UiError(
        'Не найдена таблица Trades с кнопкой Age. Откройте Trades на странице токена.',
      );
    let scope: HTMLElement | null = age.parentElement;
    while (scope && !findButton(/^All$/, scope)) scope = scope.parentElement;
    findButton(/^All$/, scope ?? document)?.click();
    for (let attempt = 0; attempt < 3; attempt++) {
      age = findButton(/^Age(?:\s*[↑↓])?$/);
      if (age && text(age).includes('↑')) break;
      age?.click();
      await delay(400, signal);
    }
    if (!text(findButton(/^Age(?:\s*[↑↓])?$/)).includes('↑'))
      throw new UiError('Не удалось включить Age ↑.');
    await delay(1000, signal);
    const first = tradeRows()[0];
    if (first) {
      const scroll = scroller(first.row);
      if (scroll) scroll.scrollTop = 0;
    }
    await delay(350, signal);
  }
  private async open(
    row: ReturnType<typeof tradeRows>[number],
    chain: Chain,
    signal: AbortSignal,
  ): Promise<string> {
    this.check(signal);
    if (walletModal())
      throw new UiError('Во время анализа открыта другая модалка. Закройте её и продолжите.');
    const current = tradeRows().find((candidate) => candidate.id === row.id);
    if (!current) throw new UiError('Строка трейдера изменилась. Продолжите анализ повторно.');
    current.button.click();
    const root = await waitForDom(
      () => {
        this.check(signal);
        const modal = walletModal();
        const copy = modal ? copyButton(modal) : null;
        if (
          this.active &&
          (modal !== this.active.root || text(copy?.querySelector('span')) !== this.active.label)
        )
          throw new UiError(
            'Модалка кошелька закрыта или изменена. Нажмите «Продолжить», чтобы повторить.',
          );
        if (!modal || !copy) return null;
        this.active ??= { root: modal, wallet: '', label: text(copy.querySelector('span')) };
        return modal;
      },
      {
        signal,
        settleMs: 60,
        timeoutMs: 12_000,
        message: 'Клик по трейдеру не открыл модалку кошелька.',
      },
    );
    root.dataset.ewWalletModal = 'true';
    const copy = copyButton(root);
    if (!copy) throw new UiError('Не найдена кнопка Copy адреса кошелька.');
    const marker = crypto.randomUUID();
    copy.dataset.ewCopy = marker;
    const label = text(copy.querySelector('span'));
    // Keep ownership even if Copy fails, so our modal can be closed on error.
    this.active = { root, wallet: '', label };
    try {
      const wallet = addressOf(
        chain,
        await messageRequest({ type: 'EW_COPY_ADDRESS', marker, chain }, signal),
      );
      this.active.wallet = wallet;
      this.requireModal(signal);
      return wallet;
    } finally {
      delete copy.dataset.ewCopy;
    }
  }
  async getBuyers(
    context: TokenContext,
    limit: number,
    signal: AbortSignal,
    progress: (n: number) => void,
    visit?: (buyer: Buyer) => Promise<void>,
  ) {
    this.context = context;
    await this.oldest(signal);
    const buyers = new Map<string, Buyer>(),
      visited = new Set<string>();
    let quietBottom = 0;
    try {
      for (let step = 0; step < 500; step++) {
        this.check(signal);
        if (!text(findButton(/^Age(?:\s*[↑↓])?$/)).includes('↑'))
          throw new UiError('Сортировка Age изменилась во время анализа.');
        const rows = tradeRows();
        let fresh = 0;
        for (const row of rows) {
          if (visited.has(row.id)) continue;
          visited.add(row.id);
          fresh++;
          if (!row.buy) continue;
          const cached = this.known.get(row.id);
          if (cached && this.completed.has(cached.address)) {
            if (!buyers.has(cached.address)) {
              buyers.set(cached.address, cached);
              progress(buyers.size);
              await visit?.(cached);
            }
            if (buyers.size >= limit) return { buyers: [...buyers.values()], complete: true };
            continue;
          }
          const wallet = await this.open(row, context.chain, signal);
          try {
            if (!buyers.has(wallet)) {
              const buyer = {
                address: wallet,
                firstBuyAt: relativeTime(row.age),
                firstBuyLabel: row.age,
                tradeId: row.id,
                fresh: row.fresh,
              };
              buyers.set(wallet, buyer);
              this.known.set(row.id, buyer);
              progress(buyers.size);
              await visit?.(buyer);
            }
          } finally {
            await this.closeModal();
          }
          if (buyers.size >= limit) return { buyers: [...buyers.values()], complete: true };
        }
        const current = tradeRows();
        const scroll = current[0] ? scroller(current[0].row) : null;
        if (!scroll)
          return {
            buyers: [...buyers.values()],
            complete: false,
            note: 'На странице не найдено продолжение Trades. Обработаны только доступные строки.',
          };
        const before = scroll.scrollTop;
        scroll.scrollTop += Math.max(24, scroll.clientHeight * 0.65);
        await delay(500, signal);
        quietBottom = !fresh && scroll.scrollTop === before ? quietBottom + 1 : 0;
        if (quietBottom >= 5)
          return {
            buyers: [...buyers.values()],
            complete: false,
            note: 'Интерфейс не загрузил дополнительные сделки. Выборка покупателей может быть неполной.',
          };
      }
      return {
        buyers: [...buyers.values()],
        complete: false,
        note: 'Достигнут предел прокрутки Trades.',
      };
    } finally {
      await this.closeModal();
    }
  }
  async getHistory(
    context: TokenContext,
    wallet: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<WalletHistory> {
    this.context = context;
    let openedHere = false;
    if (!this.active || this.active.wallet !== wallet) {
      await this.oldest(signal);
      const buyer = [...this.known.values()].find((b) => b.address === wallet);
      if (!buyer)
        throw new UiError(
          'Нет сохранённой строки трейдера для продолжения. Запустите новый анализ.',
        );
      for (let step = 0; step < 500; step++) {
        this.check(signal);
        const rows = tradeRows();
        const found = rows.find((r) => r.id === buyer.tradeId);
        if (found) {
          if ((await this.open(found, context.chain, signal)) !== wallet)
            throw new UiError('Адрес открытой модалки не совпал с выбранным кошельком.');
          openedHere = true;
          break;
        }
        const scroll = rows[0] ? scroller(rows[0].row) : null;
        if (!scroll) break;
        const before = scroll.scrollTop;
        scroll.scrollTop += scroll.clientHeight * 0.65;
        await delay(400, signal);
        if (before === scroll.scrollTop) break;
      }
      if (!openedHere)
        throw new UiError('Сохранённый трейдер не найден в таблице. Запустите новый анализ.');
    }
    try {
      let root = this.requireModal(signal);
      const max = findButton(/^Max$/, root),
        history = findButton(/^History$/, root);
      if (!max || !history) throw new UiError('В модалке не найдены Max / History.');
      max.click();
      history.click();
      for (let i = 0; i < 3; i++) {
        const opened = await waitForDom(
          () => {
            const modal = this.requireModal(signal);
            if (historyIsEmpty(modal)) return 'empty' as const;
            return findButton(/^Opened(?:\s*[↑↓])?$/, modal) ?? null;
          },
          { signal, root, settleMs: 60 },
        );
        if (opened === 'empty') return { tokens: [], empty: true };
        if (text(opened).includes('↓')) break;
        const before = text(opened);
        opened.click();
        const changed = await waitForDom(
          () => {
            const modal = this.requireModal(signal);
            if (historyIsEmpty(modal)) return 'empty' as const;
            const button = findButton(/^Opened(?:\s*[↑↓])?$/, modal);
            return button && text(button) !== before ? button : null;
          },
          { signal, root, settleMs: 80 },
        );
        if (changed === 'empty') return { tokens: [], empty: true };
      }
      if (!text(findButton(/^Opened(?:\s*[↑↓])?$/, root)).includes('↓'))
        throw new UiError('Не удалось включить Opened ↓ в History.');
      const search = root.querySelector<HTMLInputElement>(
        'input[placeholder="Search by name or address"]',
      );
      if (search?.value)
        throw new UiError(
          'В History включён текстовый фильтр. Очистите поиск в модалке и продолжите.',
        );
      const selected = new Map<string, HistoryToken>();
      let stableBottom = 0,
        lastSignature = '';
      let initialScroll = [
        ...root.querySelectorAll<HTMLElement>('[class*="overflow-y-auto"]'),
      ].find(
        (el) => el.clientHeight > 0 && el.querySelector('a[href*="/token/"], a[href*="/meme/"]'),
      );
      if (initialScroll) initialScroll.scrollTop = 0;
      for (let step = 0; step < 400; step++) {
        if (historyIsEmpty(this.requireModal(signal))) return { tokens: [], empty: true };
        const rows = await waitForDom(
          () => {
            root = this.requireModal(signal);
            if (!text(findButton(/^Opened(?:\s*[↑↓])?$/, root)).includes('↓'))
              throw new UiError('Сортировка History изменилась.');
            if (
              root.querySelector(
                '[aria-busy="true"], [class*="animate-spin"], [class*="animate-pulse"]',
              )
            )
              return null;
            const visibleRows = historyRows(root, context.chain);
            if (!visibleRows.length && !historyIsEmpty(root)) return null;
            // A stale ascending table must not be accepted just because the arrow changed.
            for (let i = 1; i < visibleRows.length; i++)
              if (visibleRows[i]!.openedAt > visibleRows[i - 1]!.openedAt + 60_000) return null;
            return visibleRows;
          },
          {
            signal,
            root,
            settleMs: step === 0 ? 400 : 160,
            timeoutMs: 15_000,
            key: (rows) =>
              rows
                .map((t) => `${tokenKey(t)}:${t.openedLabel}:${t.bought}:${t.tokensBought}`)
                .join('|'),
            message: 'History не показала устойчивую таблицу или сообщение о пустой истории.',
          },
        );
        if (!rows.length && historyIsEmpty(root)) return { tokens: [], empty: true };
        const signature = rows.map(tokenKey).join('|');
        for (const token of selectHistory(rows, context, Math.max(1, rows.length)))
          if (!selected.has(tokenKey(token))) selected.set(tokenKey(token), token);
        if (selected.size >= limit)
          return { tokens: [...selected.values()].slice(0, limit), empty: false };
        const links = [...root.querySelectorAll<HTMLAnchorElement>('a[href]')].filter((a) =>
          contextFromUrl(a.href),
        );
        const scroll = links[0]
          ? scroller(links[0])
          : ([...root.querySelectorAll<HTMLElement>('[class*="overflow-y-auto"]')].find(
              (el) => el.clientHeight > 0,
            ) ?? null);
        const atBottom =
          !scroll || scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 2;
        stableBottom = atBottom && signature === lastSignature ? stableBottom + 1 : 0;
        lastSignature = signature;
        if (stableBottom >= 6) {
          if (!rows.length && !historyIsEmpty(root))
            throw new UiError('History не показала ни строки, ни сообщение о пустой истории.');
          return { tokens: [...selected.values()].slice(0, limit), empty: false };
        }
        if (scroll && !atBottom) scroll.scrollTop += Math.max(60, scroll.clientHeight * 0.65);
        // Keep the conservative end-of-history check; virtual scrolling itself settles by DOM.
        await delay(atBottom ? 250 : 0, signal);
      }
      throw new UiError('History не завершила загрузку. Кошелёк не исключён как пустой.');
    } finally {
      if (openedHere) await this.closeModal();
    }
  }
  async getQuote(token: TokenRef, signal: AbortSignal) {
    return readQuoteFromPage(document, token) ?? (await quoteViaPage(token, signal));
  }
}
