// db.js

import { createPool } from '@vercel/postgres';
import dotenv from 'dotenv';

dotenv.config();

export const pool = createPool({
  connectionString: process.env.POSTGRES_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  keepAlive: true
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

    // Перевіряємо чи існує колонка referral_rewards_claimed
    const { rows } = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'users' 
      AND column_name = 'referral_rewards_claimed'
    `);

    // Якщо колонка не існує, додаємо її
    if (rows.length === 0) {
      await client.query(`
        ALTER TABLE users 
        ADD COLUMN IF NOT EXISTS referral_rewards_claimed BIGINT[] DEFAULT ARRAY[]::BIGINT[]
      `);
      console.log('Added referral_rewards_claimed column to users table');
    }

    // Створюємо таблицю, якщо вона не існує
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
    throw err;
  } finally {
    if (client) {
      client.release();
    }
  }
}

process.on('exit', async () => {
  console.log('Closing database pool...');
  await pool.end();
});

export default pool;