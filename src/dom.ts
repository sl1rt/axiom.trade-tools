import { addressOf, contextFromUrl } from './core';
import type { Quote, TokenRef } from './types';

const text = (el: Element) => el.textContent?.trim().replace(/\s+/g, ' ') ?? '';
const visible = (el: Element) => el.getClientRects().length > 0;
export function findButton(
  label: RegExp,
  root: ParentNode = document,
): HTMLButtonElement | undefined {
  return [...root.querySelectorAll<HTMLButtonElement>('button')].find(
    (el) => visible(el) && label.test(text(el)),
  );
}
export function compactUsd(value: string): number | null {
  const match = value.replace(/,/g, '').match(/\$\s*([\d]+(?:\.\d+)?)\s*([KMBT])?/i);
  if (!match) return null;
  const amount =
    Number(match[1]) * ({ K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[match[2]?.toUpperCase() ?? ''] ?? 1);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}
function headerAthMarketCap(doc: Document): number | null {
  for (const label of doc.querySelectorAll('span')) {
    if (text(label) !== 'Price' || !visible(label)) continue;
    const price = label.parentElement,
      header = price?.parentElement;
    // The token summary scopes ATH to this token, excluding charts, tickers and History.
    if (!header?.querySelector('#pair-name-tooltip')) continue;
    const labels = [...header.querySelectorAll('span')].map(text);
    if (!labels.includes('Liquidity') || !labels.includes('Supply')) continue;
    const ath = [...header.querySelectorAll('span')].find(
      (el) => text(el) === 'ATH' && visible(el),
    );
    const cap = ath?.nextElementSibling,
      cell = ath?.parentElement;
    if (
      !cap ||
      !cell ||
      !visible(cap) ||
      cell.matches('[aria-busy="true"]') ||
      cell.querySelector('[aria-busy="true"], [class*="animate-pulse"], [class*="animate-spin"]')
    )
      return null;
    const value = text(cap);
    if (!/^\$\s*\d[\d,]*(?:\.\d+)?\s*[KMBT]?$/i.test(value)) return null;
    return compactUsd(value);
  }
  return null;
}
export function readQuoteFromPage(doc: Document, token: TokenRef): Quote | null {
  const context = contextFromUrl(doc.location.href);
  if (!context || context.chain !== token.chain) return null;
  if (context.scope === 'token' && context.address !== addressOf(token.chain, token.address))
    return null;
  if (context.scope === 'pair' && context.pairAddress !== token.pairAddress) return null;
  // A full on-page explorer link confirms the new token has actually rendered after navigation.
  const explorer =
    token.chain === 'sol' ? 'solscan.io' : token.chain === 'bnb' ? 'bscscan.com' : 'rh-scan.com';
  const rendered = [...doc.querySelectorAll<HTMLAnchorElement>('a[href]')].some((a) => {
    try {
      const url = new URL(a.href);
      return (
        url.hostname === explorer &&
        addressOf(token.chain, url.pathname.split('/').at(-1)) ===
          addressOf(token.chain, token.address)
      );
    } catch {
      return false;
    }
  });
  if (!rendered) return null;
  const usd = headerAthMarketCap(doc);
  // The tab title and unlabelled header figure are current MC, never an ATH fallback.
  return usd === null ? null : { usd, fetchedAt: Date.now(), source: 'axiom-page-ath' };
}
