// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const logger = require('./logger');

const authRoutes = require('./routes/authRoutes');

const app = express();

// ✅ Parse comma-separated origins from .env
const allowedOrigins = process.env.CORS_ORIGINS?.split(',') || [];

// ✅ Enable dynamic CORS based on origin
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like curl or Postman)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('❌ Not allowed by CORS: ' + origin));
    }
  },
  credentials: true
}));

app.use(express.json());

app.get('/', (req, res) => {
  res.send('👋 Hello! from your Raspberry Pi! Api service running.');
});

// ✅ ADD THIS: Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    port: process.env.PORT || 3001,
    host: process.env.HOST || '0.0.0.0'
  });
});

// ✅ Routes
app.use('/', authRoutes);

// ✅ Start Server
const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  logger.info(`🚀 Server is running at http://${HOST}:${PORT}`);
  // ✅ ADD THIS: Log environment variables for debugging
  logger.info(`📝 Environment: NODE_ENV=${process.env.NODE_ENV}, PORT=${PORT}, HOST=${HOST}`);
});
