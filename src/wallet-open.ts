import { addressOf, checkAbort, contextFromUrl, pageIdentity } from './core';
import { findButton } from './dom';
import { waitForDom } from './dom-wait';
import { messageRequest } from './transport';
import type { Chain, TokenContext } from './types';
import { UiError } from './ui-errors';
import { walletModal } from './ui-source';

const text = (el: Element | null) => el?.textContent?.trim().replace(/\s+/g, ' ') ?? '';
const visible = (el: Element) => el.getClientRects().length > 0;
const searchInput = () =>
  [...document.querySelectorAll<HTMLInputElement>('input[placeholder]')].find(
    (el) => visible(el) && /Search by name, ticker, CA, or wallet/i.test(el.placeholder),
  );
const copyButton = (root: ParentNode) =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find(
    (el) => visible(el) && el.querySelector('.ri-file-copy-line') && /\.{2,}|…/.test(text(el)),
  );

async function readAddress(button: HTMLButtonElement, chain: Chain, signal: AbortSignal) {
  const marker = crypto.randomUUID();
  button.dataset.ewCopy = marker;
  try {
    return addressOf(
      chain,
      await messageRequest({ type: 'EW_COPY_ADDRESS', marker, chain }, signal),
    );
  } finally {
    delete button.dataset.ewCopy;
  }
}

