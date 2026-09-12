import type { Chain } from './types';

/** Runs in MAIN only for our marked Copy button. No HTTP, app state or clipboard reads. */
export async function copyAddressFromUi(marker: string, chain: Chain): Promise<string> {
  if (location.origin !== 'https://axiom.trade' || !/^[\w-]{1,80}$/.test(marker))
    throw new Error('Неверная страница');
  const button = document.querySelector<HTMLButtonElement>(`button[data-ew-copy="${marker}"]`);
  if (!button || !button.querySelector('.ri-file-copy-line'))
    throw new Error('Кнопка копирования кошелька не найдена');
  const label =
    button.querySelector('span')?.textContent?.trim() ?? button.textContent?.trim() ?? '';
  const pieces = label.split(/\.{2,}|…/);
  if (pieces.length !== 2) throw new Error('Не удалось проверить сокращённый адрес кошелька');
  const valid = (value: unknown): value is string =>
    typeof value === 'string' &&
    (chain === 'sol' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[0-9a-fA-F]{40}$/).test(value) &&
    (chain === 'sol' ? value : value.toLowerCase()).startsWith(
      chain === 'sol' ? pieces[0]! : pieces[0]!.toLowerCase(),
    ) &&
    (chain === 'sol' ? value : value.toLowerCase()).endsWith(
      chain === 'sol' ? pieces[1]! : pieces[1]!.toLowerCase(),
    );
  // Capture only the text produced by this UI action, preserving the user's clipboard.
  const clipboard = navigator.clipboard;
  if (!clipboard) throw new Error('Копирование адреса недоступно');
  const original = clipboard.writeText;
  const own = Object.getOwnPropertyDescriptor(clipboard, 'writeText');
  return await new Promise<string>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const restore = () => {
      clearTimeout(timer);
      if (own) Object.defineProperty(clipboard, 'writeText', own);
      else delete (clipboard as unknown as Record<string, unknown>).writeText;
    };
    const capture = async (value: string) => {
      if (!valid(value)) return await original.call(clipboard, value);
      restore();
      resolve(chain === 'sol' ? value : value.toLowerCase());
    };
    try {
      Object.defineProperty(clipboard, 'writeText', {
        configurable: true,
        writable: true,
        value: capture,
      });
      timer = setTimeout(() => {
        restore();
        reject(new Error('Кнопка Copy не вернула полный адрес кошелька'));
      }, 2000);
      button.click();
    } catch (error) {
      restore();
      reject(error);
    }
  });
}
