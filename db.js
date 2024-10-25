import { createPool } from '@vercel/postgres';
import dotenv from 'dotenv';

dotenv.config();

export const pool = createPool({
  connectionString: process.env.POSTGRES_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 20, // максимальна кількість клієнтів у пулі
  idleTimeoutMillis: 30000, // час очікування перед закриттям неактивного з'єднання
  connectionTimeoutMillis: 2000, // час очікування для встановлення з'єднання
  keepAlive: true // підтримка активного з'єднання
});

// Додаємо обробники подій для пулу
pool.on('connect', () => {
  console.log('New client connected to database');
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

pool.on('acquire', () => {
  console.log('Client acquired from pool');
});

pool.on('remove', () => {
  console.log('Client removed from pool');
});

// Функція для тестування з'єднання
export async function testConnection() {
  let client;
  try {
    client = await pool.connect();
    console.log('Testing database connection...');

    // Тестуємо підключення простим запитом
    const result = await client.query('SELECT NOW()');
    console.log('Database connection test successful:', result.rows[0]);

    // Перевіряємо наявність потрібної таблиці
    const tableCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'users'
      );
    `);

    console.log('Users table exists:', tableCheck.rows[0].exists);

    return true;
  } catch (err) {
    console.error('Error testing database connection:', err);
    return false;
  } finally {
    if (client) {
      client.release();
      console.log('Test connection client released');
    }
  }
}

// Функція ініціалізації бази даних
export async function initializeDatabase() {
  let client;
  try {
    client = await pool.connect();
    console.log('Initializing database...');

    // Створюємо таблицю користувачів, якщо вона не існує
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id BIGINT PRIMARY KEY,
        first_name TEXT NOT NULL DEFAULT 'User',
        last_name TEXT,
        username TEXT,
        coins TEXT NOT NULL DEFAULT '0',
        total_coins TEXT NOT NULL DEFAULT '0',
        referral_code TEXT,
        referrals BIGINT[] DEFAULT ARRAY[]::bigint[],
        referred_by BIGINT,
        avatar TEXT,
        level TEXT NOT NULL DEFAULT 'Silver',
        has_unclaimed_rewards BOOLEAN NOT NULL DEFAULT false
      )
    `);

    // Створюємо індекси для оптимізації запитів
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_referral_code 
      ON users(referral_code) 
      WHERE referral_code IS NOT NULL
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_referred_by 
      ON users(referred_by) 
      WHERE referred_by IS NOT NULL
    `);

    console.log('Database initialized successfully');

    // Перевіряємо наявність даних
    const { rows } = await client.query('SELECT COUNT(*) FROM users');
    console.log('Current number of users:', rows[0].count);

  } catch (err) {
    console.error('Error initializing database:', err);
    throw err;
  } finally {
    if (client) {
      client.release();
      console.log('Initialization client released');
    }
  }
}

// Функція для очищення неактивних з'єднань
async function cleanupConnections() {
  try {
    await pool.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE state = $1', ['idle']);
    console.log('Cleaned up idle connections');
  } catch (err) {
    console.error('Error cleaning up connections:', err);
  }
}

// Встановлюємо періодичне очищення з'єднань
setInterval(cleanupConnections, 60000); // кожну хвилину

// Обробка завершення процесу
process.on('exit', async () => {
  console.log('Closing database pool...');
  await pool.end();
});

process.on('SIGINT', async () => {
  console.log('Received SIGINT. Closing database pool...');
  await pool.end();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM. Closing database pool...');
  await pool.end();
  process.exit(0);
});

// Обробка необроблених помилок
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

export default pool;