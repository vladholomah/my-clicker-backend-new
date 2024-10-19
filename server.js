import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Pool } from '@vercel/postgres';
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

const app = express();

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 1,
  connectionTimeoutMillis: 0,
  idleTimeoutMillis: 0
});

async function connectWithRetry(maxRetries = 10, delay = 10000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      console.log(`Спроба підключення до бази даних ${i + 1}/${maxRetries}`);
      const result = await pool.query('SELECT NOW()');
      console.log('Підключення до бази даних успішне:', result.rows[0]);
      return;
    } catch (error) {
      console.error(`Спроба ${i + 1} не вдалася. Повторна спроба через ${delay / 1000} секунд...`);
      console.error('Деталі помилки:', error);
      if (i === maxRetries - 1) {
        console.error('Помилка підключення до бази даних:', error);
      }
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error('Не вдалося підключитися до бази даних після кількох спроб');
}

// Функція для створення таблиці, якщо вона не існує
const createTableIfNotExists = async () => {
  try {
    await pool.query(`
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
    `);
    console.log('Таблиця users успішно створена або вже існує');
  } catch (error) {
    console.error('Помилка при створенні таблиці users:', error);
  }
};

// Ініціалізація бази даних
const initDatabase = async () => {
  try {
    await connectWithRetry();
    await createTableIfNotExists();
    console.log('База даних успішно ініціалізована');
  } catch (error) {
    console.error('Помилка при ініціалізації бази даних:', error);
    process.exit(1);
  }
};

initDatabase();

// Налаштування Express
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

// Налаштування rate limiter
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

// Логування запитів
app.use((req, res, next) => {
  console.log(`Received ${req.method} request to ${req.url}`);
  console.log('IP:', req.ip);
  console.log('X-Forwarded-For:', req.headers['x-forwarded-for']);
  next();
});

// Налаштування webhook для бота
const setWebhook = async () => {
  try {
    const webhookInfo = await bot.getWebHookInfo();
    if (!webhookInfo.url) {
      const webhookUrl = `${process.env.REACT_APP_API_URL}/bot${process.env.BOT_TOKEN}`;
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

// Обробка webhook'ів від Telegram
app.post(`/bot${process.env.BOT_TOKEN}`, (req, res) => {
  console.log('Отримано оновлення від Telegram:', JSON.stringify(req.body));
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Генерація реферального коду
const generateReferralCode = () => {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
};

// API ендпоінти

app.post('/api/initUser', async (req, res) => {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'User ID is required' });
  }

  try {
    console.log('Спроба ініціалізації користувача:', userId);
    let { rows: user } = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
    console.log('Результат SQL-запиту SELECT:', JSON.stringify(user));

    if (user.length === 0) {
      console.log('Користувача не знайдено, створюємо нового');
      const referralCode = generateReferralCode();
      const { rows: newUser } = await pool.query(
        'INSERT INTO users (telegram_id, referral_code, coins, total_coins, level) VALUES ($1, $2, 0, 0, $3) RETURNING *',
        [userId, referralCode, 'Новачок']
      );
      console.log('Результат створення нового користувача:', JSON.stringify(newUser));
      user = newUser;
    }

    const referralLink = `https://t.me/${process.env.BOT_USERNAME}?start=${user[0].referral_code}`;

    res.json({
      telegramId: user[0].telegram_id.toString(),
      referralCode: user[0].referral_code,
      referralLink: referralLink,
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
    const { rows: user } = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
    if (user.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { rows: friends } = await pool.query(`
      SELECT telegram_id, first_name, last_name, username, coins, total_coins, level, avatar
      FROM users
      WHERE telegram_id = ANY($1)
    `, [user[0].referrals]);

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
    const { rows: result } = await pool.query(`
      UPDATE users
      SET coins = coins + $1, total_coins = total_coins + $1
      WHERE telegram_id = $2
      RETURNING coins, total_coins
    `, [coinsToAdd, userId]);

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
    const result = await pool.query('SELECT NOW()');
    console.log('Database test query result:', result.rows[0]);
    res.json({ success: true, currentTime: result.rows[0].now });
  } catch (error) {
    console.error('Database test query error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/', (req, res) => {
  res.send('Holmah Coin Bot Server is running!');
});

// Обробка помилок
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.stack);
  res.status(500).send('Something broke!');
});

// Запуск сервера
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

export default app;