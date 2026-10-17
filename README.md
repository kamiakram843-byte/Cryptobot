# Cryptobot
Cryptoboy

# TrendPilot AI

A paper-first cryptocurrency trading bot starter for Binance and Bitget, with a mobile-friendly dashboard, Node.js backend, and technical-indicator strategy.

## Features

- Binance and Bitget exchange adapters through CCXT.
- Spot markets and USDT-margined swap market configuration.
- RSI, Bollinger Bands, MACD histogram, ATR and volume analysis.
- Buy-low/sell-high reversal signal logic.
- Risk-based sizing, maximum position count and daily realized-loss limit.
- Software-monitored stop-loss and take-profit levels.
- JSONL trade-event log.
- Dashboard password protection.
- Paper trading by default.

## Requirements

- Node.js 20 or newer.
- npm.
- Internet access to exchange public APIs.

## Install

Clone your private repository, then run:

```bash
npm install
cp .env.example .env
npm run check
npm start
```

On Windows, copy `.env.example` to `.env` manually.

Open `http://localhost:3000`.

Set a strong `DASHBOARD_PASSWORD` in `.env`. Do not commit `.env`.

## Initial configuration

Keep these settings initially:

```dotenv
TRADING_MODE=PAPER
EXCHANGE=binance
MARKET=spot
RISK_PER_TRADE=0.01
```

Change `EXCHANGE` to `bitget` to use Bitget. Change `MARKET` to `swap` for USDT-margined perpetual swaps, after testing the exchange configuration.

For Bitget, provide `BITGET_API_KEY`, `BITGET_API_SECRET` and `BITGET_API_PASSWORD` only in the private runtime environment when needed.

## GitHub setup

1. Create a private repository named `TrendPilot-AI`.
2. Add `server.js`, `strategy.js`, `package.json`, `.env.example`, `.gitignore`, and `README.md` at the repository root.
3. Create `public/` and add `index.html` inside it.
4. Commit the source files.
5. Never commit `.env`, API credentials, or account secrets.

GitHub stores source code; it does not keep this bot running by itself.

## Hosting

Use a persistent Node.js host that supports long-running processes and environment variables. Configure the start command as:

```bash
npm start
```

Set environment variables in the host's secret/configuration panel. Do not expose API keys to browser JavaScript. Use HTTPS when accessing the dashboard remotely.

Some free hosting services sleep or erase local files. That can interrupt monitoring and lose local trade logs. Use persistent storage if required.

## Risk and live-trading warning

Paper trading is the default.

The starter's stop-loss and take-profit levels are monitored by the backend. They are not guaranteed exchange-native protective orders. A server outage, network failure, slippage, partial fill, or rejected order can leave a live position unprotected.

Before any live trading, implement and test:
- Exchange-native protective exits where supported.
- Partial-fill and order-status reconciliation.
- Restart recovery against actual exchange positions and open orders.
- Futures contract-size, margin-mode, leverage and position-mode validation.
- Exchange-specific fee, precision, minimum-notional and reduce-only behavior.
- Persistent state with atomic writes and reliable backups.
- Rate-limit handling, alerts, and a kill switch.
- A production-grade authentication and HTTPS setup.

Do not use leverage or real funds until these tests are complete. Disable withdrawal permissions on API keys and restrict key access where possible.

## Tests

Run:

```bash
npm run check
```

This checks JavaScript syntax. It does not validate live order execution, profitability, exchange compatibility, or safe handling of every failure mode.

## Strategy

The strategy scores reversal signals using:
- Price near the lower or upper Bollinger Band.
- RSI oversold/overbought conditions.
- MACD histogram momentum change.
- Relative volume expansion.

The signals are heuristics, not predictions or guarantees. Backtest and paper-test across different market conditions before considering live execution.

