import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { compactUsd, readQuoteFromPage } from '../../src/dom';
import { isFreshTrader, relativeTime, tradeRows } from '../../src/ui-source';
import { copyAddressFromUi } from '../../src/copy-address';
import { evm, historyToken } from '../fixtures';
import { marketCapHeader } from '../ui-fixture';
afterEach(() => vi.unstubAllGlobals());
it.each([
  ['<i class="ri-leaf-line text-primaryOrange"></i>', true],
  ['<i title="Fresh Wallet"></i>', true],
  ['<i aria-label="Fresh"></i>', true],
  ['<i class="ri-bard-fill" title="First Buy"></i>', false],
  ['<button>Fresh</button><i title="Developer"></i>', false],
  ['<i class="ri-leaf-line" hidden></i>', false],
])('recognizes only the visible Fresh badge: %s', (badge, expected) => {
  const dom = new JSDOM(`<div id="row">${badge}</div>`);
  vi.spyOn(dom.window.Element.prototype, 'getClientRects').mockImplementation(function (
    this: Element,
  ) {
    return (this.hasAttribute('hidden') ? [] : [{}]) as unknown as DOMRectList;
  });
  expect(isFreshTrader(dom.window.document.querySelector('#row')!)).toBe(expected);
  dom.window.close();
});
describe('ATH market cap from UI', () => {
  it.each([
    ['$23.2K', 23200],
    ['$1.42M', 1420000],
    ['$1,234', 1234],
    ['N/A', null],
  ] as const)('parses %s', (input, expected) => {
    expect(compactUsd(input)).toBe(expected);
  });
  it('requires the target full token to have rendered and reads ATH instead of the title', () => {
    const token = historyToken(2),
      dom = new JSDOM(`<title>T2 ↑ $23.2K | Axiom BNB</title>${marketCapHeader()}`, {
        url: `https://axiom.trade/token/${evm(2)}?chain=bnb`,
      });
    const doc = dom.window.document;
    vi.spyOn(dom.window.Element.prototype, 'getClientRects').mockReturnValue([
      {},
    ] as unknown as DOMRectList);
    expect(readQuoteFromPage(doc, token)).toBeNull();
    const a = doc.createElement('a');
    a.href = `https://bscscan.com/address/${evm(1)}`;
    doc.body.append(a);
    expect(readQuoteFromPage(doc, token)).toBeNull();
    a.href = `https://bscscan.com/address/${evm(2)}`;
    expect(readQuoteFromPage(doc, token)).toMatchObject({
      usd: 169_000_000,
      source: 'axiom-page-ath',
    });
    expect(readQuoteFromPage(doc, { ...token, chain: 'robinhood' })).toBeNull();
    dom.window.close();
  });
  it.each(['Axiom', 'T2 ↑ $1M | Axiom HOOD'])('reads visible ATH when title is %s', (title) => {
    const token = historyToken(2, 'robinhood');
    const dom = new JSDOM(
      `<title>${title}</title>${marketCapHeader()}<a href="https://rh-scan.com/address/${evm(2)}">CA</a>`,
      {
        url: `https://axiom.trade/token/${evm(2)}?chain=robinhood`,
      },
    );
    vi.spyOn(dom.window.Element.prototype, 'getClientRects').mockReturnValue([
      {},
    ] as unknown as DOMRectList);
    expect(readQuoteFromPage(dom.window.document, token)).toMatchObject({
      usd: 169_000_000,
      source: 'axiom-page-ath',
    });
    dom.window.close();
  });
  it('does not replace loading ATH with current MC, title, price or liquidity', () => {
    const dom = new JSDOM(
      `<title>T1 ↑ $1M | Axiom HOOD</title>${marketCapHeader('$47.2M', '—')}<a href="https://rh-scan.com/address/${evm(2)}">CA</a>`,
      {
        url: `https://axiom.trade/token/${evm(2)}?chain=robinhood`,
      },
    );
    vi.spyOn(dom.window.Element.prototype, 'getClientRects').mockReturnValue([
      {},
    ] as unknown as DOMRectList);
    expect(readQuoteFromPage(dom.window.document, historyToken(2, 'robinhood'))).toBeNull();
    dom.window.close();
  });
  it('requires ATH in the token header even if another ATH and current title are visible', () => {
    const dom = new JSDOM(
      `<title>T2 ↑ $50K | Axiom HOOD</title><div><span>ATH</span><div>$999M</div></div><a href="https://rh-scan.com/address/${evm(2)}">CA</a>`,
      { url: `https://axiom.trade/token/${evm(2)}?chain=robinhood` },
    );
    vi.spyOn(dom.window.Element.prototype, 'getClientRects').mockReturnValue([
      {},
    ] as unknown as DOMRectList);
    expect(readQuoteFromPage(dom.window.document, historyToken(2, 'robinhood'))).toBeNull();
    dom.window.close();
  });
  it('does not accept a header before the requested contract has rendered', () => {
    const dom = new JSDOM(
      `<title>Axiom</title>${marketCapHeader()}<a href="https://rh-scan.com/address/${evm(1)}">CA</a>`,
      {
        url: `https://axiom.trade/token/${evm(2)}?chain=robinhood`,
      },
    );
    vi.spyOn(dom.window.Element.prototype, 'getClientRects').mockReturnValue([
      {},
    ] as unknown as DOMRectList);
    expect(readQuoteFromPage(dom.window.document, historyToken(2, 'robinhood'))).toBeNull();
    dom.window.close();
  });
});

