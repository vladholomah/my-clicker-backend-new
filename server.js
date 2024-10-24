import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { pool } from './db.js';
import bot from './bot.js';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import {
  initializeUser,
  processReferral,
  getUserData,
  updateUserCoins,
  updateUserLevel
} from './userManagement.js';

dotenv.config();

console.log('Starting server...');
console.log('Environment variables:');
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('POSTGRES_URL (перші 20 символів):', process.env.POSTGRES_URL.substring(0, 20) + '...');
console.log('BOT_TOKEN:', process.env.BOT_TOKEN ? 'Set' : 'Not set');
console.log('FRONTEND_URL:', process.env.FRONTEND_URL);
console.log('BOT_USERNAME:', process.env.BOT_USERNAME);

const app = express();

// Конфігурація безпеки
app.set('trust proxy', 1);
app.enable('trust proxy');

app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Парсинг JSON з підтримкою великих чисел
app.use(express.json({
  verify: (req, res, buf) => {
    try {
      JSON.parse(buf);
    } catch (e) {
      res.status(400).json({ error: 'Invalid JSON' });
      throw new Error('Invalid JSON');
    }
  }
}));
app.use(express.urlencoded({ extended: true }));

// Rate limiter
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 100,  // Limit each IP to 100 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  trustProxy: true,
  keyGenerator: (req) => req.ip,
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many requests, please try again later.',
      retryAfter: Math.ceil(limiter.windowMs / 1000)
    });
  }
});

app.use(limiter);

// Logging middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.url}`);
  console.log('IP:', req.ip);
  console.log('Headers:', JSON.stringify(req.headers));
  console.log('Body:', JSON.stringify(req.body));

  // Логуємо відповідь
  const originalSend = res.send;
  res.send = function(data) {
    console.log(`[${timestamp}] Response:`, data);
    return originalSend.call(this, data);
  };

  next();
});

// API endpoints
app.post('/api/updateUserCoins', async (req, res) => {
  const { userId, coinsToAdd } = req.body;

  if (!userId || coinsToAdd === undefined) {
    console.error('Missing required parameters:', { userId, coinsToAdd });
    return res.status(400).json({
      success: false,
      error: 'User ID and coins amount are required'
    });
  }

  try {
    // Валідація вхідних даних
    const coinsToAddNum = typeof coinsToAdd === 'string' ?
      parseInt(coinsToAdd, 10) : coinsToAdd;

    if (isNaN(coinsToAddNum) || coinsToAddNum <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid coins amount'
      });
    }

    console.log(`Processing coins update: userId=${userId}, coinsToAdd=${coinsToAddNum}`);
    const result = await updateUserCoins(userId, coinsToAddNum);

    console.log('Update result:', result);
    res.json({
      success: true,
      newCoins: result.newCoins,
      newTotalCoins: result.newTotalCoins
    });
  } catch (error) {
    console.error('Error updating user coins:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

app.post('/api/updateUserLevel', async (req, res) => {
  const { userId, newLevel } = req.body;

  if (!userId || !newLevel) {
    return res.status(400).json({
      success: false,
      error: 'User ID and new level are required'
    });
  }

  try {
    const result = await updateUserLevel(userId, newLevel);
    res.json(result);
  } catch (error) {
    console.error('Error updating user level:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

app.post('/api/initUser', async (req, res) => {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({
      success: false,
      error: 'User ID is required'
    });
  }

  try {
    const userData = await initializeUser(userId);
    res.json(userData);
  } catch (error) {
    console.error('Error initializing user:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

app.get('/api/getUserData', async (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({
      success: false,
      error: 'User ID is required'
    });
  }

  try {
    const userData = await getUserData(userId);
    res.json(userData);
  } catch (error) {
    console.error('Error fetching user data:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

app.post('/api/processReferral', async (req, res) => {
  const { referralCode, userId } = req.body;

  if (!referralCode || !userId) {
    return res.status(400).json({
      success: false,
      error: 'Referral code and user ID are required'
    });
  }

  try {
    const result = await processReferral(referralCode, userId);
    res.json(result);
  } catch (error) {
    console.error('Error processing referral:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

// Webhook route
app.post(`/bot${process.env.BOT_TOKEN}`, (req, res) => {
  console.log('Received update from Telegram:', JSON.stringify(req.body));
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Test routes
app.get('/test', (req, res) => {
  res.send('Server is working!');
});

app.get('/api/test-db', async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW()');
    client.release();
    res.json({
      success: true,
      currentTime: result.rows[0].now
    });
  } catch (error) {
    console.error('Database test error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.stack);
  res.status(500).json({
    success: false,
    error: 'Something broke!',
    details: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Server startup
const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`Server is running on port ${PORT}`);
  try {
    const client = await pool.connect();
    console.log('Successfully connected to the database');
    client.release();
  } catch (err) {
    console.error('Error connecting to the database:', err);
  }
});

export default app;