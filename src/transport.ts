import { abortError, checkAbort } from './core';
import { UiError } from './ui-errors';
import type { ApiReply, Quote, TokenRef } from './types';

export async function messageRequest(message: unknown, signal: AbortSignal): Promise<unknown> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
    };
    const aborted = () => {
      cleanup();
      reject(abortError());
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new UiError('Страница Axiom не ответила вовремя.'));
    }, 40_000);
    signal.addEventListener('abort', aborted, { once: true });
    void (async () => {
      try {
        const reply: ApiReply = await chrome.runtime.sendMessage(message);
        checkAbort(signal);
        if (reply?.ok) resolve(reply.data);
        else
          reject(new UiError(reply?.error ?? 'Расширение не получило ответ. Обновите страницу.'));
      } catch (error) {
        reject(error);
      } finally {
        cleanup();
      }
    })();
  });
}
export async function quoteViaPage(token: TokenRef, signal: AbortSignal): Promise<Quote> {
  checkAbort(signal);
  const result = await new Promise<Quote>((resolve, reject) => {
    const port = chrome.runtime.connect({ name: 'ew-quote' });
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      port.onDisconnect.removeListener(disconnect);
      port.disconnect();
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const abort = () => fail(abortError());
    const disconnect = () =>
      fail(new UiError(chrome.runtime.lastError?.message ?? 'Вкладка капитализации отключена.'));
    const timer = setTimeout(
      () => fail(new UiError('Страница Axiom не ответила вовремя.')),
      30_000,
    );
    signal.addEventListener('abort', abort, { once: true });
    port.onDisconnect.addListener(disconnect);
    port.onMessage.addListener((reply: ApiReply) => {
      if (!reply?.ok) {
        fail(new UiError(reply?.error ?? 'Нет капитализации'));
        return;
      }
      cleanup();
      resolve(reply.data as Quote);
    });
    try {
      port.postMessage({ token });
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
  if (
    !result ||
    result.source !== 'axiom-page-ath' ||
    typeof result.usd !== 'number' ||
    !Number.isFinite(result.usd) ||
    result.usd <= 0
  )
    throw new Error('ATH капитализации не получена.');
  return result;
}
