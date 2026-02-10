require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const app = express();

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Make prisma available to routes
app.set('prisma', prisma);

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
app.use('/api/dashboard', require('./src/routes/dashboard'));
app.use('/api/public', require('./src/routes/public'));
app.use('/api/ai', require('./src/routes/ai'));
app.use('/api/calendar', require('./src/routes/calendar'));

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
