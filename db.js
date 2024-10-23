import { createPool } from '@vercel/postgres';
import dotenv from 'dotenv';

dotenv.config();

export const pool = createPool({
  connectionString: process.env.POSTGRES_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 1, // Зменшуємо максимальну кількість з'єднань
  idleTimeoutMillis: 15000, // Зменшуємо час очікування
  connectionTimeoutMillis: 5000,
  keepAlive: false // Вимикаємо keepAlive
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

pool.on('connect', () => {
  console.log('Connected to the database');
});

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
      client.release();
    }
  }
}

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
        level VARCHAR(50) DEFAULT 'Новачок',
        referrals BIGINT[],
        referred_by BIGINT,
        avatar VARCHAR(255),
        referral_rewards_claimed BIGINT[] DEFAULT ARRAY[]::BIGINT[]
      )
    `);
    console.log('Database initialized successfully');
  } catch (err) {
    console.error('Error initializing database:', err);
  } finally {
    if (client) {
      client.release();
    }
  }
}

// Видаляємо обробник process.on('exit')
// Замість цього додаємо обробник для graceful shutdown
process.on('SIGTERM', async () => {
  try {
    await pool.end();
    console.log('Pool has ended');
  } catch (err) {
    console.error('Error during pool shutdown:', err);
  } finally {
    process.exit(0);
  }
});

process.on('SIGINT', async () => {
  try {
    await pool.end();
    console.log('Pool has ended');
  } catch (err) {
    console.error('Error during pool shutdown:', err);
  } finally {
    process.exit(0);
  }
});

export default pool;