//src>routes>auth.js

const bcrypt = require('bcrypt');
const { authenticateToken } = require('../middleware/auth');
const express = require('express');
const router = express.Router();
const pool = require('../db');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// Email transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Register (random unique ID version, with resend OTP for unverified)
router.post('/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Missing username, email or password' });
  }
  try {
    // Check duplicate email
    const { rows: existing } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (existing.length > 0) {
      const user = existing[0];
      if (!user.verified) {

        // User exists but not verified: re-send OTP and inform user
        const otp = crypto.randomInt(100000, 999999).toString();
        await pool.query('UPDATE users SET otp = $1 WHERE email = $2', [otp, email]);
        
        // Re-send OTP
        const mailOptions = {
          from: process.env.EMAIL_USER,
          to: email,
          subject: 'NovaChain OTP Verification',
          text: `Hello${user.username ? " " + user.username : ""}, your OTP code is: ${otp}`
        };
        transporter.sendMail(mailOptions, (err) => {
          if (err) console.error('❌ OTP email error:', err);
        });
        return res.status(200).json({ 
          message: 'Account already exists but not verified. New OTP sent. Please check your email.' 
        });
      } else {
        // Already registered & verified
        return res.status(409).json({ error: 'This email is already registered. Please log in.' });
      }
    }

    // If here, email does not exist: create user
    const plainPassword = password; // <-- No bcrypt hash
    const otp = crypto.randomInt(100000, 999999).toString();

    // Generate random unique ID (max 10 attempts)
    let userId;
    let retries = 0;
    while (retries < 10) {
      userId = crypto.randomInt(1, 1000000); // 1..999999
      const idCheck = await pool.query('SELECT 1 FROM users WHERE id = $1', [userId]);
      if (idCheck.rows.length === 0) break; // Unique
      retries++;
    }
    if (retries === 10) return res.status(500).json({ error: "Could not assign unique user ID. Please try again." });

    // Insert user with custom random ID
   await pool.query(
  'INSERT INTO users (id, username, email, password, balance, otp, verified) VALUES ($1, $2, $3, $4, $5, $6, $7)',
  [userId, username, email, password, 0, otp, false]
);

    // Insert balances for all coins (multi-coin support)
    const coins = ["USDT", "BTC", "ETH", "SOL", "XRP", "TON"];
    await Promise.all(
      coins.map((coin) => {
        const balanceId = crypto.randomInt(1, 2147483647); // Generates a random ID
        return pool.query(
          `INSERT INTO user_balances (id, user_id, coin, balance) VALUES ($1, $2, $3, 0)`,
          [balanceId, userId, coin]
        );
      })
    );

    // Send OTP Email
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'NovaChain OTP Verification',
      text: `Hello ${username}, your OTP code is: ${otp}`
    };
    
    try {
      await transporter.sendMail(mailOptions);
      res.status(201).json({ message: 'User registered! OTP sent.', userId });
    } catch (err) {
      console.error('❌ OTP email error:', err);
      res.status(500).json({ error: 'Account created, but failed to send OTP email. Please try resending.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login (returns JWT, supports email or username)
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM users WHERE LOWER(email) = LOWER($1) OR LOWER(username) = LOWER($1)`,
      [email]
    );
    const user = rows[0];
    if (!user) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    let match = false;
    if (user.password.startsWith("$2b$")) {
      // bcrypt hash
      match = await bcrypt.compare(password, user.password);
    } else {
      // plain text fallback for legacy users
      match = (password === user.password);
    }
    if (!match) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    if (user.verified === false || user.verified === 0) {
      return res.status(403).json({ error: "Please verify your email with OTP before logging in." });
    }
    // Create JWT token
    const payload = { id: user.id, username: user.username, email: user.email };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({
      token,
      user: {
        id: "NC-" + String(user.id).padStart(7, "0"),
        username: user.username,
        email: user.email
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});




// OTP Verification (POSTGRES BOOLEAN SAFE)
router.post('/verify-otp', async (req, res) => {
  const { email, otp } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.otp === otp) {
      await pool.query('UPDATE users SET verified = TRUE WHERE email = $1', [email]);
      res.json({ message: 'Email verified successfully' });
    } else {
      res.status(400).json({ error: 'Invalid OTP' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Forgot Password: Send OTP to Email ---
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });

  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (rows.length === 0) {
      // Always return OK for privacy
      return res.json({ message: "If this email exists, OTP sent" });
    }
    const user = rows[0];
    const otp = crypto.randomInt(100000, 999999).toString();
    await pool.query('UPDATE users SET otp = $1 WHERE email = $2', [otp, email]);

    // Send email with OTP
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'NovaChain Password Reset OTP',
      text: `Your NovaChain OTP for password reset is: ${otp}`
    };
    transporter.sendMail(mailOptions, (err) => {
      if (err) console.error('❌ OTP email error:', err);
    });

    return res.json({ message: "If this email exists, OTP sent" });
  } catch (err) {
    console.error('Forgot password error', err);
    return res.status(500).json({ error: "Server error" });
  }
});

// --- Reset Password with OTP ---
router.post('/reset-password', async (req, res) => {
  const { email, otp, newPassword } = req.body;
  if (!email || !otp || !newPassword) return res.status(400).json({ error: "All fields required" });

  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (rows.length === 0) return res.status(400).json({ error: "Invalid email or OTP" });

    const user = rows[0];
    if (user.otp !== otp) return res.status(400).json({ error: "Invalid OTP" });

    await pool.query('UPDATE users SET password = $1, otp = NULL WHERE email = $2', [newPassword, email]);
    return res.json({ message: "Password reset successful" });
  } catch (err) {
    console.error('Reset password error', err);
    return res.status(500).json({ error: "Server error" });
  }
});

// --- Resend OTP (for registration) ---
router.post('/resend-otp', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required.' });

  try {
    // Check if user exists
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'No account with that email.' });
    }
    const user = rows[0];

    // Generate a new OTP
    const otp = crypto.randomInt(100000, 999999).toString();
    await pool.query('UPDATE users SET otp = $1 WHERE email = $2', [otp, email]);

    // Send OTP Email
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'NovaChain OTP Verification',
      text: `Hello${user.username ? " " + user.username : ""}, your OTP code is: ${otp}`
    };
    transporter.sendMail(mailOptions, (err) => {
      if (err) {
        console.error('❌ OTP resend email error:', err);
        return res.status(500).json({ error: 'Failed to send OTP email.' });
      }
      res.json({ message: 'OTP code resent. Please check your email.' });
    });
  } catch (err) {
    console.error('Resend OTP error:', err);
    res.status(500).json({ error: 'Server error, could not resend OTP.' });
  }
});


module.exports = router;
