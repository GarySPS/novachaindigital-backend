//routes>user.js 

const bcrypt = require('bcrypt'); 
const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticateToken } = require('../middleware/auth');

// GET /api/users -- List all users
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, email, verified, kyc_status FROM users ORDER BY id DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error("DB error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// GET /api/users/balance -- Get current user's balances (JWT-protected)
router.get('/balance', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query(
      "SELECT coin, balance FROM user_balances WHERE user_id = $1",
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("DB error:", err);
    res.status(500).json({ error: "Database error" });
  }
});


// POST /api/users/password -- Change current user's password (JWT-protected)
router.post('/password', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "Missing current or new password" });
  }

  try {
    const { rows } = await pool.query(
      "SELECT password FROM users WHERE id = $1",
      [userId]
    );
    const user = rows[0];
    if (!user) return res.status(404).json({ error: "User not found" });

    let match = false;
    if (user.password.startsWith("$2b$")) {
      match = await bcrypt.compare(currentPassword, user.password);
    } else {
      match = (currentPassword === user.password);
    }
    if (!match) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }
    if (currentPassword === newPassword) {
      return res.status(400).json({ error: "New password must be different from the current password" });
    }

    await pool.query(
  "UPDATE users SET password = $1 WHERE id = $2",
  [newPassword, userId]
);


    res.json({ message: "Password changed successfully" });
  } catch (err) {
    console.error("Change password error:", err);
    res.status(500).json({ error: "Failed to change password" });
  }
});


// POST /api/users/forgot-password
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });

  try {
    const { rows } = await pool.query(
      "SELECT id, email FROM users WHERE email = $1", [email]
    );
    const user = rows[0];
    if (!user) {
      // Always return success for security (don't reveal if email exists)
      return res.json({ message: "If this email exists, OTP will be sent" });
    }

    // TODO: Generate OTP and send email logic here
    // For now, just respond with a placeholder
    res.json({ message: "If this email exists, OTP will be sent" });
  } catch (err) {
    console.error("Forgot password error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// --- AVATAR UPLOAD ---
// You need these dependencies at the top if not present:
const multer = require('multer');
const supabase = require('../utils/supabaseClient'); // or '../supabaseClient' if that is your path

const upload = multer({ storage: multer.memoryStorage() });

// POST /api/users/avatar -- Upload and set avatar for current user
router.post('/avatar', authenticateToken, upload.single('avatar'), async (req, res) => {
  const userId = req.user.id;
  const file = req.file;

  if (!file) return res.status(400).json({ error: 'No file uploaded.' });

  // Make a unique filename (e.g. userId-timestamp-originalname)
  const filename = `${userId}-${Date.now()}-${file.originalname.replace(/\s/g, "_")}`;

  // Upload to Supabase Storage (avatar bucket)
  const { data, error } = await supabase.storage
    .from('avatar')
    .upload(filename, file.buffer, {
      contentType: file.mimetype,
      upsert: true,
    });

  if (error) return res.status(500).json({ error: error.message });

  // Get public URL
  const { data: urlData } = supabase.storage.from('avatar').getPublicUrl(filename);

  // Save public URL to users table (avatar field)
  try {
    await pool.query(
      "UPDATE users SET avatar = $1 WHERE id = $2",
      [urlData.publicUrl, userId]
    );
    res.json({ avatar: urlData.publicUrl });
  } catch (err) {
    res.status(500).json({ error: "Database error" });
  }
});


module.exports = router;
