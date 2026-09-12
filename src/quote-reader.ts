import { waitForDom } from './dom-wait';
import { readQuoteFromPage } from './dom';
import type { TokenRef } from './types';

// Small listener installed before images/charts finish loading. No panel or network calls.
chrome.runtime.onMessage.addListener((message: unknown, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object') return false;
  const m = message as { type?: string; token?: TokenRef; timeoutMs?: number };
  if (m.type !== 'EW_WAIT_QUOTE' || !m.token) return false;
  const controller = new AbortController();
  const unload = () => controller.abort();
  window.addEventListener('pagehide', unload, { once: true });
  void (async () => {
    try {
      const quote = await waitForDom(() => readQuoteFromPage(document, m.token!), {
        signal: controller.signal,
        timeoutMs: Math.max(100, Math.min(3000, m.timeoutMs ?? 2500)),
        settleMs: 0,
      });
      reply({ ok: true, data: quote });
    } catch {
      reply({ ok: false, error: 'Страница загружается' });
    } finally {
      window.removeEventListener('pagehide', unload);
    }
  })();
  return true;
});
