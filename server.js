require('dotenv').config();
const express = require('express');
const cors = require('cors');
const prisma = require('./src/lib/prisma');
const app = express();

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/workspace', require('./src/routes/workspace'));
app.use('/api/integrations', require('./src/routes/integrations'));
app.use('/api/contacts', require('./src/routes/contacts'));
app.use('/api/inbox', require('./src/routes/inbox'));
app.use('/api/bookings', require('./src/routes/bookings'));
app.use('/api/forms', require('./src/routes/forms'));
app.use('/api/inventory', require('./src/routes/inventory'));
app.use('/api/staff', require('./src/routes/staff'));
app.use('/api/dashboard', require('./src/routes/dashboard').router);
app.use('/api/public', require('./src/routes/public'));
app.use('/api/ai', require('./src/routes/ai'));
app.use('/api/calendar', require('./src/routes/calendar'));
app.use('/api/files', require('./src/routes/files'));

// Google OAuth callback redirect (matches Google Cloud redirect URI)
app.get('/auth/google/callback', (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  res.redirect(`/api/calendar/callback?${qs}`);
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handler
app.use(require('./src/middleware/errorHandler'));

// Start cron jobs
require('./src/services/scheduler');

const PORT = process.env.PORT || 5000;

async function start() {
  try {
    await prisma.$connect();
    console.log('✅ Database connected');
    app.listen(PORT, () => {
      console.log(`🚀 CareOps API running on port ${PORT}`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

start();

module.exports = app;
