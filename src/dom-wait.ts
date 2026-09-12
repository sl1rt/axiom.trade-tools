import { abortError, checkAbort } from './core';
import { UiError } from './ui-errors';

/** Observe rendered state; unrelated mutations never extend the settling period. */
export function waitForDom<T>(
  read: () => T | null,
  options: {
    signal: AbortSignal;
    root?: Node;
    timeoutMs?: number;
    settleMs?: number;
    key?: (value: T) => unknown;
    message?: string;
  },
): Promise<T> {
  checkAbort(options.signal);
  return new Promise((resolve, reject) => {
    const settleMs = options.settleMs ?? 200;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let mutationTimer: ReturnType<typeof setTimeout> | undefined;
    let candidateKey: unknown,
      since = 0,
      hasCandidate = false,
      finished = false;
    const cleanup = () => {
      finished = true;
      clearTimeout(timer);
      clearTimeout(mutationTimer);
      clearTimeout(deadline);
      observer.disconnect();
      options.signal.removeEventListener('abort', abort);
    };
    const fail = (error: unknown) => {
      cleanup();
      reject(error);
    };
    const abort = () => fail(abortError());
    const inspect = () => {
      if (finished) return;
      clearTimeout(timer);
      timer = undefined;
      try {
        checkAbort(options.signal);
        const value = read();
        if (value === null) hasCandidate = false;
        else {
          const key = options.key ? options.key(value) : value;
          if (!hasCandidate || key !== candidateKey) {
            candidateKey = key;
            since = Date.now();
            hasCandidate = true;
          }
          if (Date.now() - since >= settleMs) {
            cleanup();
            resolve(value);
            return;
          }
        }
        timer = setTimeout(
          inspect,
          hasCandidate ? Math.max(20, Math.min(200, settleMs - (Date.now() - since))) : 200,
        );
      } catch (error) {
        fail(error);
      }
    };
    const observer = new MutationObserver(() => {
      if (finished || mutationTimer !== undefined) return;
      mutationTimer = setTimeout(() => {
        mutationTimer = undefined;
        inspect();
      }, 20);
    });
    const deadline = setTimeout(
      () => fail(new UiError(options.message ?? 'Интерфейс не завершил загрузку.')),
      options.timeoutMs ?? 15_000,
    );
    options.signal.addEventListener('abort', abort, { once: true });
    observer.observe(options.root ?? document, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'href', 'aria-busy', 'aria-selected'],
    });
    inspect();
  });
}
