#!/usr/bin/env node
// cb-accounting-sync - official central-bank rates into QuickBooks Online / Xero.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient, tableCurrencies, inferHomeCurrency, AllRatesTodayError } from '../src/allratestoday.js';
import { createQuickBooksClient, buildExchangeRatePayload, QuickBooksError } from '../src/quickbooks.js';
import { officialCurrencyRate, ratesToCsv, listOrganisationCurrencies, XeroError } from '../src/xero.js';

const USAGE = `cb-accounting-sync - push official central-bank rates into QuickBooks Online, or export them for Xero

Usage
  cb-accounting-sync rate     --bank <code> --source <CCY> --target <CCY>
  cb-accounting-sync qbo      --bank <code> --home <CCY> [--currencies USD,GBP] [--dry-run] [--sandbox]
  cb-accounting-sync xero-csv --bank <code> --home <CCY> [--currencies EUR,USD] [--out rates.csv]

Options
  --bank        central bank / tax authority code, e.g. ecb, boe, rbi, fed, hmrc
                (coverage map: https://allratestoday.com/central-bank-rates-api/)
  --home        home / base currency of the accounting company (QBO home currency, Xero base currency)
  --currencies  comma list of foreign currencies; default = QBO: company currencies (needs token),
                Xero: every currency in the bank's table
  --open        use the keyless evaluation endpoint even if ALLRATESTODAY_API_KEY is set
  --dry-run     qbo: print the ExchangeRate payloads instead of POSTing them
  --sandbox     qbo: use sandbox-quickbooks.api.intuit.com (or QBO_SANDBOX=1)
  --out <file>  xero-csv: write CSV to a file instead of stdout
  --json        rate: raw JSON only (default); qbo/xero-csv: machine-readable summary on stdout

Environment (.env in the working directory is read if present)
  ALLRATESTODAY_API_KEY   free key from https://allratestoday.com/signup/ ; without it the keyless endpoint is used
  QBO_ACCESS_TOKEN  QBO_REALM_ID  QBO_SANDBOX
  XERO_ACCESS_TOKEN XERO_TENANT_ID
`;

function loadDotEnv() {
  const p = resolve(process.cwd(), '.env');
  if (!existsSync(p)) return;
  for (const raw of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i];
      else out[a.slice(2)] = true;
    } else out._.push(a);
  }
  return out;
}

const truthy = (v) => v === true || /^(1|true|yes)$/i.test(String(v ?? ''));
const ccyList = (s) => String(s).split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);
const need = (args, k) => {
  if (!args[k] || args[k] === true) throw new UsageError(`--${k} is required`);
  return String(args[k]);
};
class UsageError extends Error {}

function freshnessNote(p) {
  const parts = [`${p.bank.toUpperCase()} ${p.rate_date}`];
  if (p.method && p.method !== 'published') parts.push(p.method);
  if (p.stale) parts.push(`STALE ${p.age_days}d`);
  return parts.join(' / ');
}

async function cmdRate(art, args) {
  const p = await art.pair({ bank: need(args, 'bank'), source: need(args, 'source'), target: need(args, 'target'), home: args.home });
  if (!p) throw new Error(`${args.bank} does not publish a rate for ${args.source}/${args.target}`);
  process.stdout.write(JSON.stringify(p, null, 2) + '\n');
}

