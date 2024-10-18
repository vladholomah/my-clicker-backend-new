import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { sql } from "@vercel/postgres";
import bot from './bot.js';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import getFriends from './getFriends.js';

dotenv.config();

console.log('Starting server...');
console.log('Environment variables:');
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('Database URL (перші 20 символів):', process.env.POSTGRES_URL.substring(0, 20) + '...');
console.log('BOT_TOKEN:', process.env.BOT_TOKEN ? 'Set' : 'Not set');
console.log('FRONTEND_URL:', process.env.FRONTEND_URL);

const app = express();

const createTableIfNotExists = async () => {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id BIGINT PRIMARY KEY,
        first_name TEXT,
        last_name TEXT,
        username TEXT,
        coins BIGINT DEFAULT 0,
        total_coins BIGINT DEFAULT 0,
        referral_code TEXT UNIQUE,
        referrals BIGINT[] DEFAULT ARRAY[]::BIGINT[],
        referred_by BIGINT,
        avatar TEXT,
        level TEXT DEFAULT 'Новачок'
      )
    `;
    console.log('Таблиця users успішно створена або вже існує');
  } catch (error) {
    console.error('Помилка при створенні таблиці users:', error);
  }
};

async function testDatabaseConnection() {
  try {
    const result = await sql`SELECT NOW()`;
    console.log('Database connection test successful:', result[0]);
  } catch (error) {
    console.error('Database connection test failed:', error);
  }
}

testDatabaseConnection();
createTableIfNotExists().catch(console.error);

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
    const forwardedFor = req.headers['x-forwarded-for'];
    if (forwardedFor) {
      const ips = forwardedFor.split(',').map(ip => ip.trim());
      return ips[0];
    }
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

const setWebhook = async () => {
  try {
    const webhookInfo = await bot.getWebHookInfo();
    if (!webhookInfo.url) {
      const webhookUrl = `${process.env.REACT_APP_API_URL.replace(/\/$/, '')}/bot${process.env.BOT_TOKEN}`;
      console.log('Setting webhook URL:', webhookUrl);
      await bot.setWebHook(webhookUrl, {
        max_connections: 40,
        drop_pending_updates: true
      });
      console.log('Webhook set successfully');
    } else {
      console.log('Webhook already set:', webhookInfo.url);
    }
  } catch (error) {
    console.error('Error checking/setting webhook:', error);
  }
};

setWebhook();

app.post(`/bot${process.env.BOT_TOKEN}`, (req, res) => {
  console.log('Отримано оновлення від Telegram:', JSON.stringify(req.body));
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

const generateReferralCode = () => {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
};

app.post('/api/initUser', async (req, res) => {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'User ID is required' });
  }

  try {
    console.log('Спроба ініціалізації користувача:', userId);
    let { rows: user } = await sql`SELECT * FROM users WHERE telegram_id = ${userId}`;
    console.log('Результат SQL-запиту SELECT:', JSON.stringify(user));

    if (user.length === 0) {
      console.log('Користувача не знайдено, створюємо нового');
      const referralCode = generateReferralCode();
      const insertQuery = sql`
        INSERT INTO users (telegram_id, referral_code, coins, total_coins, level)
        VALUES (${userId}, ${referralCode}, 0, 0, 'Новачок')
        RETURNING *
      `;
      console.log('SQL запит для створення користувача:', insertQuery);
      const { rows: newUser } = await insertQuery;
      console.log('Результат створення нового користувача:', JSON.stringify(newUser));
      user = newUser;
    }

    res.json({
      telegramId: user[0].telegram_id.toString(),
      referralCode: user[0].referral_code,
      coins: user[0].coins,
      totalCoins: user[0].total_coins,
      level: user[0].level
    });
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
    const { rows: user } = await sql`SELECT * FROM users WHERE telegram_id = ${userId}`;
    if (user.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Отримуємо друзів користувача
    const { rows: friends } = await sql`
      SELECT telegram_id, first_name, last_name, username, coins, total_coins, level, avatar
      FROM users
      WHERE telegram_id = ANY(${user[0].referrals})
    `;

    const referralLink = `https://t.me/${process.env.BOT_USERNAME}?start=${user[0].referral_code}`;

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
    const { rows: result } = await sql`
      UPDATE users
      SET coins = coins + ${coinsToAdd}, total_coins = total_coins + ${coinsToAdd}
      WHERE telegram_id = ${userId}
      RETURNING coins, total_coins
    `;

    if (result.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      newCoins: result[0].coins,
      newTotalCoins: result[0].total_coins
    });
  } catch (error) {
    console.error('Error updating user coins:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/getFriends', getFriends);

app.get('/api/test-db', async (req, res) => {
  try {
    const result = await sql`SELECT NOW()`;
    console.log('Database test query result:', result);
    res.json({ success: true, currentTime: result[0].now });
  } catch (error) {
    console.error('Database test query error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/', (req, res) => {
  res.send('Holmah Coin Bot Server is running!');
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.stack);
  res.status(500).send('Something broke!');
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

export default app;