/** Open the site's search result using only visible controls. Never reads app state or HTTP. */
export async function openWalletFromSearch(
  address: string,
  context: TokenContext,
  signal: AbortSignal,
  progress: (message: string) => void,
) {
  const wallet = addressOf(context.chain, address);
  const check = () => {
    checkAbort(signal);
    const current = contextFromUrl(location.href);
    if (!current || pageIdentity(current) !== pageIdentity(context))
      throw new UiError('Страница токена изменилась. Открытие кошелька отменено.');
  };
  check();
  const previous = walletModal();
  if (previous) {
    const close = previous.querySelector('.ri-close-line')?.closest('button');
    if (!close) throw new UiError('Закройте открытую модалку кошелька и нажмите адрес ещё раз.');
    close.click();
    await waitForDom(() => (!previous.isConnected || !visible(previous) ? true : null), {
      signal,
      settleMs: 40,
      timeoutMs: 3000,
      message: 'Предыдущая модалка кошелька не закрылась.',
    });
  }
  check();
  progress('Ищу кошелёк в Axiom…');
  if (!searchInput()) {
    const button = findButton(/Search by token or CA/);
    if (!button) throw new UiError('Не найдена кнопка поиска Axiom.');
    button.click();
  }
  const input = await waitForDom(
    () => {
      check();
      return searchInput() ?? null;
    },
    {
      signal,
      settleMs: 40,
      timeoutMs: 5000,
      message: 'Поиск Axiom не открылся.',
    },
  );
  let root: HTMLElement | null = input.parentElement;
  while (root && root !== document.body && !findButton(/^Wallets$/, root))
    root = root.parentElement;
  if (!root || root === document.body)
    throw new UiError('В поиске Axiom не найдена вкладка Wallets.');
  const searchRoot = root;
  const wallets = findButton(/^Wallets$/, searchRoot)!;
  if (wallets.getAttribute('aria-pressed') !== 'true') wallets.click();
  // Call the native setter so controlled React inputs observe the ensuing input event.
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new UiError('Не удалось заполнить поиск Axiom.');
  input.focus();
  setter.call(input, wallet);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const requireSearch = () => {
    check();
    if (!input.isConnected || !visible(input) || input.value !== wallet)
      throw new UiError('Поиск закрыт или изменён. Нажмите адрес кошелька ещё раз.');
  };
  const result = await waitForDom(
    () => {
      requireSearch();
      if (searchRoot.querySelector('[aria-busy="true"], [class*="animate-spin"]')) return null;
      if (
        [...searchRoot.querySelectorAll('span, p, div')].some(
          (el) =>
            visible(el) &&
            /^(?:No wallets found|No results found|No results)[.!]?$/i.test(text(el)),
        )
      )
        throw new UiError(
          'Axiom не показал этот кошелёк в поиске. Проверьте выбранную сеть и повторите.',
        );
      for (const copy of searchRoot.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="Copy address"]',
      )) {
        if (!visible(copy)) continue;
        const pieces = text(copy.querySelector('span')).split(/\.{2,}|…/);
        const normalize = (value: string) =>
          context.chain === 'sol' ? value : value.toLowerCase();
        if (
          pieces.length !== 2 ||
          !normalize(wallet).startsWith(normalize(pieces[0]!)) ||
          !normalize(wallet).endsWith(normalize(pieces[1]!))
        )
          continue;
        for (let row = copy.parentElement; row && row !== searchRoot; row = row.parentElement) {
          if (
            row.classList.contains('cursor-pointer') &&
            /PnL/.test(text(row)) &&
            /Win/.test(text(row))
          )
            return { row, copy };
        }
      }
      return null;
    },
    {
      signal,
      root: searchRoot,
      settleMs: 300,
      timeoutMs: 10_000,
      key: (result) => result.row,
      message: 'Axiom не показал этот кошелёк в поиске. Проверьте выбранную сеть и повторите.',
    },
  );
  if ((await readAddress(result.copy, context.chain, signal)) !== wallet)
    throw new UiError('Адрес результата поиска не совпал с выбранным кошельком.');
  requireSearch();
  if (!result.row.isConnected) throw new UiError('Результат поиска изменился. Повторите открытие.');
  progress('Открываю History кошелька…');
  // The row is a layout container. Axiom handles clicks on its overlay button.
  const open = result.row.querySelector<HTMLButtonElement>('button[aria-label^="View wallet"]');
  if (!open || !visible(open) || open.disabled)
    throw new UiError('В результате поиска не найдена кнопка View wallet. Повторите открытие.');
  open.click();
  const modal = await waitForDom(
    () => {
      check();
      return walletModal();
    },
    {
      signal,
      settleMs: 100,
      timeoutMs: 10_000,
      message: 'Axiom не открыл модалку кошелька.',
    },
  );
  const explorer = {
    bnb: /^Open in BSCScan$/i,
    sol: /^Open in Solscan$/i,
    robinhood: /^Open in RH Scan$/i,
  }[context.chain];
  if (
    ![...modal.querySelectorAll('button[aria-label]')].some(
      (el) => visible(el) && explorer.test(el.getAttribute('aria-label') ?? ''),
    )
  )
    throw new UiError('Axiom открыл кошелёк в другой сети. Выберите нужную сеть в поиске.');
  const copy = copyButton(modal);
  if (!copy || (await readAddress(copy, context.chain, signal)) !== wallet)
    throw new UiError('Открыт другой кошелёк. Переход в History отменён.');
  const label = text(copy);
  const requireModal = () => {
    check();
    if (!modal.isConnected || walletModal() !== modal || text(copy) !== label)
      throw new UiError('Модалка кошелька закрыта или изменена.');
  };
  requireModal();
  findButton(/^Max$/, modal)?.click();
  findButton(/^History$/, modal)!.click();
  await waitForDom(
    () => {
      requireModal();
      const history = findButton(/^History$/, modal);
      return history?.getAttribute('aria-selected') === 'true' ||
        history?.querySelector('[class*="border-textPrimary"]')
        ? true
        : null;
    },
    {
      signal,
      root: modal,
      settleMs: 80,
      timeoutMs: 5000,
      message: 'Axiom не переключился в History.',
    },
  );
  for (let attempt = 0; attempt < 3; attempt++) {
    const opened = await waitForDom(
      () => {
        requireModal();
        if (
          modal.querySelector(
            '[aria-busy="true"], [class*="animate-spin"], [class*="animate-pulse"]',
          )
        )
          return null;
        if (
          [...modal.querySelectorAll('span, p, div')].some(
            (el) =>
              visible(el) &&
              /^(?:No historic positions|No historical positions|No positions|No history|No transactions|Nothing to show)[.!]?$/i.test(
                text(el),
              ),
          )
        )
          return 'empty' as const;
        return findButton(/^Opened(?:\s*[↑↓])?$/, modal) ?? null;
      },
      {
        signal,
        root: modal,
        settleMs: 100,
        timeoutMs: 10_000,
        message: 'History не завершила загрузку.',
      },
    );
    if (opened === 'empty' || text(opened).includes('↓')) return;
    if (attempt === 2) throw new UiError('Не удалось включить Opened ↓ в History.');
    const before = text(opened);
    opened.click();
    await waitForDom(
      () => {
        requireModal();
        return text(findButton(/^Opened(?:\s*[↑↓])?$/, modal) ?? null) !== before ? true : null;
      },
      {
        signal,
        root: modal,
        settleMs: 80,
        timeoutMs: 3000,
        message: 'Сортировка Opened не изменилась.',
      },
    );
  }
}
