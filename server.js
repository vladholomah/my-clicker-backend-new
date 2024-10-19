import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { pool } from './db.js';
import bot from './bot.js';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import getFriends from './getFriends.js';

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

app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  trustProxy: false,
  keyGenerator: (req) => {
    return req.ip;
  }
});

app.use(limiter);

console.log('Rate limiter configuration:', JSON.stringify(limiter.options, null, 2));

app.use((req, res, next) => {
  console.log(`Received ${req.method} request to ${req.url}`);
  console.log('IP:', req.ip);
  console.log('X-Forwarded-For:', req.headers['x-forwarded-for']);
  next();
});

const generateReferralCode = () => {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
};

app.post('/api/initUser', async (req, res) => {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'User ID is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    console.log('Спроба ініціалізації користувача:', userId);
    let { rows: user } = await client.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
    console.log('Результат SQL-запиту SELECT:', JSON.stringify(user));

    if (user.length === 0) {
      console.log('Користувача не знайдено, створюємо нового');
      const referralCode = generateReferralCode();
      const { rows: newUser } = await client.query(
        'INSERT INTO users (telegram_id, referral_code, coins, total_coins, level) VALUES ($1, $2, 0, 0, $3) RETURNING *',
        [userId, referralCode, 'Новачок']
      );
      console.log('Результат створення нового користувача:', JSON.stringify(newUser));
      user = newUser;
    }

    const referralLink = `https://t.me/${process.env.BOT_USERNAME}?start=${user[0].referral_code}`;

    await client.query('COMMIT');

    res.json({
      telegramId: user[0].telegram_id.toString(),
      referralCode: user[0].referral_code,
      referralLink: referralLink,
      coins: user[0].coins,
      totalCoins: user[0].total_coins,
      level: user[0].level
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error initializing user:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  } finally {
    client.release();
  }
});

app.get('/api/getUserData', async (req, res) => {
  const { userId } = req.query;
  if (!userId) {
    return res.status(400).json({ error: 'User ID is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: user } = await client.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
    if (user.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { rows: friends } = await client.query(`
      SELECT telegram_id, first_name, last_name, username, coins, total_coins, level, avatar
      FROM users
      WHERE telegram_id = ANY($1)
    `, [user[0].referrals]);

    const referralLink = `https://t.me/${process.env.BOT_USERNAME}?start=${user[0].referral_code}`;

    await client.query('COMMIT');

    res.json({
      telegramId: user[0].telegram_id.toString(),
      firstName: user[0].first_name,
      lastName: user[0].last_name,
      username: user[0].username,
      coins: user[0].coins,
      totalCoins: user[0].total_coins,
      level: user[0].level,
      referralCode: user[0].referral_code,
      referralLink: referralLink,
      friends: friends.map(friend => ({
        telegramId: friend.telegram_id.toString(),
        firstName: friend.first_name,
        lastName: friend.last_name,
        username: friend.username,
        coins: friend.coins,
        totalCoins: friend.total_coins,
        level: friend.level,
        avatar: friend.avatar
      }))
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error fetching user data:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

app.post('/api/updateUserCoins', async (req, res) => {
  const { userId, coinsToAdd } = req.body;
  if (!userId || coinsToAdd === undefined) {
    return res.status(400).json({ error: 'User ID and coins amount are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: result } = await client.query(`
      UPDATE users
      SET coins = coins + $1, total_coins = total_coins + $1
      WHERE telegram_id = $2
      RETURNING coins, total_coins
    `, [coinsToAdd, userId]);

    if (result.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    await client.query('COMMIT');

    res.json({
      newCoins: result[0].coins,
      newTotalCoins: result[0].total_coins
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating user coins:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

app.get('/api/getFriends', getFriends);

app.get('/api/test-db', async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT NOW()');
    console.log('Database test query result:', result.rows[0]);
    res.json({ success: true, currentTime: result.rows[0].now });
  } catch (error) {
    console.error('Database test query error:', error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

app.get('/', (req, res) => {
  res.send('Holmah Coin Bot Server is running!');
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.stack);
  res.status(500).send('Something broke!');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Тут ви можете додати логіку для graceful shutdown, якщо потрібно
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

export default app;