import { UiSource } from './ui-source';
import { contextFromUrl, pageIdentity } from './core';
import { readQuoteFromPage } from './dom';
import { Panel } from './panel';
import { newScan, ScanRunner } from './runner';
import { loadScan, saveScan } from './storage';
import { openWalletFromSearch } from './wallet-open';
import type { ScanOptions, ScanState, TokenContext, TokenRef } from './types';

let context: TokenContext | null = null,
  state: ScanState | null = null,
  controller: AbortController | null = null;
let walletController: AbortController | null = null;
let scanFinished: Promise<void> = Promise.resolve();
let generation = 0,
  lastUrl = '';
const panel = new Panel({
  start,
  resume: () => {
    if (state) void run(state);
  },
  pause: () => controller?.abort(),
  export: exportResults,
  openWallet: (address) => void openWallet(address),
  cancelWallet: () => walletController?.abort(),
});
function render() {
  panel.update(context, state, controller !== null);
}
async function start(options: ScanOptions) {
  if (!context || controller || walletController) return;
  try {
    state = newScan(context, options);
    await run(state);
  } catch (error) {
    panel.showError(error instanceof Error ? error.message : String(error));
  }
}
async function run(scan: ScanState) {
  if (controller || walletController) return;
  panel.walletProgress(null, '');
  let finish!: () => void;
  scanFinished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const currentGeneration = generation;
  const current = new AbortController();
  controller = current;
  render();
  const runner = new ScanRunner(
    new UiSource(
      scan.buyers,
      scan.wallets.filter((w) => w.status !== 'error').map((w) => w.buyer.address),
    ),
    async (next) => {
      await saveScan(next);
      if (generation === currentGeneration) {
        state = next;
        render();
      }
    },
  );
  try {
    await runner.run(scan, current.signal);
  } catch (error) {
    scan.status = current.signal.aborted ? 'paused' : 'error';
    scan.message = error instanceof Error ? error.message : String(error);
    if (generation === currentGeneration) state = scan;
    try {
      await saveScan(scan);
    } catch {
      scan.status = 'error';
      scan.message +=
        ' Результат не удалось сохранить. Данные доступны до закрытия вкладки; используйте экспорт JSON.';
    }
  } finally {
    if (controller === current) controller = null;
    render();
    finish();
  }
}
async function openWallet(address: string) {
  if (!context || !state || walletController || !state.buyers.some((b) => b.address === address))
    return;
  const current = new AbortController();
  const currentGeneration = generation;
  const token = state.context;
  walletController = current;
  const progress = (message: string) => panel.walletProgress(address, message);
  progress(controller ? 'Приостанавливаю анализ перед открытием кошелька…' : 'Открываю кошелёк…');
  try {
    controller?.abort();
    await scanFinished;
    await openWalletFromSearch(address, token, current.signal, progress);
    if (currentGeneration === generation)
      panel.walletProgress(null, 'History кошелька открыта в Axiom.');
  } catch (error) {
    if (currentGeneration === generation)
      panel.walletProgress(
        null,
        current.signal.aborted
          ? 'Открытие кошелька отменено.'
          : error instanceof Error
            ? error.message
            : String(error),
      );
  } finally {
    if (walletController === current) walletController = null;
  }
}
function exportResults() {
  if (!state) return;
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `axiom-${state.context.chain}-${state.context.address}-${state.id.slice(0, 8)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function navigate() {
  if (location.href === lastUrl) return;
  lastUrl = location.href;
  const next = contextFromUrl(location.href);
  if (next && context && pageIdentity(next) === pageIdentity(context)) {
    context = next;
    return;
  }
  const currentGeneration = ++generation;
  controller?.abort();
  walletController?.abort();
  panel.walletProgress(null, '');
  context = next;
  state = null;
  render();
  if (next) {
    try {
      const loaded = await loadScan(next);
      if (generation === currentGeneration && state === null && controller === null) {
        state = loaded;
        render();
      }
    } catch {
      requestAnimationFrame(() => {
        if (generation === currentGeneration)
          panel.showError(
            'Не удалось прочитать сохранённый результат. Проверьте расширение и обновите страницу.',
          );
      });
    }
  }
}
chrome.runtime.onMessage.addListener((message: unknown, _sender, reply) => {
  if (!message || typeof message !== 'object') return false;
  const m = message as { type?: string; token?: TokenRef };
  if (m.type === 'EW_TOGGLE') {
    panel.toggle();
    reply({ ok: true });
  }
  if (m.type === 'EW_READ_QUOTE' && m.token) {
    try {
      const quote = readQuoteFromPage(document, m.token);
      reply(quote ? { ok: true, data: quote } : { ok: false, error: 'Страница загружается' });
    } catch {
      reply({ ok: false, error: 'Нет котировки' });
    }
  }
  return false;
});
window.addEventListener('pagehide', () => {
  controller?.abort();
  walletController?.abort();
});
window.addEventListener('popstate', () => void navigate());
setInterval(() => void navigate(), 750);
void navigate();
