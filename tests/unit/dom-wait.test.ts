import { afterEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { waitForDom } from '../../src/dom-wait';
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function fixture() {
  const dom = new JSDOM('<main>loading</main>');
  vi.stubGlobal('MutationObserver', dom.window.MutationObserver);
  vi.stubGlobal('document', dom.window.document);
  return dom;
}
it('waits for stable readiness and resets stability when loading returns', async () => {
  vi.useFakeTimers();
  const dom = fixture(),
    controller = new AbortController();
  let value: string | null = null;
  const done = vi.fn();
  const pending = waitForDom(() => value, {
    signal: controller.signal,
    settleMs: 200,
    timeoutMs: 2000,
  });
  void (async () => done(await pending))();
  value = 'rows';
  await vi.advanceTimersByTimeAsync(250);
  expect(done).not.toHaveBeenCalled();
  value = null;
  await vi.advanceTimersByTimeAsync(200);
  value = 'new rows';
  await vi.advanceTimersByTimeAsync(200);
  expect(done).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(200);
  expect(await pending).toBe('new rows');
  dom.window.close();
});
it('abort removes observers and rejects pending readiness', async () => {
  const dom = fixture(),
    controller = new AbortController();
  const read = vi.fn(() => null);
  const pending = waitForDom(read, { signal: controller.signal });
  const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await assertion;
  const calls = read.mock.calls.length;
  dom.window.document.body.textContent = 'changed';
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(read).toHaveBeenCalledTimes(calls);
  dom.window.close();
});
