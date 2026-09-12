import { aggregate, checkAbort, delay, tokenKey, validateOptions } from './core';
import { UiError } from './ui-errors';
import type {
  Buyer,
  DataSource,
  ScanOptions,
  ScanState,
  TokenContext,
  TokenRef,
  WalletResult,
} from './types';

export function newScan(context: TokenContext, options: ScanOptions): ScanState {
  return {
    version: 5,
    quoteMetric: 'ath-market-cap',
    historyOrder: 'newest',
    excludeFresh: true,
    id: crypto.randomUUID(),
    context,
    options: validateOptions(options),
    status: 'collecting',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    buyers: [],
    buyersCollected: false,
    selectionComplete: false,
    wallets: [],
    quotes: {},
    message: 'Подготовка…',
  };
}
export class ScanRunner {
  constructor(
    private source: DataSource,
    private save: (state: ScanState) => Promise<void>,
    private paceMs = 0,
    private quoteConcurrency = 3,
  ) {}
  async run(state: ScanState, requestedSignal: AbortSignal): Promise<void> {
    const controller = new AbortController(),
      signal = controller.signal,
      cancel = () => controller.abort();
    requestedSignal.addEventListener('abort', cancel, { once: true });
    if (requestedSignal.aborted) cancel();
    const attempted = new Set<string>();
    const queue: TokenRef[] = [],
      queued = new Set<string>(),
      waiters = new Set<() => void>();
    let saving = Promise.resolve(),
      phaseMessage = state.message,
      finishedProducing = false,
      completedQuotes = 0;
    let workerFailure: unknown;
    let workers: Promise<void>[] = [];
    const wake = () => {
      for (const resolve of waiters) resolve();
      waiters.clear();
    };
    signal.addEventListener('abort', wake);
    const enqueue = (tokens: TokenRef[]) => {
      checkAbort(signal);
      for (const token of tokens) {
        const key = tokenKey(token);
        if (queued.has(key)) continue;
        queued.add(key);
        const quote = state.quotes[key];
        if (
          quote?.source === 'axiom-page-ath' &&
          quote.usd != null &&
          Date.now() - quote.fetchedAt < 60_000
        )
          completedQuotes++;
        else queue.push(token);
      }
      // Re-rank even when a history contains no new contracts: it can increase an
      // existing token's wallet count. Only pending jobs move; active reads finish.
      const counts = new Map(aggregate(state).map((row) => [tokenKey(row.token), row.count]));
      queue.sort((a, b) => (counts.get(tokenKey(b)) ?? 0) - (counts.get(tokenKey(a)) ?? 0));
      wake();
    };
    const publish = async (message?: string) => {
      if (message !== undefined) phaseMessage = message;
      state.message =
        state.status === 'quotes'
          ? `ATH MC: ${completedQuotes} / ${queued.size} · до 3 вкладок одновременно`
          : (state.status === 'collecting' || state.status === 'wallets') && queued.size
            ? `${phaseMessage} · ATH MC: ${completedQuotes} / ${queued.size}`
            : phaseMessage;
      state.updatedAt = Date.now();
      const snapshot = structuredClone(state),
        previous = saving;
      // Concurrent quote completions must never save an older snapshot after a newer one.
      saving = (async () => {
        await previous.catch(() => {});
        await this.save(snapshot);
      })();
      await saving;
    };
    const readQuotes = async () => {
      try {
        while (true) {
          checkAbort(signal);
          const token = queue.shift();
          if (!token) {
            if (finishedProducing) return;
            // Suspend until the producer adds a token, finishes, or the run is cancelled.
            await new Promise<void>((resolve) => waiters.add(resolve));
            continue;
          }
          let quote;
          try {
            quote = await this.source.getQuote(token, signal);
          } catch (error) {
            checkAbort(signal);
            quote = {
              usd: null,
              fetchedAt: Date.now(),
              source: 'axiom-page-ath' as const,
              error: error instanceof Error ? error.message : String(error),
            };
          }
          checkAbort(signal);
          state.quotes[tokenKey(token)] = quote;
          completedQuotes++;
          await publish();
        }
      } catch (error) {
        if (!signal.aborted) {
          workerFailure = error;
          controller.abort();
        }
      }
    };
    const processWallet = async (buyer: Buyer) => {
      checkAbort(signal);
      const existing = state.wallets.find((w) => w.buyer.address === buyer.address);
      if (attempted.has(buyer.address) || (existing && existing.status !== 'error')) return;
      attempted.add(buyer.address);
      await publish(
        `History · кошелёк ${state.buyers.findIndex((b) => b.address === buyer.address) + 1} / ${state.options.walletLimit}`,
      );
      let result: WalletResult;
      try {
        const history = buyer.fresh
          ? { tokens: [], empty: false }
          : await this.source.getHistory(
              state.context,
              buyer.address,
              state.options.tokensPerWallet,
              signal,
            );
        checkAbort(signal);
        result = {
          buyer,
          tokens: history.tokens,
          status: history.tokens.length ? 'included' : 'excluded',
          exclusionReason: buyer.fresh
            ? 'fresh'
            : history.tokens.length
              ? undefined
              : history.empty
                ? 'empty-history'
                : 'no-other-purchases',
          fetchedAt: Date.now(),
        };
      } catch (error) {
        checkAbort(signal);
        if (error instanceof UiError) throw error;
        result = {
          buyer,
          tokens: [],
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
          fetchedAt: Date.now(),
        };
      }
      state.wallets = state.wallets.filter((w) => w.buyer.address !== buyer.address);
      state.wallets.push(result);
      enqueue(result.tokens);
      await publish(`Обработано кошельков: ${state.wallets.length} / ${state.options.walletLimit}`);
      await delay(this.paceMs, signal);
    };
    try {
      checkAbort(signal);
      state.status = state.buyersCollected ? 'wallets' : 'collecting';
      enqueue(aggregate(state).map((row) => row.token));
      workers = Array.from({ length: Math.max(1, Math.min(3, this.quoteConcurrency)) }, readQuotes);
      if (!state.buyersCollected) {
        state.status = 'collecting';
        await publish('Открываю Trades → Age ↑…');
        state.context = await this.source.getContext(state.context, signal);
        const selection = await this.source.getBuyers(
          state.context,
          state.options.walletLimit,
          signal,
          () => {},
          async (buyer) => {
            if (!state.buyers.some((b) => b.address === buyer.address)) state.buyers.push(buyer);
            await publish(
              `Найдено покупателей: ${state.buyers.length} / ${state.options.walletLimit}`,
            );
            await processWallet(buyer);
          },
        );
        checkAbort(signal);
        state.buyers = selection.buyers;
        state.wallets = state.wallets.filter((w) =>
          state.buyers.some((b) => b.address === w.buyer.address),
        );
        state.selectionComplete = selection.complete;
        state.selectionNote = selection.note;
        state.buyersCollected = true;
        await publish(`Найдено покупателей: ${state.buyers.length}`);
      }
      state.status = 'wallets';
      for (const buyer of state.buyers) await processWallet(buyer);
      state.status = 'quotes';
      finishedProducing = true;
      wake();
      await publish();
      await Promise.all(workers);
      if (workerFailure) throw workerFailure;
      checkAbort(signal);
      state.status = 'complete';
      await publish(
        state.selectionComplete &&
          state.wallets.every((w) => w.status !== 'error') &&
          Object.values(state.quotes).every((q) => q.usd !== null)
          ? 'Готово'
          : 'Готово · есть неполные данные',
      );
    } catch (error) {
      controller.abort();
      await Promise.all(workers);
      const failure = workerFailure ?? error;
      state.status = requestedSignal.aborted || failure instanceof UiError ? 'paused' : 'error';
      await publish(
        requestedSignal.aborted
          ? 'Приостановлено. Завершённые результаты сохранены.'
          : failure instanceof Error
            ? failure.message
            : String(failure),
      );
    } finally {
      requestedSignal.removeEventListener('abort', cancel);
      signal.removeEventListener('abort', wake);
    }
  }
}
