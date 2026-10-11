// QuickBooks Online Accounting API - ExchangeRate entity.
//
// Reference: https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/exchangerate
// Entity fields (Intuit SDK schema): SourceCurrencyCode, TargetCurrencyCode, Rate, AsOfDate.
//   Rate = home-currency units per 1 unit of SourceCurrencyCode, in force on AsOfDate.
// Endpoints:
//   POST /v3/company/{realmId}/exchangerate            create or update (same currency + AsOfDate updates in place)
//   GET  /v3/company/{realmId}/exchangerate?sourcecurrencycode=X&asofdate=YYYY-MM-DD
// Base URLs: production https://quickbooks.api.intuit.com, sandbox https://sandbox-quickbooks.api.intuit.com
// Auth: OAuth 2.0 bearer token - https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0

export const QBO_PRODUCTION = 'https://quickbooks.api.intuit.com';
export const QBO_SANDBOX = 'https://sandbox-quickbooks.api.intuit.com';
export const MINOR_VERSION = 75;

export class QuickBooksError extends Error {
  constructor(message, { status, url, body } = {}) {
    super(message);
    this.name = 'QuickBooksError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/**
 * Build the ExchangeRate payload from a resolved AllRatesToday pair where
 * source = foreign currency and target = the company's home currency.
 * TargetCurrencyCode is left out: in QuickBooks the target is always the
 * company home currency.
 */
export function buildExchangeRatePayload(pair) {
  return {
    SourceCurrencyCode: pair.source,
    Rate: pair.rate,
    AsOfDate: pair.rate_date,
  };
}

/**
 * @param {{ accessToken: string, realmId: string, sandbox?: boolean, minorVersion?: number }} opts
 */
export function createQuickBooksClient({ accessToken, realmId, sandbox = false, minorVersion = MINOR_VERSION }) {
  if (!accessToken) throw new QuickBooksError('QBO_ACCESS_TOKEN is required');
  if (!realmId) throw new QuickBooksError('QBO_REALM_ID is required');
  const base = `${sandbox ? QBO_SANDBOX : QBO_PRODUCTION}/v3/company/${encodeURIComponent(realmId)}`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  async function request(method, path, params = {}, json) {
    const url = new URL(`${base}/${path}`);
    url.searchParams.set('minorversion', String(minorVersion));
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const res = await fetch(url, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    if (!res.ok) {
      const fault = body?.Fault?.Error?.[0];
      const msg = fault ? `${fault.Message}${fault.Detail ? ` - ${fault.Detail}` : ''}` : `HTTP ${res.status}`;
      throw new QuickBooksError(`QuickBooks ${res.status}: ${msg}`, { status: res.status, url: url.toString(), body });
    }
    return body;
  }

  /** Create or update one custom rate. Re-posting the same currency and AsOfDate updates it in place. */
  async function upsertExchangeRate(payload) {
    const body = await request('POST', 'exchangerate', {}, payload);
    return body?.ExchangeRate ?? body;
  }

  /** Read the rate QuickBooks holds for a currency on a date. */
  async function getExchangeRate(sourceCurrencyCode, asOfDate) {
    const body = await request('GET', 'exchangerate', { sourcecurrencycode: sourceCurrencyCode, asofdate: asOfDate });
    return body?.ExchangeRate ?? body;
  }

  /** Currency codes enabled in the company (multicurrency must be on). */
  async function listCompanyCurrencies() {
    const body = await request('GET', 'query', { query: 'SELECT * FROM CompanyCurrency' });
    return (body?.QueryResponse?.CompanyCurrency ?? []).map((c) => c.Code);
  }

  return { upsertExchangeRate, getExchangeRate, listCompanyCurrencies, baseUrl: base };
}
