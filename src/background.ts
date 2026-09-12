import { addressOf, checkAbort, delay, tokenUrl } from './core';
import { copyAddressFromUi } from './copy-address';
import type { ApiReply, Chain, TokenRef } from './types';

function allowedSender(sender?: chrome.runtime.MessageSender): boolean {
  try {
    return (
      !!sender?.tab?.id &&
      sender.frameId === 0 &&
      new URL(sender.url ?? '').origin === 'https://axiom.trade'
    );
  } catch {
    return false;
  }
}
function validChain(value: unknown): Chain {
  if (value === 'bnb' || value === 'sol' || value === 'robinhood') return value;
  throw new Error('Неизвестная сеть');
}
function validToken(value: TokenRef | undefined): TokenRef {
  if (!value || typeof value !== 'object') throw new Error('Нет токена');
  const chain = validChain(value.chain);
  return {
    ...value,
    chain,
    address: addressOf(chain, value.address),
    pairAddress:
      chain === 'sol' && value.pairAddress ? addressOf(chain, value.pairAddress) : undefined,
  };
}
async function pageQuote(token: TokenRef, signal: AbortSignal): Promise<ApiReply> {
  let tabId: number | undefined;
  const close = async () => {
    if (tabId !== undefined) await chrome.tabs.remove(tabId).catch(() => {});
  };
  const cancel = () => {
    void close();
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    checkAbort(signal);
    const tab = await chrome.tabs.create({ url: tokenUrl(token), active: false });
    tabId = tab.id;
    checkAbort(signal);
    if (!tabId) throw new Error('Не удалось открыть страницу токена');
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      checkAbort(signal);
      try {
        const reply = (await chrome.tabs.sendMessage(tabId, {
          type: 'EW_WAIT_QUOTE',
          token,
          timeoutMs: Math.min(2500, deadline - Date.now()),
        })) as ApiReply;
        if (reply?.ok) return reply;
        // The reader already waited for DOM changes; retry immediately within the deadline.
      } catch {
        checkAbort(signal);
        await delay(150, signal); // Listener not installed yet or a navigation is in progress.
      }
    }
    return { ok: false, error: 'ATH капитализации не появилась на странице Axiom.' };
  } finally {
    signal.removeEventListener('abort', cancel);
    await close();
  }
}
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ew-quote' || !allowedSender(port.sender)) {
    port.disconnect();
    return;
  }
  const controller = new AbortController();
  let started = false;
  port.onDisconnect.addListener(() => controller.abort());
  port.onMessage.addListener((message: { token?: TokenRef } | null) => {
    if (started) return;
    started = true;
    void (async () => {
      let result: ApiReply;
      try {
        result = await pageQuote(validToken(message?.token), controller.signal);
      } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      if (!controller.signal.aborted) {
        try {
          port.postMessage(result);
        } catch {}
      }
    })();
  });
});
chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
  if (!allowedSender(sender) || !message || typeof message !== 'object') return false;
  const m = message as { type?: string; marker?: unknown; chain?: unknown };
  if (m.type !== 'EW_COPY_ADDRESS') return false;
  void (async () => {
    try {
      const chain = validChain(m.chain);
      if (typeof m.marker !== 'string' || !/^[\w-]{1,80}$/.test(m.marker))
        throw new Error('Некорректная кнопка Copy');
      const results = await chrome.scripting.executeScript({
        target: { tabId: sender.tab!.id!, frameIds: [0] },
        world: 'MAIN',
        func: copyAddressFromUi,
        args: [m.marker, chain],
      });
      respond({ ok: true, data: addressOf(chain, results[0]?.result) });
    } catch (error) {
      respond({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  })();
  return true;
});
chrome.action.onClicked.addListener((tab) => {
  if (tab.id) void chrome.tabs.sendMessage(tab.id, { type: 'EW_TOGGLE' }).catch(() => {});
});
