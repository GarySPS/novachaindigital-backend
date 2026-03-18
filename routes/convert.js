// routes/convert.js — Free live prices version (robust, TON alias, 3 fallbacks)
const express = require("express");
const router = express.Router();
const pool = require("../db");
const { authenticateToken } = require("../middleware/auth");
const axios = require("axios");

// Symbol -> CoinGecko ID (primary)
const CG_ID = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  XRP: "ripple",
  TON: "the-open-network", // some endpoints still use this, we add a toncoin fallback below
  USDT: "tether",
};

// normalize inputs like "ton/usdt", "TONUSDT", " ton - usd "
function normalizeSymbol(input) {
  if (!input) return "";
  let s = String(input).trim().toUpperCase().replace(/\s+/g, "");

  // split composite pairs like "TON/USDT" or "eth-usd"
  if (s.includes("/")) s = s.split("/")[0];
  if (s.includes("-")) s = s.split("-")[0];

  // only strip the suffix if there's something BEFORE it
  if (s !== "USDT" && s.endsWith("USDT")) s = s.slice(0, -4);
  if (s !== "USD"  && s.endsWith("USD"))  s = s.slice(0, -3);

  return s;
}

// unified live USD price with 3 fallbacks (CoinGecko → Binance → Coinbase)
async function getSpotUSD(symbol) {
  const sym = normalizeSymbol(symbol);

  // 1) CoinGecko (with TON alias fallback to "toncoin")
  try {
    let id = CG_ID[sym];
    if (!id && sym === "TON") id = "toncoin"; // alias
    if (id === "the-open-network") {
      // try the canonical id first
      try {
        const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`;
        const { data } = await axios.get(url, { timeout: 8000 });
        const p = Number(data?.[id]?.usd);
        if (isFinite(p) && p > 0) return p;
      } catch {
        /* fall through to alias */
      }
      // alias attempt
      const alias = "toncoin";
      const url2 = `https://api.coingecko.com/api/v3/simple/price?ids=${alias}&vs_currencies=usd`;
      const { data: d2 } = await axios.get(url2, { timeout: 8000 });
      const p2 = Number(d2?.[alias]?.usd);
      if (isFinite(p2) && p2 > 0) return p2;
    } else if (id) {
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`;
      const { data } = await axios.get(url, { timeout: 8000 });
      const p = Number(data?.[id]?.usd);
      if (isFinite(p) && p > 0) return p;
    }
  } catch {}

  // 2) Binance (USDT proxy)
  try {
    const url = `https://api.binance.com/api/v3/ticker/price?symbol=${sym}USDT`;
    const { data } = await axios.get(url, { timeout: 8000 });
    const p = Number(data?.price);
    if (isFinite(p) && p > 0) return p;
  } catch {}

  // 3) Coinbase (USD spot)
  try {
    const url = `https://api.coinbase.com/v2/prices/${sym}-USD/spot`;
    const { data } = await axios.get(url, {
      timeout: 8000,
      headers: { "CB-VERSION": "2023-01-01" },
    });
    const p = Number(data?.data?.amount);
    if (isFinite(p) && p > 0) return p;
  } catch {}

  throw new Error("PRICE_UNAVAILABLE");
}

// simple decimals by coin for display/storage (feel free to adjust)
function coinDecimals(sym) {
  if (sym === "USDT") return 2;
  if (sym === "XRP" || sym === "TON") return 4;
  return 8; // BTC/ETH/SOL etc.
}

router.post("/", authenticateToken, async (req, res) => {
  try {
    const { from_coin, to_coin, amount } = req.body;
    const user_id = req.user.id;

    const fromSym = normalizeSymbol(from_coin);
    const toSym = normalizeSymbol(to_coin);
    const amt = Number(amount);

    if (!fromSym || !toSym || !isFinite(amt) || amt <= 0) {
      return res.status(400).json({ error: "Invalid input" });
    }

    // only allow USDT <-> coin (same as before)
    if (fromSym === toSym) {
      return res.status(400).json({ error: "Cannot convert to same coin" });
    }
    const allowed = ["BTC", "ETH", "SOL", "XRP", "TON", "USDT"];
    if (!allowed.includes(fromSym) || !allowed.includes(toSym)) {
      return res.status(400).json({ error: "Invalid coin" });
    }
    if (!(fromSym === "USDT" || toSym === "USDT")) {
      return res.status(400).json({ error: "Only USDT <-> coin conversions allowed." });
    }

    // live rate (USD per coin)
    let rateUSD;
    if (fromSym === "USDT") {
      // buying the target coin with USDT → need target coin USD price
      rateUSD = await getSpotUSD(toSym);
    } else {
      // selling a coin to USDT → need that coin USD price
      rateUSD = await getSpotUSD(fromSym);
    }

    // compute received
    let received;
    if (fromSym === "USDT") {
      // USDT -> coin
      received = amt / rateUSD;
      received = Number(received.toFixed(coinDecimals(toSym)));
    } else {
      // coin -> USDT
      received = amt * rateUSD;
      received = Number(received.toFixed(coinDecimals("USDT")));
    }

    // --- TRANSACTION START ---
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); // Start transaction

      // 1. Balance check (FOR UPDATE locks the row so they can't double-spend)
      const { rows } = await client.query(
        "SELECT balance FROM user_balances WHERE user_id = $1 AND coin = $2 FOR UPDATE",
        [user_id, fromSym]
      );
      const balance = Number(rows[0]?.balance || 0);
      if (!isFinite(balance) || balance < amt) {
        throw new Error("Insufficient balance.");
      }

      // 2. Deduct from balance
      await client.query(
        "UPDATE user_balances SET balance = balance - $1 WHERE user_id = $2 AND coin = $3",
        [amt, user_id, fromSym]
      );

      // 3. Add to new balance
      await client.query(
        `INSERT INTO user_balances (user_id, coin, balance)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, coin)
         DO UPDATE SET balance = user_balances.balance + EXCLUDED.balance`,
        [user_id, toSym, received]
      );

      // 4. Record history
      await client.query(
        `INSERT INTO conversions (user_id, from_coin, to_coin, amount, received, rate)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [user_id, fromSym, toSym, amt, received, rateUSD]
      );

      await client.query('COMMIT'); // Success! Save changes.
      res.json({ success: true, received, rate: rateUSD });

    } catch (err) {
      await client.query('ROLLBACK'); // Fail! Undo any deductions.
      console.error("Convert error:", err.message || err);
      if (err.message === "Insufficient balance.") {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: "Conversion failed." });
    } finally {
      client.release(); // Free up the DB connection
    }
  } catch (err) {
    console.error("Convert setup error:", err.message || err);
    res.status(500).json({ error: "Conversion failed." });
  }
});

module.exports = router;