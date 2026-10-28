# Model Balance Panel · dsh-model-balance-panel

[![license](https://img.shields.io/github/license/qianhuang0721/dsh-model-balance-panel)](LICENSE)
[![release](https://img.shields.io/github/v/release/qianhuang0721/dsh-model-balance-panel)](https://github.com/qianhuang0721/dsh-model-balance-panel/releases)

A sidebar entry for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) that shows
**how much money and quota is left on every model provider configured in DSH**. Balances come from each
provider's own account endpoint, and **the panel refreshes every time you open it**.

> Unofficial plugin, not affiliated with DeepSeek. Figures come from third-party APIs and are for
> reference only; the provider's own billing page is authoritative.

![The balance panel: sidebar entry, plus per-provider balance and 5-hour / weekly / monthly quotas](docs/preview.png)

## What it shows

- A wallet icon in the left sidebar (after Plugins and Schedules). Clicking it opens the balance panel.
- One card per provider: the provider's **model list** (the model currently in use is highlighted)
  above its balance:
  - Subscription / quota providers (e.g. OpenCode Go): **5-hour, weekly and monthly quota** bars with
    used percentage, remaining USD derived from the quota cap, and reset time. ≥70% turns yellow,
    ≥90% red.
  - Money providers (DeepSeek API key / DSH account): available balance, plus granted and topped-up parts.
- Honest states: `Synced`, `No credential`, `Not supported`, `Failed` with the reason. A missing number
  is never rendered as a fake `0`.
- Refresh on open, plus a manual Refresh button. The Host reuses a snapshot for 5 seconds and coalesces
  concurrent requests, so repeated clicks do not hammer upstream APIs.

## Supported providers

| provider id | Source | Display |
| --- | --- | --- |
| `opencode-go` | `GET https://opencode.ai/zen/go/v1/usage` | 5h / weekly / monthly windows |
| `commandcode` | `GET https://api.commandcode.ai/alpha/*` | monthly credits, plus 5h / weekly when `windowLimits` is present |
| `deepseek-official`, `deepseek` | `GET https://api.deepseek.com/user/balance` | account money |
| `deepseek-account` | `ctx.deepseekAccount.getBalance()` (signed-in account, no API key) | account money |

Providers without a billing API are **not hidden**: the card says `Not supported`.
Adding a provider is one entry in `PROVIDERS` in `index.js`; the browser half needs no change.

## Install

```bash
dsh plugin --profile <your-profile> add "git+https://github.com/qianhuang0721/dsh-model-balance-panel.git#v0.1.0"
```

Or install this repository from the in-app plugin manager. No build step, no dependencies, no install
scripts. Refresh the page afterwards to see the sidebar icon.

## How it works

```
Browser (client.js)                         Host (index.js)
  sidebar.panellist icon  ──click──▶  main panel
        │                                    │
        └── GET /dsh-model-balance-panel/snapshot ──▶ build snapshot
                                                     ├─ ctx.llm.listProviders() / listModels()
                                                     ├─ agentDefaultModel.currentSelection()
                                                     ├─ ctx.credentials.resolve(<ref>)
                                                     └─ provider account APIs (Bearer, 20s timeout + retry)
```

Credentials are resolved for a single request through `ctx.credentials.resolve()` (falling back to the
process environment). **API keys never enter the response, the page, or disk.** The snapshot route returns
numbers only, is same-origin, GET-only and `no-store`.

## Compatibility

- DSH `>= 0.2.1-rc.3` (declared in `engines.dsh`, tested on 0.2.1-rc.3).
- Node.js `>= 22.12.0`.
- Uses only public DSH extension points (`ctx.webServer`, `ctx.llm`, `ctx.credentials`,
  `agentDefaultModel`, `ctx.slots`, `ctx.locale`) and imports **no** `@deepseek-ai/*` runtime package,
  so a DSH upgrade cannot make the bundle disappear over a peer-dependency mismatch.

## Privacy

The plugin reads balance and quota numbers only. It does not read conversations, does not collect
telemetry, and sends no analytics anywhere.

## License

[MIT](LICENSE) © 2026 qianhuang0721
