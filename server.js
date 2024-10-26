import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { pool } from './db.js';
import bot from './bot.js';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { initializeUser, processReferral, getUserData, updateUserCoins, updateUserLevel } from './userManagement.js';

dotenv.config();

console.log('Starting server...');
console.log('Environment variables:');
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('POSTGRES_URL (перші 20 символів):', process.env.POSTGRES_URL.substring(0, 20) + '...');
console.log('BOT_TOKEN:', process.env.BOT_TOKEN ? 'Set' : 'Not set');
console.log('FRONTEND_URL:', process.env.FRONTEND_URL);
console.log('BOT_USERNAME:', process.env.BOT_USERNAME);

const app = express();

app.set('trust proxy', 1);
app.enable('trust proxy');
console.log('Trust proxy setting:', app.get('trust proxy'));

// Налаштування безпеки
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Парсери для тіла запиту
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Налаштування rate limiter
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  trustProxy: true,
  keyGenerator: (req) => {
    return req.ip;
  }
});

app.use(limiter);

// Більш специфічний rate limiter для оновлення балансу
const balanceUpdateLimiter = rateLimit({
  windowMs: 1000, // 1 секунда
  max: 5, // максимум 5 запитів за секунду
  message: { error: 'Too many balance update requests. Please try again later.' }
});

// Логування запитів
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  console.log('IP:', req.ip);
  console.log('X-Forwarded-For:', req.headers['x-forwarded-for']);
  console.log('Headers:', JSON.stringify(req.headers));
  console.log('Body:', JSON.stringify(req.body));
  next();
});

// Middleware для перевірки валідності userId
const validateUserId = (req, res, next) => {
  const userId = req.body.userId || req.query.userId;
  if (!userId) {
    return res.status(400).json({ error: 'User ID is required' });
  }
  next();
};

// Оновлений роут для оновлення балансу з валідацією та rate limiting
app.post('/api/updateUserCoins', balanceUpdateLimiter, validateUserId, async (req, res) => {
  const { userId, coinsToAdd } = req.body;

  if (coinsToAdd === undefined) {
    return res.status(400).json({ error: 'Coins amount is required' });
  }

  try {
    const coinsNumber = parseInt(coinsToAdd);
    if (isNaN(coinsNumber)) {
      return res.status(400).json({ error: 'Invalid coins amount' });
    }

    const result = await updateUserCoins(userId, coinsNumber);
    res.json(result);
  } catch (error) {
    console.error('Error updating user coins:', error);
    if (error.message === 'Insufficient coins') {
      res.status(400).json({ error: 'Insufficient coins for this operation' });
    } else {
      res.status(500).json({ error: 'Internal server error', details: error.message });
    }
  }
});

// Оновлений роут для отримання даних користувача
app.get('/api/getUserData', validateUserId, async (req, res) => {
  const { userId } = req.query;

  try {
    const userData = await getUserData(userId);
    res.json(userData);
  } catch (error) {
    console.error('Error fetching user data:', error);
    if (error.message === 'User not found') {
      res.status(404).json({ error: 'User not found' });
    } else {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// Оновлений роут для ініціалізації користувача
app.post('/api/initUser', validateUserId, async (req, res) => {
  const { userId } = req.body;

  try {
    const userData = await initializeUser(userId);
    res.json(userData);
  } catch (error) {
    console.error('Error initializing user:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// Роут для обробки реферальних кодів
app.post('/api/processReferral', validateUserId, async (req, res) => {
  const { referralCode, userId } = req.body;

  if (!referralCode) {
    return res.status(400).json({ error: 'Referral code is required' });
  }

  try {
    const result = await processReferral(referralCode, userId);
    res.json(result);
  } catch (error) {
    console.error('Error processing referral:', error);
    if (error.message === 'Invalid referral code') {
      res.status(400).json({ error: 'Invalid referral code' });
    } else if (error.message === 'User already referred') {
      res.status(400).json({ error: 'User already used a referral code' });
    } else {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// Роут для оновлення рівня користувача
app.post('/api/updateUserLevel', validateUserId, async (req, res) => {
  const { userId, newLevel } = req.body;

  if (!newLevel) {
    return res.status(400).json({ error: 'New level is required' });
  }

  try {
    const result = await updateUserLevel(userId, newLevel);
    res.json(result);
  } catch (error) {
    console.error('Error updating user level:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// Тестовий роут
app.get('/test', (req, res) => {
  res.send('Server is working!');
});

// Роут для webhook Telegram
app.post(`/bot${process.env.BOT_TOKEN}`, (req, res) => {
  console.log('Received update from Telegram:', JSON.stringify(req.body));
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Тестовий роут для перевірки підключення до БД
app.get('/api/test-db', async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW()');
    client.release();
    console.log('Database test query result:', result.rows[0]);
    res.json({ success: true, currentTime: result.rows[0].now });
  } catch (error) {
    console.error('Database test query error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Головна сторінка
app.get('/', (req, res) => {
  res.send('Holmah Coin Bot Server is running!');
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