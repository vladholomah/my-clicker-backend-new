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
  updateUserLevel,
  getUnclaimedRewards,
  claimReward
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

app.set('trust proxy', 1);
app.enable('trust proxy');
console.log('Trust proxy setting:', app.get('trust proxy'));

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

// Logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  console.log('IP:', req.ip);
  console.log('X-Forwarded-For:', req.headers['x-forwarded-for']);
  console.log('Headers:', JSON.stringify(req.headers));
  console.log('Body:', JSON.stringify(req.body));
  next();
});

// Нові маршрути для системи винагород
app.get('/api/rewards/unclaimed', async (req, res) => {
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
      details: error.message
    });
  }
});

app.post('/api/rewards/claim', async (req, res) => {
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
      details: error.message
    });
  }
});

// Існуючі маршрути
app.post('/api/updateUserLevel', async (req, res) => {
  const { userId, newLevel } = req.body;

  if (!userId || !newLevel) {
    return res.status(400).json({ error: 'User ID and new level are required' });
  }

  try {
    const result = await updateUserLevel(userId, newLevel);
    res.json(result);
  } catch (error) {
    console.error('Error updating user level:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// Інші існуючі маршрути залишаються без змін...
app.get('/test', (req, res) => {
  res.send('Server is working!');
});

app.post(`/bot${process.env.BOT_TOKEN}`, (req, res) => {
  console.log('Received update from Telegram:', JSON.stringify(req.body));
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.post('/api/initUser', async (req, res) => {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'User ID is required' });
  }

  try {
    const userData = await initializeUser(userId);
    res.json(userData);
  } catch (error) {
    console.error('Error initializing user:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

app.get('/api/getUserData', async (req, res) => {
  const { userId } = req.query;
  if (!userId) {
    return res.status(400).json({ error: 'User ID is required' });
  }

  try {
    const userData = await getUserData(userId);
    res.json(userData);
  } catch (error) {
    console.error('Error fetching user data:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/updateUserCoins', async (req, res) => {
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

app.post('/api/processReferral', async (req, res) => {
  const { referralCode, userId } = req.body;
  if (!referralCode || !userId) {
    return res.status(400).json({ error: 'Referral code and user ID are required' });
  }

  try {
    const result = await processReferral(referralCode, userId);
    res.json(result);
  } catch (error) {
    console.error('Error processing referral:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.stack);
  res.status(500).send('Something broke!');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

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