import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { pool, testConnection, initializeDatabase } from './db.js';
import bot from './bot.js';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import {
  initializeUser,
  processReferral,
  getUserData,
  updateUserCoins,
  updateUserLevel,
  getUnclaimedRewards,
  claimReward
} from './userManagement.js';

dotenv.config();

console.log('Starting server with configuration:');
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('FRONTEND_URL:', process.env.FRONTEND_URL);
console.log('BOT_USERNAME:', process.env.BOT_USERNAME);

const app = express();

// Базові налаштування безпеки
app.set('trust proxy', 1);
app.enable('trust proxy');

// Middleware для безпеки
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      connectSrc: ["'self'", process.env.FRONTEND_URL],
      imgSrc: ["'self'", 'data:', 'https:'],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"]
    }
  }
}));

// CORS налаштування
const corsOptions = {
  origin: process.env.FRONTEND_URL,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 600
};

app.use(cors(corsOptions));

// Парсери для тіла запиту
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// Rate limiter
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  trustProxy: true,
  keyGenerator: (req) => {
    return req.ip;
  },
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      error: 'Too many requests, please try again later.'
    });
  }
});

app.use(limiter);

// Логування
app.use((req, res, next) => {
  const start = Date.now();
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  console.log('Headers:', JSON.stringify(req.headers));
  console.log('Body:', JSON.stringify(req.body));
  console.log('Query:', JSON.stringify(req.query));
  console.log('IP:', req.ip);

  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} ${res.statusCode} ${duration}ms`);
  });

  next();
});

// Middleware для перевірки з'єднання з БД
const checkDbConnection = async (req, res, next) => {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    next();
  } catch (error) {
    console.error('Database connection error:', error);
    res.status(503).json({
      success: false,
      error: 'Database connection error'
    });
  }
};

// API routes
app.get('/api/rewards/unclaimed', checkDbConnection, async (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({
      success: false,
      error: 'User ID is required'
    });
  }

  try {
    const rewards = await getUnclaimedRewards(userId);
    res.json({
      success: true,
      rewards
    });
  } catch (error) {
    console.error('Error fetching unclaimed rewards:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

app.post('/api/rewards/claim', checkDbConnection, async (req, res) => {
  const { userId, rewardId } = req.body;

  if (!userId || !rewardId) {
    return res.status(400).json({
      success: false,
      error: 'User ID and reward ID are required'
    });
  }

  try {
    const result = await claimReward(userId, rewardId);
    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('Error claiming reward:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

app.post('/api/updateUserLevel', checkDbConnection, async (req, res) => {
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
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

app.get('/test', (req, res) => {
  res.send('Server is working!');
});

app.post(`/bot${process.env.BOT_TOKEN}`, (req, res) => {
  try {
    console.log('Received update from Telegram:', JSON.stringify(req.body));
    bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (error) {
    console.error('Error processing Telegram update:', error);
    res.sendStatus(500);
  }
});

app.post('/api/initUser', checkDbConnection, async (req, res) => {
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
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

app.get('/api/getUserData', checkDbConnection, async (req, res) => {
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
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

app.post('/api/updateUserCoins', checkDbConnection, async (req, res) => {
  const { userId, coinsToAdd } = req.body;

  if (!userId || coinsToAdd === undefined) {
    return res.status(400).json({
      success: false,
      error: 'User ID and coins amount are required'
    });
  }

  try {
    const result = await updateUserCoins(userId, coinsToAdd);
    res.json(result);
  } catch (error) {
    console.error('Error updating user coins:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

app.post('/api/processReferral', checkDbConnection, async (req, res) => {
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
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Graceful shutdown
const gracefulShutdown = async (signal) => {
  console.log(`${signal} received. Starting graceful shutdown...`);

  // Даємо час на завершення активних з'єднань
  setTimeout(() => {
    console.error('Forceful shutdown after timeout');
    process.exit(1);
  }, 10000);

  try {
    await pool.end();
    console.log('Database connections closed');
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Запуск сервера
const PORT = process.env.PORT || 3001;

const startServer = async () => {
  try {
    // Перевіряємо з'єднання з базою даних
    await testConnection();
    console.log('Database connection successful');

    // Ініціалізуємо базу даних
    await initializeDatabase();
    console.log('Database initialized successfully');

    // Запускаємо сервер
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Error starting server:', error);

    // Запускаємо сервер навіть при помилці з БД
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT} (without DB connection)`);
    });
  }
};

startServer();

export default app;