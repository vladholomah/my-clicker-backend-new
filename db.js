import { createPool } from '@vercel/postgres';
import dotenv from 'dotenv';

dotenv.config();

const pool = createPool({
  connectionString: process.env.POSTGRES_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  keepAlive: true
});

// Обробники подій пула
pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

pool.on('connect', () => {
  console.log('Connected to the database');
});

// Перевірка з'єднання
export async function testConnection() {
  let client;
  try {
    client = await pool.connect();
    const result = await client.query('SELECT NOW()');
    console.log('Database connection test successful:', result.rows[0]);
    return true;
  } catch (err) {
    console.error('Error testing database connection:', err);
    return false;
  } finally {
    if (client) {
      await client.release();
    }
  }
}

// Ініціалізація бази даних
export async function initializeDatabase() {
  let client;
  try {
    client = await pool.connect();
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id BIGINT PRIMARY KEY,
        first_name VARCHAR(255),
        last_name VARCHAR(255),
        username VARCHAR(255),
        referral_code VARCHAR(10) UNIQUE,
        coins INTEGER DEFAULT 0,
        total_coins INTEGER DEFAULT 0,
        level VARCHAR(50) DEFAULT 'Silver',
        referrals BIGINT[],
        referred_by BIGINT,
        avatar VARCHAR(255),
        has_unclaimed_rewards BOOLEAN DEFAULT FALSE
      );

      CREATE TABLE IF NOT EXISTS referral_rewards (
        id SERIAL PRIMARY KEY,
        referrer_id BIGINT REFERENCES users(telegram_id),
        referred_id BIGINT REFERENCES users(telegram_id),
        reward_amount INTEGER DEFAULT 1000,
        is_claimed BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        claimed_at TIMESTAMP WITH TIME ZONE,
        CONSTRAINT unique_referral UNIQUE(referrer_id, referred_id)
      );
    `);
    console.log('Database initialized successfully');
  } catch (err) {
    console.error('Error initializing database:', err);
    throw err;
  } finally {
    if (client) {
      await client.release();
    }
  }
}

// Graceful shutdown
const cleanupOnExit = async () => {
  try {
    console.log('Closing database pool...');
    await pool.end();
  } catch (err) {
    console.error('Error closing pool:', err);
  }
};

// Обробка завершення процесу
process.on('exit', cleanupOnExit);
process.on('SIGINT', async () => {
  await cleanupOnExit();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await cleanupOnExit();
  process.exit(0);
});

// Перехоплення необроблених помилок
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

export { pool };