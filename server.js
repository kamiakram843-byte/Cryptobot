
"use strict";

require("dotenv").config();
const express = require("express");
const ccxt = require("ccxt");
const { analyze } = require("./strategy");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));

const PORT = Number(process.env.PORT || 3000);
const USER = process.env.DASHBOARD_USER || "admin";
const PASSWORD = process.env.DASHBOARD_PASSWORD;

if (!PASSWORD || PASSWORD.length < 12) {
  console.error("Set DASHBOARD_PASSWORD to a strong password (12+ characters).");
  process.exit(1);
}

function safeEqual(a, b) {
  const crypto = require("crypto");
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

app.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "DENY");

  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="TrendPilot AI"');
    return res.status(401).send("Login required");
  }

  let credentials;
  try {
    credentials = Buffer.from(auth.slice(6), "base64").toString();
  } catch {
    return res.status(401).send("Unauthorized");
  }

  const i = credentials.indexOf(":");
  if (i < 0 || !safeEqual(credentials.slice(0, i), USER) ||
      !safeEqual(credentials.slice(i + 1), PASSWORD)) {
    res.set("WWW-Authenticate", 'Basic realm="TrendPilot AI"');
    return res.status(401).send("Unauthorized");
  }
  next();
});

app.use(express.static("public"));

const config = {
  exchange: process.env.EXCHANGE || "binance",
  marketType: process.env.MARKET_TYPE || "spot",
  timeframe: process.env.TIMEFRAME || "15m",
  quote: "USDT",
  riskPct: Number(process.env.RISK_PER_TRADE || 1),
  maxDailyLossPct: Number(process.env.MAX_DAILY_LOSS_PCT || 3),
  startingBalance: Number(process.env.PAPER_BALANCE || 1000),
  maxExposurePct: Number(process.env.MAX_EXPOSURE_PCT || 20),
  takeProfitR: Number(process.env.TAKE_PROFIT_R || 2),
  maxPositions: Number(process.env.MAX_POSITIONS || 3),
  scanInterval: Number(process.env.SCAN_INTERVAL_MS || 60000)
};

if (!["binance", "bitget"].includes(config.exchange)) {
  throw new Error("EXCHANGE must be binance or bitget");
}
if (!["spot", "future"].includes(config.marketType)) {
  throw new Error("MARKET_TYPE must be spot or future");
}

const exchangeClasses = { binance: ccxt.binance, bitget: ccxt.bitget };
const exchange = new exchangeClasses[config.exchange]({
  enableRateLimit: true,
  timeout: 20000,
  options: {
    defaultType: config.marketType === "future" ? "swap" : "spot"
  }
});

let running = false;
let busy = false;
let lastScan = null;
let lastError = null;
let marketsReady = false;
let marketList = [];
let equity = config.startingBalance;
let dayStartEquity = equity;
let dayKey = new Date().toISOString().slice(0, 10);
let realizedPnl = 0;
let positions = [];
let signals = [];
let trades = [];
let seenSignals = new Set();
let orderCounter = 0;

function logTrade(event) {
  trades.unshift({ time: new Date().toISOString(), ...event });
  trades = trades.slice(0, 200);
}

function rollDay() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayKey) {
    dayKey = today;
    dayStartEquity = equity;
    realizedPnl = 0;
  }
}

function dailyLossReached() {
  rollDay();
  return realizedPnl <= -dayStartEquity * config.maxDailyLossPct / 100;
}

async function initialize() {
  await exchange.loadMarkets();
  marketList = Object.values(exchange.markets).filter(m =>
    m.active && m.quote === config.quote &&
    (config.marketType === "spot" ? m.spot : m.swap) &&
    m.base && !m.base.includes("USD") && !m.base.includes("USDT")
  );
  marketsReady = true;
  console.log(`Loaded ${marketList.length} ${config.marketType} markets on ${config.exchange}`);
}

async function getTopMarkets() {
  const tickers = await exchange.fetchTickers();
  return marketList.map(m => {
    const t = tickers[m.symbol];
    return t ? {
      symbol: m.symbol,
      quoteVolume: Number(t.quoteVolume || 0),
      change: Number(t.percentage || 0),
      last: Number(t.last || 0)
    } : null;
  }).filter(x => x && x.last > 0 && x.quoteVolume > 0)
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, Number(process.env.SCAN_PAIRS || 20));
}

function positionKey(symbol, side) {
  return `${config.exchange}:${config.marketType}:${symbol}:${side}`;
}

function hasPosition(symbol, side) {
  return positions.some(p => p.symbol === symbol && p.side === side);
}

function sizePosition(price, stop, available) {
  const distance = Math.abs(price - stop);
  if (!distance || !Number.isFinite(distance)) return 0;

  const riskCash = Math.max(0, equity) * config.riskPct / 100;
  const riskSize = riskCash / distance;
  const exposureSize = (Math.max(0, available) * config.maxExposurePct / 100) / price;
  return Math.max(0, Math.min(riskSize, exposureSize));
}

function updateEquity() {
  const unrealized = positions.reduce((sum, p) => {
    const sign = p.side === "LONG" ? 1 : -1;
    return sum + sign * (p.lastPrice - p.entry) * p.amount;
  }, 0);
  return equity + unrealized;
}

