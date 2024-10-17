import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { neon, neonConfig } from '@neondatabase/serverless';
import pkg from 'pg';
const { Pool } = pkg;
import bot from './bot.js';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import getFriends from './getFriends.js';

dotenv.config();

console.log('Starting server...');
console.log('Environment variables:');
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('Database URL:', process.env.POSTGRES_URL ? 'Set (not showing for security)' : 'Not set');
console.log('BOT_TOKEN:', process.env.BOT_TOKEN ? 'Set' : 'Not set');
console.log('FRONTEND_URL:', process.env.FRONTEND_URL);

const app = express();

neonConfig.fetchConnectionCache = true;

const sql = neon(process.env.POSTGRES_URL);
const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
  ssl: {
    rejectUnauthorized: false,
  },
  max: 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

pool.on('connect', () => {
  console.log('New client connected to database');
});

async function testDatabaseConnection() {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW()');
    console.log('Database connection test successful:', result.rows[0]);
    client.release();
  } catch (error) {
    console.error('Database connection test failed:', error);
  }
}

testDatabaseConnection();

setInterval(() => {
  console.log(`Active connections: ${pool.totalCount}, Idle connections: ${pool.idleCount}`);
}, 60000);

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

const webhookUrl = `${process.env.REACT_APP_API_URL.replace(/\/$/, '')}/bot${process.env.BOT_TOKEN}`;
console.log('Setting webhook URL:', webhookUrl);
bot.setWebHook(webhookUrl, {
  max_connections: 40,
  drop_pending_updates: true
}).then(() => {
  console.log('Webhook set successfully');
}).catch((error) => {
  console.error('Error setting webhook:', error);
});

app.post(`/bot${process.env.BOT_TOKEN}`, (req, res) => {
  console.log('Received update from Telegram');
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get('/api/getUserData', async (req, res) => {
  const { userId } = req.query;
  if (!userId) {
    return res.status(400).json({ error: 'User ID is required' });
  }

  try {
    const result = await sql`SELECT * FROM users WHERE telegram_id = ${userId}`;
    if (result.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result[0];
    res.json({
      telegramId: user.telegram_id,
      firstName: user.first_name,
      lastName: user.last_name,
      username: user.username,
      coins: user.coins,
      totalCoins: user.total_coins,
      level: user.level,
      referralCode: user.referral_code
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
    const result = await sql`
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
    console.log('Attempting to connect to database...');
    const result = await sql`SELECT NOW()`;
    console.log('Query executed successfully');
    res.json({ success: true, time: result[0].now });
  } catch (error) {
    console.error('Database connection error:', error);
    res.status(500).json({ success: false, error: error.message, stack: error.stack });
  }
});

app.get('/api/test-db-detailed', async (req, res) => {
  console.log('Attempting detailed database connection test...');
  const testResults = {
    connectionAttempt: false,
    connectionSuccess: false,
    queryAttempt: false,
    querySuccess: false,
    error: null
  };

  try {
    const client = await pool.connect();
    testResults.connectionAttempt = true;
    testResults.connectionSuccess = true;
    console.log('Database connection established');

    try {
      const result = await client.query('SELECT NOW()');
      testResults.queryAttempt = true;
      testResults.querySuccess = true;
      console.log('Query executed successfully:', result.rows[0]);
    } catch (queryError) {
      testResults.queryAttempt = true;
      testResults.error = `Query error: ${queryError.message}`;
      console.error('Query error:', queryError);
    } finally {
      client.release();
    }
  } catch (connectionError) {
    testResults.connectionAttempt = true;
    testResults.error = `Connection error: ${connectionError.message}`;
    console.error('Database connection error:', connectionError);
  }

  res.json(testResults);
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