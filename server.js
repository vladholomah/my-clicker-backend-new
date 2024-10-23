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

// Налаштування довіри проксі
app.set('trust proxy', 1);
app.enable('trust proxy');
console.log('Trust proxy setting:', app.get('trust proxy'));

// Middleware безпеки
app.use(helmet());

// Налаштування CORS
app.use(cors({
  origin: process.env.FRONTEND_URL,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// Парсинг JSON та URL-encoded даних
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Налаштування rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 хвилин
  max: 100, // Ліміт запитів на IP
  standardHeaders: true,
  legacyHeaders: false,
  trustProxy: true,
  keyGenerator: (req) => {
    return req.ip;
  },
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many requests, please try again later.',
      retryAfter: Math.ceil(req.rateLimit.resetTime / 1000)
    });
  }
});

app.use(limiter);

// Logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  console.log('IP:', req.ip);
  console.log('X-Forwarded-For:', req.headers['x-forwarded-for']);
  console.log('Headers:', JSON.stringify(req.headers));
  console.log('Body:', JSON.stringify(req.body));
  next();
});

// API routes
app.post('/api/initUser', async (req, res) => {
  const { userId, firstName, lastName, username, avatarUrl } = req.body;

  if (!userId) {
    console.log('Відсутній userId в запиті');
    return res.status(400).json({ error: 'User ID is required' });
  }

  try {
    console.log('Спроба ініціалізації користувача:', userId);
    const userData = await initializeUser(userId, firstName, lastName, username, avatarUrl);
    console.log('Користувач успішно ініціалізований:', userData);
    res.json(userData);
  } catch (error) {
    console.error('Помилка при ініціалізації користувача:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
});

app.get('/api/getUserData', async (req, res) => {
  const { userId } = req.query;
  console.log('Отримано запит getUserData з userId:', userId);

  if (!userId) {
    console.log('userId відсутній в запиті');
    return res.status(400).json({
      success: false,
      error: 'User ID is required'
    });
  }

  try {
    // Автоматична ініціалізація користувача, якщо потрібно
    try {
      await initializeUser(userId);
      console.log('Користувач ініціалізований або вже існує');
    } catch (initError) {
      console.log('Помилка при ініціалізації користувача:', initError);
    }

    const userData = await getUserData(userId);
    console.log('Отримано дані користувача:', userData);
    res.json({
      success: true,
      data: userData
    });
  } catch (error) {
    console.error('Помилка при отриманні даних користувача:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

app.post('/api/updateUserCoins', async (req, res) => {
  const { userId, coinsToAdd } = req.body;
  console.log('Запит на оновлення монет:', { userId, coinsToAdd });

  if (!userId || coinsToAdd === undefined) {
    return res.status(400).json({
      error: 'User ID and coins amount are required'
    });
  }

  try {
    const result = await updateUserCoins(userId, coinsToAdd);
    console.log('Монети успішно оновлено:', result);
    res.json(result);
  } catch (error) {
    console.error('Помилка при оновленні монет:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
});

app.post('/api/processReferral', async (req, res) => {
  const { referralCode, userId } = req.body;
  console.log('Запит на обробку реферала:', { referralCode, userId });

  if (!referralCode || !userId) {
    return res.status(400).json({
      error: 'Referral code and user ID are required'
    });
  }

  try {
    const result = await processReferral(referralCode, userId);
    console.log('Реферал успішно оброблено:', result);
    res.json(result);
  } catch (error) {
    console.error('Помилка при обробці реферала:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
});

app.post('/api/updateUserLevel', async (req, res) => {
  const { userId, newLevel } = req.body;
  console.log('Запит на оновлення рівня користувача:', { userId, newLevel });

  if (!userId || !newLevel) {
    return res.status(400).json({
      error: 'User ID and new level are required'
    });
  }

  try {
    const result = await updateUserLevel(userId, newLevel);
    console.log('Рівень користувача успішно оновлено:', result);
    res.json(result);
  } catch (error) {
    console.error('Помилка при оновленні рівня:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
});

// Test routes
app.get('/test', (req, res) => {
  res.send('Server is working!');
});

app.get('/', (req, res) => {
  res.send('Holmah Coin Bot Server is running!');
});

// Webhook route для Telegram бота
app.post(`/bot${process.env.BOT_TOKEN}`, (req, res) => {
  console.log('Received update from Telegram:', JSON.stringify(req.body));
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Тестування підключення до бази даних
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

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.stack);
  res.status(500).json({
    error: 'Something broke!',
    details: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Обробка необроблених помилок
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