describe('scoped wallet Copy action', () => {
  it('captures full address produced by Copy and restores method without changing clipboard', async () => {
    const wallet = evm(100),
      dom = new JSDOM(
        '<button data-ew-copy="test"><span>0x00...0064</span><i class="ri-file-copy-line"></i></button>',
        { url: 'https://axiom.trade/' },
      );
    const original = vi.fn(async (_value: string) => {}),
      clipboard = { writeText: original };
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('location', dom.window.location);
    vi.stubGlobal('navigator', { clipboard });
    dom.window.document.querySelector('button')!.onclick = () => {
      void clipboard.writeText(wallet);
    };
    expect(await copyAddressFromUi('test', 'bnb')).toBe(wallet);
    expect(original).not.toHaveBeenCalled();
    expect(clipboard.writeText).toBe(original);
    dom.window.close();
  });
  it('rejects unmarked actions before accessing clipboard', async () => {
    vi.stubGlobal('location', { origin: 'https://axiom.trade' });
    const dom = new JSDOM('<button>Copy</button>');
    vi.stubGlobal('document', dom.window.document);
    await expect(copyAddressFromUi('unknown', 'bnb')).rejects.toThrow('не найдена');
    dom.window.close();
  });
});

// Axiom nests "ago" in a span without a separating text node.

it.each(['10dago', '10d ago'])('preserves approximate age for DOM label %s', (label) => {
  expect(relativeTime(label, 2_000_000_000_000)).toBe(2_000_000_000_000 - 10 * 86400000);
});

describe('first purchase amounts from Trades', () => {
  it.each([
    { total: '$1.27K', amount: '279M' },
    { total: '0.42 BNB', amount: '5M' },
    { total: '0.5', amount: '1,234' },
  ])(
    'keeps the displayed Total and Amount separate from MC: $total / $amount',
    ({ total, amount }) => {
      const dom = new JSDOM(
        `<div><div><span class="text-increase">${total}</span></div><div><span>$4.49K</span></div><div><span>${amount}</span></div><div><button>Trader</button></div><div><a href="https://rh-scan.com/tx/first">2h</a></div></div>`,
      );
      vi.stubGlobal('document', dom.window.document);
      vi.spyOn(dom.window.Element.prototype, 'getClientRects').mockReturnValue([
        {},
      ] as unknown as DOMRectList);
      const rows = tradeRows(dom.window.document);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ buy: true, totalLabel: total, amountLabel: amount });
      dom.window.close();
    },
  );
  it('keeps the buyer eligible but never substitutes MC when Amount is missing', () => {
    const dom = new JSDOM(
      '<div><div><span class="text-increase">$100</span></div><div>$4.49K</div><div><button>Trader</button></div><div><a href="https://bscscan.com/tx/first">2h</a></div></div>',
    );
    vi.stubGlobal('document', dom.window.document);
    vi.spyOn(dom.window.Element.prototype, 'getClientRects').mockReturnValue([
      {},
    ] as unknown as DOMRectList);
    const rows = tradeRows(dom.window.document);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ buy: true, amountLabel: undefined });
    dom.window.close();
  });
});
