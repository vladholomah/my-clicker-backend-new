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

// Безпека та налаштування
app.set('trust proxy', 1);
app.enable('trust proxy');
console.log('Trust proxy setting:', app.get('trust proxy'));

app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Налаштування rate limiter
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  trustProxy: true,
  keyGenerator: (req) => req.ip
});

app.use(limiter);

// Логування запитів
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.url}`);
  console.log('IP:', req.ip);
  console.log('X-Forwarded-For:', req.headers['x-forwarded-for']);
  console.log('Headers:', JSON.stringify(req.headers));
  console.log('Body:', JSON.stringify(req.body));
  next();
});

// Оновлений endpoint для оновлення монет
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
    console.log(`Updating coins for user ${userId}: adding ${coinsToAdd}`);
    const result = await updateUserCoins(userId, coinsToAdd);
    console.log('Update result:', result);

    // Отримуємо оновлені дані користувача
    const userData = await getUserData(userId);
    console.log('Updated user data:', userData);

    res.json({
      success: true,
      newCoins: result.newCoins,
      newTotalCoins: result.newTotalCoins,
      level: userData.level
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

// Endpoint для оновлення рівня користувача
app.post('/api/updateUserLevel', async (req, res) => {
  const { userId, newLevel } = req.body;

  if (!userId || !newLevel) {
    console.error('Missing required parameters:', { userId, newLevel });
    return res.status(400).json({
      success: false,
      error: 'User ID and new level are required'
    });
  }

  try {
    console.log(`Updating level for user ${userId} to ${newLevel}`);
    const result = await updateUserLevel(userId, newLevel);
    console.log('Level update result:', result);
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

// Існуючі endpoints
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

// Тестові endpoints
app.get('/test', (req, res) => {
  res.send('Server is working!');
});

app.get('/api/test-db', async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW()');
    client.release();
    console.log('Database test query result:', result.rows[0]);
    res.json({
      success: true,
      currentTime: result.rows[0].now
    });
  } catch (error) {
    console.error('Database test query error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Webhook route
app.post(`/bot${process.env.BOT_TOKEN}`, (req, res) => {
  console.log('Received update from Telegram:', JSON.stringify(req.body));
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Root endpoint
app.get('/', (req, res) => {
  res.send('TWASH COIN Bot Server is running!');
});

// Обробка помилок
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.stack);
  res.status(500).send('Something broke!');
});

// Обробка необроблених відхилень промісів
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Запуск сервера
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