function closePaperPosition(p, price, reason) {
  const sign = p.side === "LONG" ? 1 : -1;
  const gross = sign * (price - p.entry) * p.amount;
  const fee = (p.entry + price) * p.amount * 0.001;
  const pnl = gross - fee;

  equity += pnl;
  realizedPnl += pnl;
  positions = positions.filter(x => x.id !== p.id);
  logTrade({
    type: "PAPER_CLOSE", symbol: p.symbol, side: p.side,
    entry: p.entry, exit: price, amount: p.amount,
    pnl: Number(pnl.toFixed(4)), reason
  });
}

async function managePositions() {
  for (const p of [...positions]) {
    try {
      const ticker = await exchange.fetchTicker(p.symbol);
      const price = Number(ticker.last);
      if (!Number.isFinite(price) || price <= 0) continue;
      p.lastPrice = price;

      const stopHit = p.side === "LONG"
        ? price <= p.stop : price >= p.stop;
      const targetHit = p.side === "LONG"
        ? price >= p.target : price <= p.target;

      if (stopHit) closePaperPosition(p, price, "STOP_LOSS");
      else if (targetHit) closePaperPosition(p, price, "TAKE_PROFIT");
    } catch (e) {
      lastError = `Position check ${p.symbol}: ${e.message}`;
    }
  }
}

async function openPaperPosition(signal) {
  if (dailyLossReached()) return;
  if (positions.length >= config.maxPositions) return;

  const side = signal.side === "BUY" ? "LONG" :
    (config.marketType === "future" ? "SHORT" : null);
  if (!side || hasPosition(signal.symbol, side)) return;

  const price = signal.price;
  const stopDistance = Math.max(signal.atr * 2, price * 0.003);
  const stop = side === "LONG" ? price - stopDistance : price + stopDistance;
  const target = side === "LONG"
    ? price + stopDistance * config.takeProfitR
    : price - stopDistance * config.takeProfitR;

  const amount = sizePosition(price, stop, equity);
  if (!Number.isFinite(amount) || amount <= 0) return;

  const id = ++orderCounter;
  const p = {
    id, symbol: signal.symbol, side, amount,
    entry: price, lastPrice: price, stop, target,
    openedAt: new Date().toISOString()
  };
  positions.push(p);
  logTrade({
    type: "PAPER_OPEN", symbol: p.symbol, side,
    entry: price, amount, stop, target
  });
}

async function scanOnce() {
  if (busy || !marketsReady) return;
  busy = true;
  try {
    await managePositions();
    const top = await getTopMarkets();
    const nextSignals = [];

    for (const item of top) {
      try {
        const candles = await exchange.fetchOHLCV(
          item.symbol, config.timeframe, undefined, 100
        );
        const result = analyze(candles);
        const row = {
          symbol: item.symbol,
          price: result.price,
          change: item.change,
          quoteVolume: item.quoteVolume,
          ...result
        };
        nextSignals.push(row);

        // Only one attempt per symbol and closed candle.
        const candleId = candles.length > 1 ? candles[candles.length - 2][0] : 0;
        const key = `${item.symbol}:${candleId}:${result.side}`;
        if (running && result.side === "BUY" && !seenSignals.has(key)) {
          seenSignals.add(key);
          await openPaperPosition(row);
        } else if (running && config.marketType === "future" &&
                   result.side === "SELL" && !seenSignals.has(key)) {
          seenSignals.add(key);
          await openPaperPosition(row);
        }
      } catch (e) {
        lastError = `${item.symbol}: ${e.message}`;
      }
    }

    signals = nextSignals;
    if (seenSignals.size > 5000) seenSignals = new Set([...seenSignals].slice(-2000));
    lastScan = new Date().toISOString();
    lastError = null;
  } catch (e) {
    lastError = e.message;
  } finally {
    busy = false;
  }
}

app.get("/api/status", (req, res) => {
  res.json({
    mode: "PAPER",
    liveTradingAvailable: false,
    running, busy, exchange: config.exchange,
    marketType: config.marketType,
    timeframe: config.timeframe,
    lastScan, lastError, marketsReady,
    balance: equity,
    equity: updateEquity(),
    realizedPnl,
    dailyLossLimitPct: config.maxDailyLossPct,
    dailyLossReached: dailyLossReached(),
    positions, signals, trades: trades.slice(0, 50)
  });
});

app.post("/api/start", (req, res) => {
  if (!marketsReady) return res.status(503).json({ error: "Markets loading" });
  running = true;
  res.json({ ok: true, mode: "PAPER", running });
});

app.post("/api/stop", (req, res) => {
  running = false;
  res.json({ ok: true, running });
});

app.post("/api/scan", async (req, res) => {
  await scanOnce();
  res.json({ ok: !lastError, lastScan, lastError });
});

app.post("/api/reset-paper", (req, res) => {
  if (running || positions.length) {
    return res.status(409).json({ error: "Stop bot and close paper positions first" });
  }
  equity = config.startingBalance;
  dayStartEquity = equity;
  realizedPnl = 0;
  trades = [];
  seenSignals.clear();
  res.json({ ok: true });
});

async function main() {
  await initialize();
  app.listen(PORT, "127.0.0.1", () => {
    console.log(`TrendPilot AI listening on http://127.0.0.1:${PORT}`);
    console.log("PAPER MODE ONLY. Live order execution is not implemented.");
  });

  setInterval(() => {
    if (running) scanOnce();
  }, Math.max(30000, config.scanInterval));
}

main().catch(e => {
  console.error("Startup failed:", e.message);
  process.exit(1);
});

