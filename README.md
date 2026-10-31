# Central Bank Rates → QuickBooks Online & Xero

[![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Central banks](https://img.shields.io/badge/sources-121%20central%20banks%20%2B%203%20tax%20authorities-1B7A40)](https://allratestoday.com/central-bank-rates-api/)
[![Hosted MCP](https://img.shields.io/badge/MCP-allratestoday.com%2Fapi%2Fmcp-7c3aed)](https://allratestoday.com/api/mcp)

Fetch the **official exchange rate published by a central bank or tax authority** from the
[AllRatesToday Central Bank Rates API](https://allratestoday.com/central-bank-rates-api/) and put it where
your books need it: the **QuickBooks Online `ExchangeRate` table**, or the **`CurrencyRate` field** on Xero
invoices, bills, credit notes and manual journals.

Plain Node.js ESM, native `fetch`, zero dependencies.

> Official rates as published by the named central bank. On weekends/holidays the most recent published rate_date is returned.

## 🚀 What it does

| Command | Target | What happens |
|---|---|---|
| `cb-accounting-sync qbo --bank ecb --home EUR --currencies USD,GBP` | QuickBooks Online | One `POST /v3/company/{realmId}/exchangerate` per currency: `SourceCurrencyCode` = foreign currency, `Rate` = home units per 1 foreign unit, `AsOfDate` = the bank's `rate_date`. Re-running the same day updates in place. |
| `cb-accounting-sync xero-csv --bank rbi --home INR` | Xero | CSV of `CurrencyRate` values (document-currency units per 1 base unit, 6 decimals) for every currency in the bank's table, ready for bulk invoice/bill creation or import. |
| `cb-accounting-sync rate --bank ecb --source USD --target EUR` | anywhere | One resolved pair as JSON: `1 USD = rate EUR`, with `derived`/`method` telling you whether the bank printed that number. |

Works with 121 central banks and 3 tax authorities (ECB, Bank of England, Federal Reserve H.10, RBI, HMRC, US Treasury, ...). Bank codes:
[coverage map](https://allratestoday.com/central-bank-rates-api/).

## 🏁 Install

```bash
git clone <this repository> central-bank-rates-accounting-sync
cd central-bank-rates-accounting-sync
cp .env.example .env     # fill in what you use
node bin/cli.js --help
```

Node 18 or newer (native `fetch`). `npm install` is not needed: there are no dependencies.
`npm link` puts `cb-accounting-sync` on your PATH if you prefer the short form used below.

Try it before configuring anything (keyless evaluation endpoint, no account):

```bash
node bin/cli.js rate --bank ecb --source USD --target EUR --open
node bin/cli.js qbo --bank ecb --home EUR --currencies USD,GBP --open --dry-run
```

## ⚙️ Setup

All configuration is environment variables; a `.env` in the working directory is read if present (see [`.env.example`](.env.example)).

| Variable | Purpose | Where to get it |
|---|---|---|
| `ALLRATESTODAY_API_KEY` | Keyed access: server-side pair resolution (any key); dated tables and history (paid plans only). Unset → keyless evaluation endpoint. | Free key, no card: <https://allratestoday.com/register/> · official-rates plan: <https://allratestoday.com/pricing/#official> |
| `QBO_ACCESS_TOKEN` | OAuth 2.0 bearer token for the QuickBooks Online Accounting API | [Intuit OAuth 2.0 guide](https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0) · quick test tokens from the [OAuth Playground](https://developer.intuit.com/app/developer/playground) |
| `QBO_REALM_ID` | The company id (`realmId`) returned with the token | same |
| `QBO_SANDBOX` | `1` → `https://sandbox-quickbooks.api.intuit.com`, otherwise `https://quickbooks.api.intuit.com` | [Sandbox companies](https://developer.intuit.com/app/developer/qbo/docs/develop/sandboxes/manage-your-sandboxes) |
| `XERO_ACCESS_TOKEN` | OAuth 2.0 bearer token (only used to list the organisation's enabled currencies) | [Xero OAuth 2.0 auth flow](https://developer.xero.com/documentation/guides/oauth2/auth-flow/) |
| `XERO_TENANT_ID` | `xero-tenant-id` header value | [Xero tenants](https://developer.xero.com/documentation/guides/oauth2/tenants/) |

Flags: `--open` forces the keyless endpoint even with a key set; `--dry-run` (qbo) prints payloads without sending;
`--sandbox` (qbo) is the same as `QBO_SANDBOX=1`; `--out file.csv` (xero-csv) writes to a file.

### Keyed vs keyless

| | Keyed (`ALLRATESTODAY_API_KEY`) | Keyless (`--open` or no key) |
|---|---|---|
| Endpoint | `GET /api/v1/central-bank/{bank}/latest?source=USD&target=EUR` (`Authorization: Bearer` header) | `GET /api/open/central-bank/{bank}` (latest table only) |
| Direction | Resolved server-side: `1 source = rate target` | Same preference order, computed locally from the table |
| Dated tables / history | paid plans only (`/api/v1/central-bank/{bank}/{YYYY-MM-DD}`); free and trial keys get 403 | no |
| Use for | production bookkeeping | evaluation |

## 🧾 QuickBooks Online

QuickBooks Online lets a company override the downloaded market rate per currency per day through the Accounting API
[`ExchangeRate` entity](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/exchangerate).
`Rate` is **home-currency units per 1 unit of `SourceCurrencyCode`**, in force on `AsOfDate`. Transactions dated that day
pick the override up unless a rate was set on the transaction itself.

```bash
# EUR company, ECB reference rates, two currencies, preview only
cb-accounting-sync qbo --bank ecb --home EUR --currencies USD,GBP --dry-run
```

```text
[qbo] production realm=(dry run) home=EUR bank=ecb keyless
[qbo] USD: ECB 2026-10-09 / inverse -> POST production /v3/company/{realmId}/exchangerate
{"SourceCurrencyCode":"USD","Rate":0.8923790826,"AsOfDate":"2026-10-09"}
[qbo] GBP: ECB 2026-10-09 / inverse -> POST production /v3/company/{realmId}/exchangerate
{"SourceCurrencyCode":"GBP","Rate":1.179760037,"AsOfDate":"2026-10-09"}
```

Drop `--dry-run` with `QBO_ACCESS_TOKEN` and `QBO_REALM_ID` set and each payload is sent as
`POST https://quickbooks.api.intuit.com/v3/company/{realmId}/exchangerate?minorversion=75`
with `Accept`/`Content-Type: application/json`. Omit `--currencies` and the tool reads the company's enabled currencies
(`SELECT * FROM CompanyCurrency`) and syncs all of them.

What the request and response look like:

```http
POST /v3/company/{realmId}/exchangerate?minorversion=75
Authorization: Bearer <QBO_ACCESS_TOKEN>
Accept: application/json
Content-Type: application/json

{"SourceCurrencyCode":"USD","Rate":0.8923790826,"AsOfDate":"2026-10-09"}
```

Read back what QuickBooks holds for a currency and date:

```http
GET /v3/company/{realmId}/exchangerate?sourcecurrencycode=USD&asofdate=2026-10-09&minorversion=75
```

From code (not published on npm: import from a clone, paths relative to the repo root):

```js
import { createClient } from './src/allratestoday.js';
import { createQuickBooksClient, buildExchangeRatePayload } from './src/quickbooks.js';

const art = createClient({ apiKey: process.env.ALLRATESTODAY_API_KEY });
const qbo = createQuickBooksClient({
  accessToken: process.env.QBO_ACCESS_TOKEN,
  realmId: process.env.QBO_REALM_ID,
  sandbox: process.env.QBO_SANDBOX === '1',
});

for (const ccy of await qbo.listCompanyCurrencies()) {
  const pair = await art.pair({ bank: 'ecb', source: ccy, target: 'EUR' }); // 1 ccy = rate EUR
  if (!pair) continue;                                                       // bank does not cover ccy
  await qbo.upsertExchangeRate(buildExchangeRatePayload(pair));             // { SourceCurrencyCode, Rate, AsOfDate }
}
```

`TargetCurrencyCode` exists on the entity but is left out of the payload: in QuickBooks the target is always the
company home currency. Full walk-through: <https://allratestoday.com/docs/integrations/quickbooks/>.

## 🧾 Xero

Xero fills its organisation-level rates from XE.com and has **no API to replace that table**. What the Accounting API
accepts is a rate per document: `Invoices`, `CreditNotes`, `BankTransactions`, `Overpayments` and `ManualJournals` carry a
[`CurrencyRate`](https://developer.xero.com/documentation/api/accounting/invoices) (number, max length `[18].[6]`; if
omitted Xero applies the XE.com day rate). `CurrencyRate` is **document-currency units per 1 unit of the organisation
base currency**, so for a GBP organisation raising a EUR invoice you need EUR per GBP.

Helper for one document:

```js
import { createClient } from './src/allratestoday.js';
import { officialCurrencyRate, invoiceCurrencyFields } from './src/xero.js';

const art = createClient({ apiKey: process.env.ALLRATESTODAY_API_KEY });
const r = await officialCurrencyRate(art, { bank: 'boe', baseCurrency: 'GBP', documentCurrency: 'EUR' });
// r = { CurrencyCode: 'EUR', CurrencyRate: 1.17976, Reference: 'BOE 2026-10-09', rate_date, derived, method, ... }

const invoice = {
  Type: 'ACCREC',
  Contact: { ContactID: contactId },
  Date: r.rate_date,
  DueDate: '2026-11-09',
  Reference: r.Reference,            // keeps the publisher + date on the document for the auditor
  LineItems: [{ Description: 'Consulting', Quantity: 1, UnitAmount: 1000, AccountCode: '200' }],
  ...invoiceCurrencyFields(r),       // CurrencyCode + CurrencyRate
};
// POST https://api.xero.com/api.xro/2.0/Invoices  (Authorization: Bearer ..., xero-tenant-id: ...)
```

Bulk export for month-end, imports or a spreadsheet close:

```bash
cb-accounting-sync xero-csv --bank rbi --home INR --out rbi-inr.csv
```

```csv
bank,rate_date,base_currency,document_currency,currency_rate,rate_type,method,derived,stale,age_days
rbi,2026-10-09,INR,AED,0.038016,reference,inverse,true,false,2
rbi,2026-10-09,INR,EUR,0.009219,reference,inverse,true,false,2
rbi,2026-10-09,INR,GBP,0.007819,reference,inverse,true,false,2
rbi,2026-10-09,INR,JPY,1.637197,reference,inverse,true,false,2
rbi,2026-10-09,INR,USD,0.01035,reference,inverse,true,false,2
```

With `XERO_ACCESS_TOKEN` + `XERO_TENANT_ID` set and no `--currencies`, the list comes from the organisation's
enabled currencies (`GET /api.xro/2.0/Currencies`). Full walk-through: <https://allratestoday.com/docs/integrations/xero/>.

## 🧭 Reading the numbers

Every pair the tool returns is `1 source = rate target` and carries:

| Field | Meaning |
|---|---|
| `rate_date` | The date the bank published the table. On weekends/holidays this is the most recent publication, which is the rate in force. QuickBooks `AsOfDate` is set to it. |
| `derived` / `method` | `method: "published"` → the bank printed exactly this pair. `"inverse"` → the bank printed the opposite direction; the value is `1 / published`. `"cross"` → neither direction was printed; the value is computed through the bank's home currency from two published rows. Anything but `published` has `derived: true`. |
| `rate_type` | The bank's own label for the table (`reference`, `buying`, `selling`, `middle`, ...). |
| `age_days` / `stale` | Days since `rate_date`; `stale` is set when the table is older than the bank's cadence allows. The CLI prints `STALE` next to the date. |
| `cadence` | `daily`, `weekly`, `monthly`, `quarterly` depending on the publisher. |

Direction examples with the ECB table (published as `EUR → X`):

```text
rate --bank ecb --source EUR --target USD   published   1.1206        (as printed)
rate --bank ecb --source USD --target EUR   inverse     0.8923790826  (1 / 1.1206)
rate --bank ecb --source USD --target GBP   cross       0.7564072818  (0.84763 / 1.1206)
```

The CLI asks for exactly the pair each system expects (QBO: foreign → home; Xero: base → document currency), so you
never invert by hand. Official tables are published to 4–5 decimals; the inverse/cross values keep 10 significant digits
and the Xero helper rounds to the 6 decimals Xero stores.

## 🔁 Scheduling

Run once per business day after the bank's publication time (ECB ~16:00 CET, Bank of England ~16:00 London, RBI ~13:30 IST).
Re-posting the same currency and date is idempotent in QuickBooks.

**cron** (17:30 CET on weekdays, EUR company, ECB rates):

```cron
30 17 * * 1-5  cd /opt/central-bank-rates-accounting-sync && node bin/cli.js qbo --bank ecb --home EUR >> /var/log/cb-qbo.log 2>&1
```

**GitHub Actions** (secrets: `ALLRATESTODAY_API_KEY`, `QBO_ACCESS_TOKEN`, `QBO_REALM_ID`; refresh the QBO token in your
own step or secret rotation, access tokens expire after 1 hour):

```yaml
name: Official rates into QuickBooks Online
on:
  schedule:
    - cron: '30 16 * * 1-5'   # 16:30 UTC, weekdays, after the ECB reference rates
  workflow_dispatch:
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Push ECB rates into QuickBooks
        env:
          ALLRATESTODAY_API_KEY: ${{ secrets.ALLRATESTODAY_API_KEY }}
          QBO_ACCESS_TOKEN: ${{ secrets.QBO_ACCESS_TOKEN }}
          QBO_REALM_ID: ${{ secrets.QBO_REALM_ID }}
        run: node bin/cli.js qbo --bank ecb --home EUR
      - name: Export Xero CurrencyRate CSV
        env:
          ALLRATESTODAY_API_KEY: ${{ secrets.ALLRATESTODAY_API_KEY }}
        run: node bin/cli.js xero-csv --bank ecb --home EUR --out ecb-eur.csv
      - uses: actions/upload-artifact@v4
        with:
          name: xero-currency-rates
          path: ecb-eur.csv
```

## 🏛️ Sources

The rates come from the publishing institutions themselves, served by AllRatesToday: 121 central banks and 3 tax
authorities (HMRC, US Treasury, Swiss BAZG). Each response names the bank, the publication date and the bank's own
rate type, and nothing is blended across publishers.

| | |
|---|---|
| Coverage map and bank codes | <https://allratestoday.com/central-bank-rates-api/> |
| Endpoint reference | <https://allratestoday.com/docs/#central-bank> |
| QuickBooks Online guide | <https://allratestoday.com/docs/integrations/quickbooks/> |
| Xero guide | <https://allratestoday.com/docs/integrations/xero/> |
| Free API key | <https://allratestoday.com/register/> |
| Official Rates Business plan | <https://allratestoday.com/pricing/#official> |

> Official rates as published by the named central bank. On weekends/holidays the most recent published rate_date is returned.

## 🤖 AI agents

The same data is available to agents over MCP without a key: hosted Streamable HTTP endpoint
`https://allratestoday.com/api/mcp` (tools for official rates, bank lists, rate history and publication calendars).
Point Claude Desktop, Cursor or any MCP client at that URL, or let an agent call this tool's modules directly (not published on npm: import from a clone, paths relative to the repo root):

```js
import { createClient } from './src/allratestoday.js';
const art = createClient();                       // keyless
const p = await art.pair({ bank: 'boe', source: 'GBP', target: 'USD' });
console.log(p.rate, p.rate_date, p.method);       // 1 GBP = p.rate USD
```

Agents that need keyed latest tables or crosses beyond the keyless endpoint can self-issue a trial key: `POST https://allratestoday.com/api/agent/keys` (send `Content-Type: application/json`) returns a 100-call key valid 7 days, no account needed (dated tables and history are paid-plan only, on free and trial keys alike); the MCP servers expose the same as `request_trial_key`.

## 🔗 Links

- **Website:** [allratestoday.com](https://allratestoday.com)
- [API Documentation](https://allratestoday.com/developers)
- [Register (Free)](https://allratestoday.com/register)
- [Dashboard](https://allratestoday.com/profile)
- [Status](https://allratestoday.com/status)
- [Postman collection](https://allratestoday.com/postman/)
- [GitHub](https://github.com/AllRates-Today/central-bank-rates-accounting-sync)

## 📜 License

[MIT](LICENSE) © AllRatesToday. Rates remain the property of the publishing central banks and tax authorities; the
keyless endpoint is free to use with visible attribution linking to allratestoday.com.
