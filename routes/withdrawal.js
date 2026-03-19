// routes/withdrawals.js

require('dotenv').config();
const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticateToken } = require('../middleware/auth');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN || 'yourSecureAdminTokenHere1234';

// --- User requests withdrawal (status = pending) ---
router.post('/', authenticateToken, async (req, res) => {
  const user_id = req.user.id;
  const { coin, amount, address } = req.body;
  if (!user_id || !coin || !amount || !address) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT balance FROM user_balances WHERE user_id = $1 AND coin = $2',
      [user_id, coin]
    );
    const userBal = rows[0];
    if (!userBal) return res.status(400).json({ error: "Balance record not found" });
    if (parseFloat(userBal.balance) < parseFloat(amount)) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    const withdrawId = crypto.randomInt(1, 2147483647); // Generate the ID

    // Add 'id' to the INSERT list and $1 to VALUES
    const result = await pool.query(
      `INSERT INTO withdrawals (id, user_id, coin, amount, address, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING id`,
      [withdrawId, user_id, coin, amount, address]
    );
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// --- Get withdrawals (user: only own; admin: all) ---
router.get('/', async (req, res) => {
  // --- Admin view ---
  if (req.headers['x-admin-token'] && req.headers['x-admin-token'] === ADMIN_API_TOKEN) {
    try {
      const result = await pool.query(
        'SELECT * FROM withdrawals ORDER BY created_at DESC'
      );
      return res.json(result.rows);
    } catch (err) {
      return res.status(500).json({ error: 'Database error (admin)' });
    }
  }

  // --- User view ---
  try {
    if (!req.headers.authorization) {
      return res.status(401).json({ error: 'No token' });
    }
    let user_id = null;
    try {
      const token = req.headers.authorization.split(' ')[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      user_id = decoded.id || decoded.user_id;
    } catch (e) {
      return res.status(401).json({ error: "User not authenticated" });
    }
    if (!user_id) return res.status(401).json({ error: "User not authenticated" });

    const result = await pool.query(
      'SELECT * FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC',
      [user_id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Database error (user)' });
  }
});

// --- Approve/Reject withdrawal (admin) ---
router.post('/:id/status', async (req, res) => {
  const { status } = req.body;
  const { id } = req.params;
  if (!["approved", "rejected", "pending"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }
  try {
    const { rows } = await pool.query('SELECT * FROM withdrawals WHERE id = $1', [id]);
    const withdrawal = rows[0];
    if (!withdrawal) return res.status(404).json({ error: "Withdrawal not found" });

    // Only deduct if approving and not already approved
    if (status === "approved" && withdrawal.status !== "approved") {
      const { rows: balRows } = await pool.query(
        'SELECT balance FROM user_balances WHERE user_id = $1 AND coin = $2',
        [withdrawal.user_id, withdrawal.coin]
      );
      const userBal = balRows[0];
      if (!userBal) return res.status(500).json({ error: "User balance not found" });
      if (parseFloat(userBal.balance) < parseFloat(withdrawal.amount)) {
        return res.status(400).json({ error: "Insufficient balance" });
      }
      await pool.query(
        'UPDATE user_balances SET balance = balance - $1 WHERE user_id = $2 AND coin = $3',
        [withdrawal.amount, withdrawal.user_id, withdrawal.coin]
      );

      // --- Insert balance history after deduction ---
      const { rows: balRows2 } = await pool.query(
        'SELECT balance FROM user_balances WHERE user_id = $1 AND coin = $2',
        [withdrawal.user_id, withdrawal.coin]
      );
      const newBalance = balRows2[0] ? parseFloat(balRows2[0].balance) : 0;
      let price_usd = 1;
      if (withdrawal.coin !== "USDT") price_usd = 0; // Add logic for real price if needed

      await pool.query(
        `INSERT INTO balance_history (user_id, coin, balance, price_usd, timestamp)
         VALUES ($1, $2, $3, $4, NOW())`,
        [withdrawal.user_id, withdrawal.coin, newBalance, price_usd]
      );
    }
    // If rejected, refund if necessary
    if (status === "rejected" && withdrawal.status === "approved") {
      await pool.query(
        'UPDATE user_balances SET balance = balance + $1 WHERE user_id = $2 AND coin = $3',
        [withdrawal.amount, withdrawal.user_id, withdrawal.coin]
      );
    }

    await pool.query('UPDATE withdrawals SET status = $1 WHERE id = $2', [status, id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Database error" });
  }
});

module.exports = router;
