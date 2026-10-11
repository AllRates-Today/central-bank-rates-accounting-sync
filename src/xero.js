// Xero Accounting API helpers.
//
// Xero fills organisation-level rates from XE.com and exposes no endpoint to
// replace that table. What the API does accept is a rate on each document:
// Invoices, CreditNotes, BankTransactions, Overpayments and ManualJournals carry
// a `CurrencyRate` (number, max length [18].[6]; when omitted Xero applies the
// XE.com day rate). Reference: https://developer.xero.com/documentation/api/accounting/invoices
//
// CurrencyRate = document-currency units per 1 unit of the organisation base
// currency, so ask AllRatesToday for source=<base> target=<document currency>.
//
// Auth: OAuth 2.0 bearer token + xero-tenant-id header
//   https://developer.xero.com/documentation/guides/oauth2/auth-flow/
//   https://developer.xero.com/documentation/guides/oauth2/tenants/

export const XERO_API = 'https://api.xero.com/api.xro/2.0';
export const CURRENCY_RATE_DECIMALS = 6;

export class XeroError extends Error {
  constructor(message, { status, url, body } = {}) {
    super(message);
    this.name = 'XeroError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/** Round to the 6 decimals Xero stores for CurrencyRate. */
export function toXeroCurrencyRate(rate) {
  return Number(Number(rate).toFixed(CURRENCY_RATE_DECIMALS));
}

/**
 * The official rate shaped for a Xero document.
 * @param {ReturnType<import('./allratestoday.js').createClient>} art  AllRatesToday client
 * @param {{ bank: string, baseCurrency: string, documentCurrency: string, home?: string }} p
 * @returns {Promise<null | {
 *   CurrencyCode: string, CurrencyRate: number, Reference: string,
 *   bank: string, rate_date: string, rate: number, derived: boolean, method: string,
 *   rate_type: string, stale: boolean, age_days: number }>}
 */
export async function officialCurrencyRate(art, { bank, baseCurrency, documentCurrency, home }) {
  const p = await art.pair({ bank, source: baseCurrency, target: documentCurrency, home });
  if (!p) return null;
  return {
    CurrencyCode: p.target,
    CurrencyRate: toXeroCurrencyRate(p.rate),
    Reference: `${p.bank.toUpperCase()} ${p.rate_date}${p.derived ? ` (${p.method})` : ''}`,
    bank: p.bank,
    rate_date: p.rate_date,
    rate: p.rate,
    derived: p.derived,
    method: p.method,
    rate_type: p.rate_type,
    stale: p.stale,
    age_days: p.age_days,
  };
}

/** Fields to spread into an Invoice/Bill body: { CurrencyCode, CurrencyRate }. */
export function invoiceCurrencyFields(r) {
  return { CurrencyCode: r.CurrencyCode, CurrencyRate: r.CurrencyRate };
}

export const CSV_COLUMNS = [
  'bank',
  'rate_date',
  'base_currency',
  'document_currency',
  'currency_rate',
  'rate_type',
  'method',
  'derived',
  'stale',
  'age_days',
];

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV of official rates, one row per document currency. */
export function ratesToCsv(baseCurrency, rows) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows) {
    lines.push(
      [r.bank, r.rate_date, baseCurrency, r.CurrencyCode, r.CurrencyRate, r.rate_type, r.method, r.derived, r.stale, r.age_days]
        .map(csvCell)
        .join(',')
    );
  }
  return lines.join('\r\n') + '\r\n';
}

/**
 * Optional: currencies enabled in the Xero organisation (GET /Currencies).
 * @param {{ accessToken: string, tenantId: string }} opts
 */
export async function listOrganisationCurrencies({ accessToken, tenantId }) {
  if (!accessToken) throw new XeroError('XERO_ACCESS_TOKEN is required');
  if (!tenantId) throw new XeroError('XERO_TENANT_ID is required');
  const url = `${XERO_API}/Currencies`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, 'xero-tenant-id': tenantId, Accept: 'application/json' },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) throw new XeroError(`Xero ${res.status}`, { status: res.status, url, body });
  return (body?.Currencies ?? []).map((c) => c.Code);
}
