// AllRatesToday central-bank rates client. Native fetch, no dependencies.
//
// Two endpoints are used, both documented at https://allratestoday.com/docs/#central-bank
//   keyed   GET /api/v1/central-bank/{bank}/latest[?source=X&target=Y]   (header X-API-Key)
//   keyless GET /api/open/central-bank/{bank}                             (table only, evaluation copy)
//
// With a key the pair endpoint resolves direction server-side ("1 source = rate target")
// and reports whether the number was published as-is, inverted, or crossed.
// Without a key the same resolution is done here from the open table, in the
// same preference order the server uses.

export const BASE_URL = 'https://allratestoday.com';

export const DISCLAIMER =
  'Official rates as published by the named central bank. On weekends/holidays the most recent published rate_date is returned.';

export class AllRatesTodayError extends Error {
  constructor(message, { status, url, body } = {}) {
    super(message);
    this.name = 'AllRatesTodayError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

function round10(v) {
  return Number(v.toPrecision(10));
}

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { Accept: 'application/json', ...headers } });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg = (body && typeof body === 'object' && (body.error || body.message)) || `HTTP ${res.status}`;
    throw new AllRatesTodayError(`AllRatesToday ${res.status}: ${msg}`, { status: res.status, url, body });
  }
  return body;
}

/**
 * Create a client.
 * @param {{ apiKey?: string, open?: boolean, baseUrl?: string }} opts
 *   apiKey  - free key from https://allratestoday.com/signup/ ; omit for keyless mode
 *   open    - force the keyless evaluation endpoint even when a key is set
 */
export function createClient({ apiKey, open = false, baseUrl = BASE_URL } = {}) {
  const keyless = open || !apiKey;

  /** Latest published table for a bank. Normalised to the keyed shape. */
  async function latestTable(bank) {
    const code = String(bank).toLowerCase();
    const url = keyless
      ? `${baseUrl}/api/open/central-bank/${encodeURIComponent(code)}`
      : `${baseUrl}/api/v1/central-bank/${encodeURIComponent(code)}/latest`;
    const body = await getJson(url, keyless ? {} : { 'X-API-Key': apiKey });
    return {
      bank: body.bank,
      name: body.name ?? body.attribution?.source ?? code.toUpperCase(),
      rate_date: body.rate_date,
      age_days: body.age_days,
      stale: Boolean(body.stale),
      cadence: body.cadence,
      rates: Array.isArray(body.rates) ? body.rates : [],
      disclaimer: body.disclaimer ?? DISCLAIMER,
      attribution: body.attribution,
      keyless,
    };
  }

  /**
   * One resolved pair: "1 source = rate target".
   * Returns null when the bank's table cannot produce the pair (keyed: HTTP 404).
   * @param {{ bank: string, source: string, target: string, home?: string }} p
   *   home - the bank's home currency, used for cross rates in keyless mode;
   *          inferred from the table when omitted.
   */
  async function pair({ bank, source, target, home }) {
    const code = String(bank).toLowerCase();
    source = String(source).toUpperCase();
    target = String(target).toUpperCase();

    if (!keyless) {
      const url = `${baseUrl}/api/v1/central-bank/${encodeURIComponent(code)}/latest?source=${source}&target=${target}`;
      try {
        const body = await getJson(url, { 'X-API-Key': apiKey });
        return { ...body, keyless: false };
      } catch (err) {
        if (err instanceof AllRatesTodayError && err.status === 404) return null;
        throw err;
      }
    }

    const table = await latestTable(code);
    const homeCcy = (home || inferHomeCurrency(table.rates) || '').toUpperCase();
    const r = computePair(table.rates, source, target, homeCcy);
    if (!r) return null;
    return {
      bank: table.bank,
      name: table.name,
      rate_date: table.rate_date,
      source,
      target,
      rate: r.value,
      rate_type: r.type,
      derived: r.derived,
      method: r.method,
      age_days: table.age_days,
      stale: table.stale,
      cadence: table.cadence,
      disclaimer: table.disclaimer,
      attribution: table.attribution,
      keyless: true,
    };
  }

  return { keyless, latestTable, pair };
}

/**
 * Resolve source->target from a published table. Mirrors the server's order:
 * the published pair itself, then its inverse, then a cross via the home currency.
 * Anything not printed by the bank is flagged derived.
 * @returns {{ value:number, type:string, method:'published'|'inverse'|'cross', derived:boolean } | null}
 */
export function computePair(rates, source, target, homeCcy) {
  if (source === target) return { value: 1, type: 'identity', method: 'published', derived: false };
  for (const type of [...new Set(rates.map((r) => r.type))]) {
    const rows = rates.filter((r) => r.type === type);
    const find = (b, q) => rows.find((r) => r.base === b && r.quote === q);

    const direct = find(source, target);
    if (direct) return { value: direct.value, type, method: 'published', derived: false };

    const inverse = find(target, source);
    if (inverse && inverse.value !== 0) {
      return { value: round10(1 / inverse.value), type, method: 'inverse', derived: true };
    }

    // home-per-unit tables (e.g. RBI: USD->INR rows): source->target = (home per source) / (home per target)
    const sourceHome = find(source, homeCcy);
    const targetHome = find(target, homeCcy);
    if (sourceHome && targetHome && targetHome.value !== 0) {
      return { value: round10(sourceHome.value / targetHome.value), type, method: 'cross', derived: true };
    }

    // units-per-home tables (e.g. ECB: EUR->USD rows): source->target = (target per home) / (source per home)
    const homeSource = find(homeCcy, source);
    const homeTarget = find(homeCcy, target);
    if (homeSource && homeTarget && homeSource.value !== 0) {
      return { value: round10(homeTarget.value / homeSource.value), type, method: 'cross', derived: true };
    }
  }
  return null;
}

/** The currency that appears in every row of a table (ECB: EUR as base; RBI: INR as quote). */
export function inferHomeCurrency(rates) {
  if (!rates.length) return null;
  const count = new Map();
  for (const r of rates) {
    for (const c of new Set([r.base, r.quote])) count.set(c, (count.get(c) || 0) + 1);
  }
  let best = null;
  for (const [c, n] of count) if (!best || n > best[1]) best = [c, n];
  return best ? best[0] : null;
}

/** All currencies in a table other than the home currency. */
export function tableCurrencies(rates, homeCcy) {
  const set = new Set();
  for (const r of rates) {
    if (r.base !== homeCcy) set.add(r.base);
    if (r.quote !== homeCcy) set.add(r.quote);
  }
  return [...set].sort();
}
