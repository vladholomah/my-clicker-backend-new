import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { pool } from './db.js';
import bot from './bot.js';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { initializeUser, processReferral, getUserData, updateUserCoins } from './userManagement.js';

dotenv.config();

// Логування конфігурації при запуску
console.log('Starting server...');
console.log('Environment variables:', {
  NODE_ENV: process.env.NODE_ENV,
  FRONTEND_URL: process.env.FRONTEND_URL,
  BOT_USERNAME: process.env.BOT_USERNAME
});

const app = express();

// Базові налаштування безпеки та проксі
app.set('trust proxy', true);
app.enable('trust proxy');
console.log('Trust proxy setting:', app.get('trust proxy'));

// Helmet для безпеки
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      connectSrc: ["'self'", process.env.FRONTEND_URL],
      frameSrc: ["'self'", "https://telegram.org"],
      imgSrc: ["'self'", "https:", "data:", "blob:"],
    },
  },
}));

// Налаштування CORS
const corsOptions = {
  origin: process.env.FRONTEND_URL,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 86400 // 24 години
};
app.use(cors(corsOptions));

// Парсери для тіла запиту
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Функція для створення rate limiter з різними налаштуваннями
const createRateLimiter = (windowMs, max, message) => rateLimit({
  windowMs,
  max,
  message: { error: message },
  standardHeaders: true,
  legacyHeaders: false,
  trustProxy: true,
  skipSuccessfulRequests: false, // Рахуємо всі запити
  keyGenerator: (req) => {
    const userId = req.query.userId || req.body.userId;
    const userIP = req.ip;
    return userId ? `${userIP}-${userId}` : userIP;
  },
  skip: (req) => req.method === 'OPTIONS',
  handler: (req, res) => {
    console.log(`Rate limit exceeded for IP: ${req.ip}, userId: ${req.query.userId || req.body.userId}`);
    res.status(429).json({
      error: message,
      retryAfter: Math.ceil(windowMs / 1000)
    });
  }
});

// Глобальний ліміт
const globalLimiter = createRateLimiter(
  60 * 1000,    // 1 хвилина
  100,          // 100 запитів
  'Занадто багато запитів. Будь ласка, спробуйте пізніше.'
);

// Ліміт для ініціалізації користувача
const initUserLimiter = createRateLimiter(
  60 * 1000,    // 1 хвилина
  10,           // 10 запитів
  'Занадто багато спроб ініціалізації. Будь ласка, зачекайте.'
);

// Ліміт для отримання даних
const getUserDataLimiter = createRateLimiter(
  60 * 1000,    // 1 хвилина
  30,           // 30 запитів
  'Занадто багато запитів даних. Будь ласка, зачекайте.'
);

// Ліміт для оновлення монет
const updateCoinsLimiter = createRateLimiter(
  60 * 1000,    // 1 хвилина
  50,           // 50 запитів
  'Занадто багато оновлень. Будь ласка, зачекайте.'
);

// Middleware для детального логування
app.use((req, res, next) => {
  const startTime = Date.now();

  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  console.log('IP:', req.ip);
  console.log('X-Forwarded-For:', req.headers['x-forwarded-for']);

  if (req.method !== 'OPTIONS') {
    console.log('Headers:', JSON.stringify(req.headers));
    console.log('Body:', JSON.stringify(req.body));
  }

  // Додаємо логування часу відповіді
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    console.log(`${req.method} ${req.url} completed in ${duration}ms with status ${res.statusCode}`);
  });

  next();
});

// Застосовуємо глобальний ліміт
app.use(globalLimiter);

// Тестовий роут
app.get('/test', (req, res) => {
  res.json({ status: 'Server is working!' });
});

// Роут для webhook бота
app.post(`/bot${process.env.BOT_TOKEN}`, (req, res) => {
  console.log('Received update from Telegram:', JSON.stringify(req.body));
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Ініціалізація користувача
app.post('/api/initUser', initUserLimiter, async (req, res) => {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'User ID is required' });
  }

  try {
    const userData = await initializeUser(userId);
    res.json(userData);
  } catch (error) {
    console.error('Error initializing user:', error);

    if (error.code === '23505') { // Duplicate key error
      return res.status(409).json({ error: 'User already exists' });
    }

    res.status(500).json({
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Отримання даних користувача
app.get('/api/getUserData', getUserDataLimiter, async (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: 'User ID is required' });
  }

  try {
    const userData = await getUserData(userId);
    res.json(userData);
  } catch (error) {
    console.error('Error fetching user data:', error);

    if (error.message === 'User not found') {
      return res.status(404).json({ error: 'User not found' });
    }

    res.status(500).json({ error: 'Internal server error' });
  }
});

// Оновлення монет користувача
app.post('/api/updateUserCoins', updateCoinsLimiter, async (req, res) => {
  const { userId, coinsToAdd } = req.body;

  if (!userId || coinsToAdd === undefined) {
    return res.status(400).json({ error: 'User ID and coins amount are required' });
  }

  try {
    const result = await updateUserCoins(userId, coinsToAdd);
    res.json(result);
  } catch (error) {
    console.error('Error updating user coins:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Обробка реферального коду
app.post('/api/processReferral', initUserLimiter, async (req, res) => {
  const { referralCode, userId } = req.body;

  if (!referralCode || !userId) {
    return res.status(400).json({ error: 'Referral code and user ID are required' });
  }

  try {
    const result = await processReferral(referralCode, userId);
    res.json(result);
  } catch (error) {
    console.error('Error processing referral:', error);

    if (error.message === 'Invalid referral code') {
      return res.status(400).json({ error: 'Invalid referral code' });
    }
    if (error.message === 'Cannot use own referral code') {
      return res.status(400).json({ error: 'Cannot use own referral code' });
    }
    if (error.message === 'User already referred') {
      return res.status(400).json({ error: 'User already referred' });
    }

    res.status(500).json({ error: 'Internal server error' });
  }
});

// Тестування підключення до БД
app.get('/api/test-db', async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW()');
    client.release();
    res.json({ success: true, currentTime: result.rows[0].now });
  } catch (error) {
    console.error('Database test error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Головна сторінка
app.get('/', (req, res) => {
  res.send('TWASH COIN Bot Server is running!');
});

// Middleware для обробки помилок
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.stack);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// Обробка необроблених відхилень промісів
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Обробка необроблених помилок
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // В продакшені тут можна додати відправку сповіщень адміністратору
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Received SIGTERM signal. Starting graceful shutdown...');

  // Закриваємо з'єднання з базою даних
  try {
    await pool.end();
    console.log('Database connections closed');
  } catch (err) {
    console.error('Error closing database connections:', err);
  }

  process.exit(0);
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