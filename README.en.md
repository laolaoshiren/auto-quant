# auto-quant

**A crypto trading terminal where the strategy is written in plain language.**

**English** · [简体中文](README.md)

[![Node](https://img.shields.io/badge/node-%E2%89%A522.5-blue)](package.json)
[![Dependencies](https://img.shields.io/badge/dependencies-no%20copyleft-brightgreen)](THIRD-PARTY-NOTICES.md)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

A strategy is not a pile of parameters — it is a paragraph of prose. Every cycle the model
reads the market, makes a decision, places orders, and leaves its full reasoning behind.
A **risk engine that sits outside the model** then reviews and clamps every order it emits.

> The model judges. The runtime adjudicates.

---

## 🚀 One-command deploy

On a **fresh server**, one command:

```bash
curl -fsSL https://raw.githubusercontent.com/laolaoshiren/auto-quant/main/deploy/install.sh | bash
```

**That is all. Nothing else required.** It will:

- Detect the OS and install any missing base tooling (**including when the system has no `bash`**)
- **Install Docker and Compose** if absent
- Generate configuration and random secrets
- Pull the image, start the service, wait for the health check
- Print the access URL and login credentials

**You need nothing preinstalled** — no Node, no source checkout, no Docker knowledge, and no tokens.

Supports Debian / Ubuntu, RHEL / CentOS / Rocky / Alma, Fedora,
**Alpine (including minimal images without `bash`)**, Arch, openSUSE. x86_64 only.

To update to the latest version later, **still the same one command**.

> Prefer not to pipe? Same result:
>
> ```bash
> curl -fsSL https://raw.githubusercontent.com/laolaoshiren/auto-quant/main/deploy/install.sh -o install.sh
> > sudo bash install.sh
> ```
>
> It needs root — the installer re-executes itself with sudo when it is not. When piping, sudo reads
> the password from the terminal and this works fine.

📖 Full guide: [deploy/README.md](deploy/README.md) · [Deployment guide](docs/DEPLOYMENT.md)

---

## ✨ Capabilities

| | |
| --- | --- |
| 🧠 **Natural-language strategy** | Describe trading logic in prose — no code. Coin selection, indicators, risk limits and prompts are all configurable from the console |
| ⚡ **JEV mode (experimental)** | Each decision point is delegated to a purpose-built classifier: it only **chooses** (direction / size tier / stop tier / leverage / margin mode), while every number is computed by code beforehand. Roughly two orders of magnitude cheaper |
| 🛡️ **Hard risk engine** | Leverage, position caps, mandatory stop/target, risk-reward floor, drawdown protection, circuit breakers and throttling are adjudicated by a separate layer. **The model cannot bypass it** |
| 🔍 **Full decision audit** | Every cycle persists: the full prompt, the raw model response, the reasoning trace, and each clamp and rejection the risk engine applied — with reasons |
| 📊 **Books that reconcile with the exchange** | PnL is computed on the exchange's own accounting, and missing records can be rebuilt from fill history |
| 🔌 **Multi-exchange adapter layer** | Connection, contract metadata, order placement and market data behind one abstraction; adding an exchange touches only the adapter |
| 🤖 **Many model providers** | OpenAI-compatible endpoints, Anthropic, Gemini and others; model lists can be discovered live from the provider |
| 🧪 **Validate without spending money** | Strategy preflight, historical replay and full lifecycle simulation — verify the whole chain without real funds |
| 🐳 **Containerized deployment** | The server needs no Node, no source, no build step |

---

## 🎛️ Four operating modes

One engine, four answers to "who decides":

| Mode | Who decides | Cost per symbol | Best for |
| --- | --- | --- | --- |
| **Fixed strategy** | Code executes parameters mechanically | 0 | You already have explicit rules and want full predictability |
| **AI managed** | One general model reads the whole prompt and acts freely | High (thousands of tokens per call) | The task needs the model to grasp complex context |
| **Multi-agent team** | Several roles (analyst / risk officer / trader) collaborate | Highest | You want multiple perspectives cross-checked |
| **JEV mode** | A dedicated classifier picks point by point; every number is precomputed | **Very low** (~1.2k tokens per call) | High frequency, cost-sensitive, auditable |

### Why JEV mode is cheap — and where its limits are

It is not "a weaker AI"; it is **a different division of labour**:

```
General model : give it raw data → it computes size, stop, leverage → it emits numbers
                ⚠️ if it computes wrong, nobody notices

JEV           : code computes every candidate first (3 size tiers / 3 stop tiers /
                3 target tiers / a leverage range), then lays "A=5U  B=6.4U  C=9U"
                in front of the classifier → it only answers "B"
                ⚠️ the numbers cannot be wrong, because it did not compute them
```

**The cost of this division**: it cannot handle situations that require inference
(e.g. "this looks like a head-and-shoulders, so flip").  
**The payoff**: ~360 ms per call at ~1.2k input tokens — two orders of magnitude cheaper than a
general model — and **every decision traces back to exactly which question was answered how**.

### JEV mode knobs (all hot-applied, no restart)

| Group | Knobs |
| --- | --- |
| Coin selection | Selection mode (code filter / Jev judges) |
| Entry | Entry type, leverage (manual slider / Jev judges), margin mode (isolated / crossed / Jev judges) |
| Risk | Risk per trade (1–50%), max concurrent positions, margin-usage ceiling, daily-loss circuit breaker |
| Throttling | Max entries per cycle, max entries per hour, how often held positions are re-examined |
| Protection | Breakeven trigger, trailing-stop distance, allow shorts / resize / trailing, risk-reward floor |
| Thresholds | Minimum confidence, how many symbols to consider per cycle |

---

## 🧭 How it works

Every cycle a trading bot does four things:

```
Read market structure  →  Model decides  →  Risk engine adjudicates  →  Execute & record
      ↑                                                                        │
      └────────────────────  next cycle  ←──────────────────────────────────────┘
```

**1. Read market structure**
Fetch the configured timeframes and indicators and assemble a snapshot the model can read.
Candidates can come from the gainers board, open-interest growth, a static list, or a full-market screen.

**2. Model decides**
Hand the market snapshot, account state, current positions and your strategy prompt to the model
and require a structured decision in return.

**3. Risk engine adjudicates ← the critical layer**
The model's output is **untrusted input**. It may ask for 100x leverage, forget a stop, or propose an
unreasonable risk-reward ratio. The risk engine reviews each item and can do three things:

- **Reject** — proposals below the confidence floor, under the risk-reward floor, or over the size cap
  are dropped, and the reason is recorded
- **Clamp** — leverage pulled back to the cap, notional squeezed into budget, stops moved to sane
  levels; every adjustment is logged
- **Force** — an open without a stop is always rejected; a position whose protection cannot be placed
  is immediately closed at market

**4. Execute and record**
Orders, fills, PnL and the whole decision path go into the local database. Any "the risk engine
overruled the model" moment can be audited afterwards.

---

## 📦 Local development

Requires **Node.js ≥ 22.5** (uses the built-in `node:sqlite`, so no native modules to compile).

```bash
npm install
npm run dev          # backend → http://127.0.0.1:27137
npm run dev:web      # frontend HMR → http://127.0.0.1:5173
```

First start creates an admin account and prints a random password — **shown only once**.

### Verify

```bash
npm run typecheck    # type check
npm test             # unit tests
npm run verify       # run coin selection → indicators → prompt → parse → risk with real market data
npm run sim          # full trading lifecycle simulation (deterministic market + fake exchange)
npm run sim:live     # same, but against a real model
```

> `npm run verify` and `npm run sim` need **no API keys and place no real orders** —
> they are the highest-value check after any change.

### Live smoke test

After deploying and before committing real funds, verify the exchange wiring with a minimal position:

```bash
npx tsx packages/server/src/scripts/liveSmokeTest.ts --confirm
```

It walks the whole path: preflight → switch to one-way mode → set leverage → open at market →
place stop → place target → **read back from the exchange to confirm the protection actually exists** →
cancel → close → confirm the account is clean.

It only runs with `--confirm`, caps notional at 20 USDT, and puts cleanup in `finally`.
**It costs real money** — start with a minimal position.

---

## ⚙️ Configuration

Environment variables are documented in [`.env.example`](.env.example). Container deployments
generate them automatically via `deploy/up.sh`.

| Variable | Default | Notes |
| --- | --- | --- |
| `BINANCE_USE_TESTNET` | `true` | Testnet vs live. **The UI is identical for both, so a misconfiguration reports nothing** |
| `DRY_RUN` | `false` | When `true`, orders are simulated and the exchange is never touched |
| `GLOBAL_TRADING_DISABLED` | `false` | Global kill switch; when `true` no bot may start |
| `MASTER_KEY` | auto-generated | Master key that encrypts exchange credentials |
| `JWT_SECRET` | auto-generated | Session token signing key |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | auto-generated | Admin account created on first start |
| `BIND_ADDRESS` | `127.0.0.1` | Console bind address |

### Strategy configuration

Configure it in the console's **Strategy Studio**, or edit the strategy record directly in the
database. It has four groups:

- **Coin selection** — source (gainers / open interest / static list / full market), filters, candidate count
- **Indicators** — timeframe set, bar count, enabled indicators and their parameters
- **Risk** — position caps, leverage caps, stop/target rules, risk-reward floor, drawdown protection,
  circuit breakers, throttling
- **Prompt** — role framing, entry standards, decision workflow, output requirements; all freely editable

Three presets ship with the console — conservative, aggressive and short-term — each a starting
point you can tweak.

---

## 🏗️ Architecture

```
packages/
├── shared/    Type definitions, zod schemas, indicator math, model catalog
├── server/    Fastify API · exchange adapter · model client · strategy engine · risk engine · trading runtime · SQLite storage
└── web/       React console
```

| Module | Responsibility |
| --- | --- |
| Exchange adapter | Connection, contract metadata, signed requests, orders, conditional orders, market and user data streams |
| Model client | Unified interface across providers, error classification and retry, model-list discovery |
| Strategy engine | Coin selection, indicator assembly, prompt construction, model output parsing |
| **Risk engine** | The only path to an order. All limits and clamping live here |
| Trading runtime | Cycle scheduling, position reconciliation, protection-order management, fill reconstruction |
| **JEV decision layer** | Renders market state into a form a classifier can read; lets it **choose only**, with every number computed by code |
| Storage | SQLite (built-in `node:sqlite`, zero native dependencies) |

Further reading: [Architecture and trade-offs](docs/ARCHITECTURE.md) · [Module map and extension recipes](docs/MODULES.md)

---

## 📚 Documentation

| Document | Contents |
| --- | --- |
| [Development guide](docs/DEVELOPMENT.md) | Environment, commands, test strategy, debugging, common pitfalls |
| [Module map](docs/MODULES.md) | Per-file responsibilities + "to add a new X, change this" recipes |
| [Architecture](docs/ARCHITECTURE.md) | Design trade-offs and key engineering decisions |
| [API reference](docs/API.md) | Contracts for every HTTP endpoint |
| [Console visual spec](packages/web/DESIGN.md) | Palette, type scale, spacing, layout and responsive breakpoints |
| [Template guide](packages/web/TEMPLATES.md) | Swapping the shell/palette: interfaces, auto-discovery, contract tests, pitfalls |
| [Deployment guide](docs/DEPLOYMENT.md) | Release process, reverse proxy, security checklist |
| [Release manual](docs/RELEASING.md) | The maintainer's release process |
| [JEV mode design](docs/JEV-MODE-DESIGN.md) | Division of labour, cost model and live-tuning notes for the classifier mode |
| [AI agent guide](docs/AGENTS.md) | Working constraints for automated coding agents |
| [Legal checklist](docs/LEGAL.md) | Licence, exchange terms and regulatory risk, item by item |
| [Research notes](docs/research/README.md) | First-hand measurements of exchange and model interfaces |
| [Third-party notices](THIRD-PARTY-NOTICES.md) | Licences and copyright holders of runtime dependencies |

---

## 🤝 Contributing

This is a project **maintained by contributors in their spare time**. All forms of participation
are welcome.

| I want to… | Where to go |
| --- | --- |
| Report a bug or propose a feature | Open an issue with the reproduction steps and expected behaviour |
| Send code | Read [CONTRIBUTING.md](CONTRIBUTING.md), then open one pull request per iteration |
| Understand a design decision | Start with [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/MODULES.md](docs/MODULES.md) |
| Run it safely | Read [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) and start with `DRY_RUN=true` |

---

## ⚠️ Disclaimer and risk notice

> This section is a legal notice. It is reproduced in full and is not summarized away.

### 1. At your own risk: this tool loses real money

This software connects to cryptocurrency exchanges and **places real orders**. Cryptocurrency
derivatives are leveraged products; losses can exceed your deposit. You may lose all of your funds,
and in extreme cases owe more than you deposited.

**You are solely responsible for every order this software places on your behalf.** Do not deploy it
with money you cannot afford to lose entirely.

### 2. No warranty: the software may be defective

This software is provided "as is", without warranty of any kind, express or implied, including but
not limited to the warranties of merchantability, fitness for a particular purpose, and
non-infringement.

Trading logic, risk controls, order handling, reconciliation and position accounting **can all contain
defects**. A risk engine that appears to work may still fail under conditions its authors did not
anticipate. Automated tests passing does not mean the software is correct in production.

### 3. Limitation of liability

In no event shall the authors, copyright holders or contributors be liable for any claim, damages or
other liability — whether in an action of contract, tort or otherwise — arising from, out of or in
connection with the software or its use.

This expressly includes trading losses, lost profits, missed opportunities, exchange-imposed
penalties, and any indirect, incidental, special, exemplary or consequential damages.

### 4. Not investment advice, no fiduciary relationship

Nothing produced by this software — prompts, model output, reasoning traces, statistics, or the
console's displays — constitutes investment advice, a recommendation, or a solicitation to trade.

Your use of this software creates **no** advisory, fiduciary, or agency relationship between you and
its authors or contributors. The model's output is untrusted input by design; that is why a separate
risk layer adjudicates it.

### 5. Your compliance responsibility

You are responsible for complying with all laws and regulations applicable to you, including but not
limited to tax obligations, reporting requirements, and any prohibition or restriction on trading
cryptocurrency derivatives in your jurisdiction.

You are likewise responsible for complying with the terms of service of any exchange you connect,
including its rules on automated trading and API usage.

### 6. Indemnity

You agree to indemnify and hold harmless the authors, copyright holders and contributors from any
claim, loss, liability or expense (including reasonable legal fees) arising from your use of this
software or your breach of these terms.

### 7. Third-party services

This software depends on third-party services (exchanges, model providers, network infrastructure).
Their availability, correctness, pricing and terms are outside the authors' control, and the authors
make no representation about them. An outage, a pricing change or a change to an API contract can
cause losses.

### 8. Scope

This notice applies to the software as distributed in this repository. If you modify it and deploy
your own version, you do so entirely at your own risk, and the authors are not responsible for your
modifications.

---

## 📄 License

[Apache-2.0](LICENSE)