async function cmdQbo(art, args) {
  const bank = need(args, 'bank');
  const home = need(args, 'home').toUpperCase();
  const dryRun = truthy(args['dry-run']);
  const sandbox = truthy(args.sandbox) || truthy(process.env.QBO_SANDBOX);
  const token = process.env.QBO_ACCESS_TOKEN;
  const realmId = process.env.QBO_REALM_ID;

  let qbo = null;
  if (!dryRun || (token && realmId)) {
    if (!token || !realmId) {
      throw new UsageError('QBO_ACCESS_TOKEN and QBO_REALM_ID are required (or use --dry-run to preview payloads)');
    }
    qbo = createQuickBooksClient({ accessToken: token, realmId, sandbox });
  }

  let currencies = args.currencies ? ccyList(args.currencies) : null;
  if (!currencies && qbo) currencies = (await qbo.listCompanyCurrencies()).filter((c) => c !== home);
  if (!currencies) throw new UsageError('--currencies is required when no QuickBooks token is set');

  console.error(`[qbo] ${sandbox ? 'sandbox' : 'production'} realm=${realmId ?? '(dry run)'} home=${home} bank=${bank} ${art.keyless ? 'keyless' : 'keyed'}`);
  const results = [];
  for (const ccy of currencies) {
    // QBO: Rate = home units per 1 unit of SourceCurrencyCode -> source = foreign, target = home
    const p = await art.pair({ bank, source: ccy, target: home });
    if (!p) {
      console.error(`[qbo] ${ccy}: skipped, ${bank} table has no ${ccy}/${home} rate`);
      results.push({ currency: ccy, status: 'skipped' });
      continue;
    }
    const payload = buildExchangeRatePayload(p);
    if (dryRun) {
      console.error(`[qbo] ${ccy}: ${freshnessNote(p)} -> POST ${sandbox ? 'sandbox' : 'production'} /v3/company/{realmId}/exchangerate`);
      process.stdout.write(JSON.stringify(payload) + '\n');
      results.push({ currency: ccy, status: 'dry-run', payload, derived: p.derived, method: p.method });
      continue;
    }
    const saved = await qbo.upsertExchangeRate(payload);
    console.error(`[qbo] ${ccy}: ${freshnessNote(p)} -> saved Rate=${saved?.Rate ?? payload.Rate} AsOfDate=${saved?.AsOfDate ?? payload.AsOfDate}`);
    results.push({ currency: ccy, status: 'saved', payload, derived: p.derived, method: p.method });
  }
  if (truthy(args.json) && !dryRun) process.stdout.write(JSON.stringify({ bank, home, results }, null, 2) + '\n');
}

async function cmdXeroCsv(art, args) {
  const bank = need(args, 'bank');
  const home = need(args, 'home').toUpperCase();
  let currencies = args.currencies ? ccyList(args.currencies) : null;
  if (!currencies && process.env.XERO_ACCESS_TOKEN && process.env.XERO_TENANT_ID) {
    currencies = (await listOrganisationCurrencies({ accessToken: process.env.XERO_ACCESS_TOKEN, tenantId: process.env.XERO_TENANT_ID })).filter((c) => c !== home);
    console.error(`[xero] ${currencies.length} currencies enabled in the organisation`);
  }
  const table = await art.latestTable(bank);
  const tableHome = inferHomeCurrency(table.rates);
  if (!currencies) currencies = tableCurrencies(table.rates, home);

  const rows = [];
  for (const ccy of currencies) {
    // Xero: CurrencyRate = document-currency units per 1 base unit -> source = base, target = document currency
    const r = await officialCurrencyRate(art, { bank, baseCurrency: home, documentCurrency: ccy, home: tableHome });
    if (!r) {
      console.error(`[xero] ${ccy}: skipped, ${bank} table has no ${home}/${ccy} rate`);
      continue;
    }
    rows.push(r);
  }
  const csv = ratesToCsv(home, rows);
  if (args.out && args.out !== true) {
    writeFileSync(String(args.out), csv);
    console.error(`[xero] wrote ${rows.length} rows to ${args.out} (${table.bank.toUpperCase()} ${table.rate_date}${table.stale ? `, STALE ${table.age_days}d` : ''})`);
  } else {
    process.stdout.write(csv);
  }
}

async function main() {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || args.help || args.h) {
    process.stdout.write(USAGE);
    return;
  }
  const apiKey = process.env.ALLRATESTODAY_API_KEY;
  const open = truthy(args.open);
  const art = createClient({ apiKey, open });
  if (art.keyless) {
    console.error(
      open
        ? '[allratestoday] --open: keyless evaluation endpoint, latest table only'
        : '[allratestoday] no ALLRATESTODAY_API_KEY set: using the keyless evaluation endpoint (free key: https://allratestoday.com/signup/)'
    );
  }
  switch (cmd) {
    case 'rate':
      return cmdRate(art, args);
    case 'qbo':
      return cmdQbo(art, args);
    case 'xero-csv':
      return cmdXeroCsv(art, args);
    default:
      throw new UsageError(`unknown command "${cmd}"\n\n${USAGE}`);
  }
}

main().catch((err) => {
  if (err instanceof UsageError) {
    console.error(`error: ${err.message}`);
    process.exit(2);
  }
  if (err instanceof AllRatesTodayError || err instanceof QuickBooksError || err instanceof XeroError) {
    console.error(`error: ${err.message}`);
    if (err.body && typeof err.body === 'object') console.error(JSON.stringify(err.body, null, 2));
    process.exit(1);
  }
  console.error(`error: ${err.message}`);
  process.exit(1);
});
