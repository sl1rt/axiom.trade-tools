import css from './panel.css?inline';
import { aggregate, tokenKey, tokenUrl } from './core';
import type { ScanOptions, ScanState, TokenContext } from './types';

const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-4)}`;
const money = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(n);
const chainName = { bnb: 'BNB', sol: 'Solana', robinhood: 'Robinhood' };
const exclusionLabels = {
  fresh: 'Fresh — метка Axiom',
  'empty-history': 'Пустая History',
  'no-other-purchases': 'Нет покупок других токенов: только исходный токен или Bought = 0',
};
export interface PanelActions {
  start: (options: ScanOptions) => void;
  resume: () => void;
  pause: () => void;
  export: () => void;
  openWallet: (address: string) => void;
  cancelWallet: () => void;
}
export class Panel {
  host: HTMLDivElement;
  private shadow: ShadowRoot;
  private open = false;
  private sharedOnly = false;
  private expanded = new Set<string>();
  private frame = 0;
  private focusOnToggle = false;
  private context: TokenContext | null = null;
  private state: ScanState | null = null;
  private running = false;
  private openingWallet: string | null = null;
  private walletMessage = '';
  private draft: ScanOptions = { walletLimit: 50, tokensPerWallet: 5 };
  constructor(private actions: PanelActions) {
    this.host = document.createElement('div');
    this.host.id = 'axiom-early-wallets';
    this.host.lang = 'ru';
    this.shadow = this.host.attachShadow({ mode: 'open' });
    document.documentElement.append(this.host);
    this.shadow.addEventListener('click', (event) => {
      event.stopPropagation();
      this.click(event);
    });
    this.shadow.addEventListener('keyup', (event) => event.stopPropagation());
    this.shadow.addEventListener('keydown', (event) => {
      // Typing in the panel must not trigger Axiom's document-level shortcuts.
      event.stopPropagation();
      if ((event as KeyboardEvent).key === 'Escape' && this.open) {
        event.stopPropagation();
        this.toggle();
      }
    });
    this.shadow.addEventListener('change', (event) => {
      const input = event.target as HTMLInputElement;
      if (input.name === 'shared') {
        this.sharedOnly = input.checked;
        this.render();
      }
      if (input.name === 'walletLimit') this.draft.walletLimit = Number(input.value);
      if (input.name === 'tokensPerWallet') this.draft.tokensPerWallet = Number(input.value);
    });
  }
  toggle() {
    this.open = !this.open;
    this.focusOnToggle = true;
    this.render();
  }
  showError(message: string) {
    const el = this.shadow.querySelector('[data-validation]');
    if (el) {
      el.textContent = message;
      el.classList.remove('hidden');
    }
  }
  walletProgress(address: string | null, message: string) {
    this.openingWallet = address;
    this.walletMessage = message;
    this.render();
  }
  private walletLink(address: string) {
    return `<button type="button" class="wallet-link" data-action="wallet" data-wallet="${esc(address)}" aria-label="Открыть кошелёк ${esc(address)} в Axiom" title="Открыть History в Axiom${this.running ? ' (анализ будет приостановлен)' : ''}" ${this.openingWallet ? 'disabled' : ''}>${esc(address)}</button>`;
  }
  update(context: TokenContext | null, state: ScanState | null, running: boolean) {
    this.context = context;
    this.state = state;
    this.running = running;
    this.render();
  }
  private click(event: Event) {
    const target = (event.target as Element).closest<HTMLElement>('[data-action]');
    if (!target) return;
    switch (target.dataset.action) {
      case 'toggle':
        this.toggle();
        break;
      case 'start':
        this.actions.start({ ...this.draft });
        break;
      case 'resume':
        this.actions.resume();
        break;
      case 'pause':
        this.actions.pause();
        break;
      case 'export':
        this.actions.export();
        break;
      case 'wallet':
        if (!this.openingWallet && target.dataset.wallet)
          this.actions.openWallet(target.dataset.wallet);
        break;
      case 'cancel-wallet':
        this.actions.cancelWallet();
        break;
      case 'details': {
        const key = target.dataset.key!;
        this.expanded.has(key) ? this.expanded.delete(key) : this.expanded.add(key);
        this.render();
        break;
      }
    }
  }
  private render() {
    if (!this.frame)
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.renderNow();
      });
  }
  private renderNow() {
    if (!this.context) {
      this.shadow.innerHTML = '';
      return;
    }
    const active = this.shadow.activeElement as HTMLElement | null;
    const bodyScroll = this.shadow.querySelector('.body')?.scrollTop ?? 0;
    const focusSelector = active?.id
      ? `#${CSS.escape(active.id)}`
      : active?.dataset.action
        ? `[data-action="${CSS.escape(active.dataset.action)}"]${active.dataset.key ? `[data-key="${CSS.escape(active.dataset.key)}"]` : ''}${active.dataset.wallet ? `[data-wallet="${CSS.escape(active.dataset.wallet)}"]` : ''}`
        : null;
    const s = this.state,
      ctx = s?.context ?? this.context,
      rows = s ? aggregate(s) : [],
      included = s?.wallets.filter((w) => w.status === 'included').length ?? 0,
      excluded = s?.wallets.filter((w) => w.status === 'excluded').length ?? 0,
      errors = s?.wallets.filter((w) => w.status === 'error').length ?? 0;
    const progress = !s
      ? 0
      : s.status === 'complete'
        ? 100
        : s.status === 'collecting'
          ? 5
          : s.status === 'quotes'
            ? 80 + (20 * Object.keys(s.quotes).length) / Math.max(1, rows.length)
            : 10 + (70 * s.wallets.length) / Math.max(1, s.buyers.length);
    const pending = s?.buyersCollected ? Math.max(0, s.buyers.length - s.wallets.length) : 0;
    const canResume =
      s &&
      !this.running &&
      (s.status !== 'complete' ||
        errors > 0 ||
        Object.values(s.quotes).some((q) => q.usd === null));
    const timestamp = s ? new Date(s.updatedAt).toLocaleTimeString('ru-RU') : '';
    this.shadow.innerHTML = `<style>${css}</style>
      <button class="launcher ${this.open ? 'hidden' : ''}" data-action="toggle"><span class="mark">↗</span>Early Wallets${this.running ? '<span class="pulse"></span>' : ''}</button>
      <aside class="panel ${this.open ? '' : 'hidden'}" aria-label="Axiom Early Wallets">
      <header class="header"><span class="mark">↗</span><div><div class="eyebrow">ЧЕРЕЗ ИНТЕРФЕЙС · 0.3.7</div><h1>Early Wallets</h1></div><button class="close" data-action="toggle" aria-label="Свернуть">×</button></header>
      <div class="body"><div class="context"><div><div class="token-name">${esc(ctx.symbol || ctx.name || 'Первые покупатели')}</div><div class="small muted" title="${esc(ctx.address)}">${esc(short(ctx.address))}</div></div><span class="chain">${chainName[ctx.chain]}</span></div>
      <div class="settings"><label for="ew-wallet-limit">Кошельков<input id="ew-wallet-limit" name="walletLimit" type="number" min="1" max="200" value="${this.draft.walletLimit}" ${this.running ? 'disabled' : ''}></label><label for="ew-token-limit">Других токенов<input id="ew-token-limit" name="tokensPerWallet" type="number" min="1" max="20" value="${this.draft.tokensPerWallet}" ${this.running ? 'disabled' : ''}></label></div>
      <p class="rule">Age ↑ → History · Max → Opened ↓<br>Свежие открытия с покупками. Fresh-кошельки и исходный токен пропускаются.${this.running ? '<br>Дождитесь завершения: не меняйте таблицу и модалку.' : ''}</p>
      <div class="actions">${this.running ? '<button class="primary" data-action="pause">Приостановить</button>' : `<button class="primary" data-action="start" ${this.openingWallet ? 'disabled' : ''}>${s ? 'Новый анализ' : 'Анализировать'}</button>${canResume ? `<button class="secondary" data-action="resume" ${this.openingWallet ? 'disabled' : ''}>Продолжить / повторить</button>` : ''}`}</div>
      <div data-validation class="note hidden" role="alert"></div>
      ${this.walletMessage ? `<div class="note" data-wallet-message aria-live="polite">${esc(this.walletMessage)}${this.openingWallet ? '<br><button type="button" class="secondary" data-action="cancel-wallet">Отменить открытие</button>' : ''}</div>` : ''}
      ${
        s
          ? `<div class="status ${s.status === 'error' ? 'state-error' : ''}" role="status">${esc(s.message)}<div class="bar"><div class="fill" style="width:${Math.min(100, progress)}%"></div></div></div>
      <div class="metrics"><div class="metric"><strong>${s.buyers.length}<span> / ${s.options.walletLimit}</span></strong><span>ПОКУПАТЕЛЕЙ</span></div><div class="metric"><strong>${included}</strong><span>УЧТЕНО</span></div><div class="metric"><strong>${excluded}</strong><span>ПРОПУЩЕНО</span></div></div>
      ${
        excluded
          ? `<details class="errors"><summary>Причины пропуска (${excluded})</summary>${s.wallets
              .filter((w) => w.status === 'excluded')
              .map(
                (w) =>
                  `<p>${this.walletLink(w.buyer.address)}<br><span>${esc(exclusionLabels[w.exclusionReason!])}</span></p>`,
              )
              .join('')}</details>`
          : ''
      }
      ${!s.selectionComplete && s.buyersCollected ? `<div class="note">${esc(s.selectionNote || 'Выборка покупателей неполная.')}</div>` : ''}
      ${errors || pending ? `<div class="note">${pending ? `Ожидают обработки: ${pending}. ` : ''}${errors ? `Ошибки загрузки: ${errors}. ` : ''}Совпадения предварительные; доля рассчитана по ${included} учтённым кошелькам.</div>` : ''}
      <div class="small muted">Параметры результата: ${s.options.walletLimit} / ${s.options.tokensPerWallet} · Сканирование с ${esc(new Date(s.startedAt).toLocaleString('ru-RU'))}</div>`
          : ''
      }
      <div class="table-tools"><label for="ew-shared"><input id="ew-shared" type="checkbox" name="shared" ${this.sharedOnly ? 'checked' : ''}>От двух кошельков</label><button class="secondary" data-action="export" ${!s ? 'disabled' : ''}>Экспорт JSON</button></div>
      ${
        rows.length
          ? `<p class="small muted">ATH MC — максимум капитализации из ячейки ATH в Axiom, USD.</p><table><caption class="visually-hidden">Токены выбранных кошельков и ATH капитализации USD</caption><thead><tr><th scope="col">ТОКЕН</th><th scope="col">КОШЕЛЬКИ</th><th scope="col">ДОЛЯ</th><th scope="col">ATH MC · USD</th></tr></thead><tbody>${rows
              .filter((row) => !this.sharedOnly || row.count >= 2)
              .map((row) => {
                const key = tokenKey(row.token),
                  q = row.quote;
                return `<tr><td><a href="${esc(tokenUrl(row.token))}" target="_blank" rel="noopener noreferrer">${esc(row.token.symbol || row.token.name || short(row.token.address))}</a><span class="address" title="${esc(row.token.address)}">${esc(short(row.token.address))}</span></td><td><button class="count" data-action="details" data-key="${esc(key)}" aria-expanded="${this.expanded.has(key)}" aria-label="Показать ${row.count} кошельков: ${esc(row.token.symbol || short(row.token.address))}">${row.count}</button></td><td>${row.percentage.toFixed(1)}%</td><td title="${esc(q?.error ?? (q ? `Получено ${new Date(q.fetchedAt).toLocaleString('ru-RU')}; ${q.source === 'axiom-page-ath' ? 'округлённое значение страницы' : 'снимок Axiom'}` : ''))}">${q?.usd ? money(q.usd) : q ? 'Нет данных' : '…'}</td></tr>${this.expanded.has(key) ? `<tr class="details-row"><td colspan="4"><div class="details">${row.wallets.map((w) => `<div>${this.walletLink(w)}</div>`).join('')}</div></td></tr>` : ''}`;
              })
              .join(
                '',
              )}</tbody></table>${this.sharedOnly && rows.every((row) => row.count < 2) ? '<div class="empty">Повторяющихся токенов пока нет.</div>' : ''}`
          : `<div class="empty"><strong>${s?.status === 'complete' ? 'Подходящих токенов нет' : 'Какие токены у них общие?'}</strong>${s?.status === 'complete' ? 'Проверьте количество исключённых кошельков и ошибки.' : 'Запустите анализ. Совпадения появятся по мере чтения истории.'}</div>`
      }
      ${
        errors
          ? `<details class="errors"><summary>Ошибки кошельков (${errors})</summary>${s!.wallets
              .filter((w) => w.status === 'error')
              .map((w) => `<p>${this.walletLink(w.buyer.address)}<br>${esc(w.error)}</p>`)
              .join('')}</details>`
          : ''
      }
      </div><footer class="footer"><span>История Axiom · Совпадения только в выбранных токенах</span><span>${esc(timestamp)}</span></footer></aside>`;
    const body = this.shadow.querySelector('.body');
    if (body) body.scrollTop = bodyScroll;
    const focus = this.focusOnToggle
      ? this.shadow.querySelector<HTMLElement>(this.open ? '#ew-wallet-limit' : '.launcher')
      : focusSelector
        ? (this.shadow.querySelector<HTMLElement>(focusSelector) ??
          this.shadow.querySelector<HTMLElement>('.primary'))
        : null;
    focus?.focus({ preventScroll: true });
    this.focusOnToggle = false;
  }
}
