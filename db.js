import { createPool } from '@vercel/postgres';
import dotenv from 'dotenv';

dotenv.config();

let pool = null;
let dbReady = false;
let connectionAttempts = 0;
const MAX_CONNECTION_ATTEMPTS = 5;

async function createPoolWithRetry() {
  try {
    pool = createPool({
      connectionString: process.env.POSTGRES_URL,
      ssl: {
        rejectUnauthorized: false
      },
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000
    });

    // Перевірка з'єднання
    const client = await pool.connect();
    await client.query('SELECT NOW()');
    client.release();

    console.log('Успішне підключення до бази даних');
    dbReady = true;
    connectionAttempts = 0;

    // Встановлюємо обробники подій
    pool.on('error', handlePoolError);
    pool.on('connect', () => {
      console.log('Нове підключення до бази даних встановлено');
      dbReady = true;
    });

    return pool;
  } catch (error) {
    console.error('Помилка при створенні пулу:', error);
    connectionAttempts++;

    if (connectionAttempts < MAX_CONNECTION_ATTEMPTS) {
      console.log(`Спроба підключення ${connectionAttempts}/${MAX_CONNECTION_ATTEMPTS}`);
      await new Promise(resolve => setTimeout(resolve, 1000 * connectionAttempts));
      return createPoolWithRetry();
    }

    throw error;
  }
}

async function handlePoolError(error) {
  console.error('Помилка пулу підключень:', error);
  dbReady = false;

  try {
    if (pool) {
      const oldPool = pool;
      pool = null;
      await oldPool.end().catch(err => console.error('Помилка при закритті старого пулу:', err));
    }
    await createPoolWithRetry();
  } catch (err) {
    console.error('Не вдалося відновити пул підключень:', err);
  }
}

export async function initializeDatabase() {
  let client;
  try {
    console.log('Початок ініціалізації бази даних...');
    client = await pool.connect();

    // Видаляємо стару таблицю, якщо вона існує
    await client.query('DROP TABLE IF EXISTS users');

    // Створюємо нову таблицю з правильною структурою
    await client.query(`
      CREATE TABLE users (
        telegram_id BIGINT PRIMARY KEY,
        first_name VARCHAR(255),
        last_name VARCHAR(255),
        username VARCHAR(255),
        referral_code VARCHAR(10) UNIQUE,
        coins INTEGER DEFAULT 0,
        total_coins INTEGER DEFAULT 0,
        level VARCHAR(50) DEFAULT 'Новачок',
        referrals BIGINT[] DEFAULT ARRAY[]::BIGINT[],
        referred_by BIGINT,
        avatar VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        settings JSONB DEFAULT '{}'::JSONB
      )
    `);

    // Створення індексів
    await client.query(`
      CREATE INDEX idx_referral_code ON users(referral_code);
      CREATE INDEX idx_coins ON users(coins);
      CREATE INDEX idx_total_coins ON users(total_coins);
      CREATE INDEX idx_created_at ON users(created_at);
      CREATE INDEX idx_last_active ON users(last_active);
    `);

    console.log('База даних успішно ініціалізована');
    return true;
  } catch (err) {
    console.error('Помилка при ініціалізації бази даних:', err);
    throw err;
  } finally {
    if (client) {
      client.release();
    }
  }
}

async function query(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

export { pool, query, dbReady };

// Ініціалізація бази даних при імпорті модуля
createPoolWithRetry().catch(err => {
  console.error('Помилка при початковій ініціалізації бази даних:', err);
});

// Обробка завершення роботи
process.on('exit', async () => {
  console.log('Закриття пулу підключень до бази даних...');
  if (pool) {
    await pool.end().catch(console.error);
  }
});