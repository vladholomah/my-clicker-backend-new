import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { pool, initializeDatabase, testConnection } from './db.js';
import bot from './bot.js';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { initializeUser, processReferral, getUserData, updateUserCoins } from './userManagement.js';

dotenv.config();

// Налаштування rate limiter
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 хвилина
  max: 60, // максимум 60 запитів за хвилину
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  trustProxy: true,
  keyGenerator: (req) => {
    return req.ip || req.headers['x-forwarded-for'];
  },
  skip: (req) => {
    // Пропускаємо обмеження для webhook від Telegram
    return req.url.includes(`/bot${process.env.BOT_TOKEN}`);
  }
});

const app = express();

// Базові налаштування безпеки
app.set('trust proxy', 1);
app.enable('trust proxy');
app.use(helmet());

// Налаштування CORS
app.use(cors({
  origin: process.env.FRONTEND_URL,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(limiter);

// Middleware для логування
app.use((req, res, next) => {
  const start = Date.now();
  const requestId = Math.random().toString(36).substring(7);

  console.log(`[${requestId}] ${new Date().toISOString()} - ${req.method} ${req.url}`);
  console.log(`[${requestId}] Headers:`, JSON.stringify(req.headers));
  console.log(`[${requestId}] Body:`, JSON.stringify(req.body));

  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[${requestId}] Request completed in ${duration}ms with status ${res.statusCode}`);
  });

  next();
});

// Middleware для перевірки з'єднання з базою даних
const checkDbConnection = async (req, res, next) => {
  try {
    const isConnected = await testConnection();
    if (!isConnected) {
      throw new Error('Database connection failed');
    }
    next();
  } catch (error) {
    console.error('Database connection error:', error);
    res.status(503).json({ error: 'Database service unavailable' });
  }
};

// Маршрути API
app.post('/api/initUser', checkDbConnection, async (req, res) => {
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

app.get('/api/getUserData', checkDbConnection, async (req, res) => {
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

app.post('/api/updateUserCoins', checkDbConnection, async (req, res) => {
  const { userId, coinsToAdd } = req.body;

  if (!userId || coinsToAdd === undefined) {
    return res.status(400).json({ error: 'User ID and coins amount are required' });
  }

  try {
    const result = await updateUserCoins(userId, coinsToAdd);
    res.json(result);
  } catch (error) {
    console.error('Error updating user coins:', error);
    if (error.message === 'User not found') {
      return res.status(404).json({ error: 'User not found' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/processReferral', checkDbConnection, async (req, res) => {
  const { referralCode, userId } = req.body;

  if (!referralCode || !userId) {
    return res.status(400).json({ error: 'Referral code and user ID are required' });
  }

  try {
    const result = await processReferral(referralCode, userId);
    res.json(result);
  } catch (error) {
    console.error('Error processing referral:', error);
    if (error.message === 'User already referred') {
      return res.status(409).json({ error: 'User already referred' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Webhook route для Telegram
app.post(`/bot${process.env.BOT_TOKEN}`, async (req, res) => {
  try {
    console.log('Received update from Telegram:', JSON.stringify(req.body));
    await bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (error) {
    console.error('Error processing Telegram update:', error);
    res.sendStatus(500);
  }
});

// Базовий маршрут для перевірки роботи сервера
app.get('/', async (req, res) => {
  try {
    const dbStatus = await testConnection();
    res.json({
      status: 'Server is running',
      database: dbStatus ? 'connected' : 'disconnected',
      environment: process.env.NODE_ENV
    });
  } catch (error) {
    res.status(500).json({
      status: 'Server is running',
      database: 'error',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// Обробка помилок
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Обробка необроблених відхилень промісів
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Обробка необроблених помилок
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Даємо час на логування перед виходом
  setTimeout(() => {
    process.exit(1);
  }, 1000);
});

// Ініціалізація сервера
const PORT = process.env.PORT || 3001;

async function startServer() {
  try {
    // Ініціалізація бази даних
    await initializeDatabase();
    console.log('Database initialized successfully');

    // Запуск сервера
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Error starting server:', error);
    process.exit(1);
  }
}

startServer();

export default app;