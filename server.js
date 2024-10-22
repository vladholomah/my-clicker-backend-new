import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { pool } from './db.js';
import bot from './bot.js';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import userManagement from './userManagement.js';

const { initializeUser, processReferral, getUserData } = userManagement;

dotenv.config();

console.log('Starting server...');
console.log('Environment variables:', {
  NODE_ENV: process.env.NODE_ENV,
  FRONTEND_URL: process.env.FRONTEND_URL,
  BOT_USERNAME: process.env.BOT_USERNAME
});

const app = express();

app.set('trust proxy', true);
app.enable('trust proxy');

// Безпека
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// CORS налаштування
app.use(cors({
  origin: process.env.FRONTEND_URL,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Rate limiting
const createRateLimiter = (windowMs, max, message) => rateLimit({
  windowMs,
  max,
  message: { error: message },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.log(`Rate limit exceeded for IP: ${req.ip}`);
    res.status(429).json({
      error: message,
      retryAfter: Math.ceil(windowMs / 1000)
    });
  }
});

// Лімітери
const globalLimiter = createRateLimiter(
  60 * 1000,    // 1 хвилина
  100,          // 100 запитів
  'Занадто багато запитів. Спробуйте пізніше.'
);

const initUserLimiter = createRateLimiter(
  60 * 1000,    // 1 хвилина
  10,           // 10 запитів
  'Занадто багато спроб ініціалізації. Зачекайте.'
);

const getUserDataLimiter = createRateLimiter(
  60 * 1000,    // 1 хвилина
  30,           // 30 запитів
  'Занадто багато запитів даних. Зачекайте.'
);

// Логування
app.use((req, res, next) => {
  const startTime = Date.now();
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  console.log('IP:', req.ip);
  console.log('Headers:', JSON.stringify(req.headers));

  if (req.method !== 'OPTIONS') {
    console.log('Body:', JSON.stringify(req.body));
  }

  res.on('finish', () => {
    const duration = Date.now() - startTime;
    console.log(`${req.method} ${req.url} completed in ${duration}ms with status ${res.statusCode}`);
  });

  next();
});

// Тестовий роут
app.get('/test', (req, res) => {
  res.json({ status: 'Server is working!' });
});

// Webhook для бота
app.post(`/bot${process.env.BOT_TOKEN}`, (req, res) => {
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

// Обробка помилок
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
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Received SIGTERM signal. Starting graceful shutdown...');
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

// Функція для підключення до бази даних
const connectToDatabase = async () => {
  try {
    const client = await pool.connect();
    console.log('Successfully connected to the database');
    client.release();
    return true;
  } catch (err) {
    console.error('Error connecting to the database:', err);
    return false;
  }
};

// Запуск сервера з повторними спробами підключення до БД
const startServer = async () => {
  let retries = 5;
  while (retries > 0) {
    try {
      const isConnected = await connectToDatabase();
      if (isConnected) {
        app.listen(PORT, () => {
          console.log(`Server is running on port ${PORT}`);
        });
        break;
      }
    } catch (err) {
      console.error(`Failed to start server, retries left: ${retries}`);
      retries--;
      if (retries === 0) {
        console.error('Failed to start server after multiple retries');
        process.exit(1);
      }
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
};

startServer();

export default app;