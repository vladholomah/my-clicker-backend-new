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
      // Безпечне закриття існуючого пулу
      const oldPool = pool;
      pool = null;
      await oldPool.end().catch(err => console.error('Помилка при закритті старого пулу:', err));
    }

    // Створення нового пулу
    await createPoolWithRetry();
  } catch (err) {
    console.error('Не вдалося відновити пул підключень:', err);
  }
}

async function getPool() {
  if (!pool) {
    await createPoolWithRetry();
  }
  return pool;
}

export async function query(text, params) {
  const currentPool = await getPool();
  const client = await currentPool.connect();
  try {
    const result = await client.query(text, params);
    return result;
  } finally {
    client.release();
  }
}

export async function testConnection() {
  try {
    const result = await query('SELECT NOW()');
    console.log('Тест підключення до бази даних успішний:', result.rows[0]);
    return true;
  } catch (err) {
    console.error('Помилка при тестуванні підключення до бази даних:', err);
    return false;
  }
}

export async function initializeDatabase() {
  try {
    console.log('Початок ініціалізації бази даних...');
    const result = await query(`
      CREATE TABLE IF NOT EXISTS users (
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
    await query('CREATE INDEX IF NOT EXISTS idx_referral_code ON users(referral_code)');
    await query('CREATE INDEX IF NOT EXISTS idx_coins ON users(coins)');
    await query('CREATE INDEX IF NOT EXISTS idx_total_coins ON users(total_coins)');

    console.log('База даних успішно ініціалізована');
    return result;
  } catch (err) {
    console.error('Помилка при ініціалізації бази даних:', err);
    throw err;
  }
}

export function isDatabaseReady() {
  return dbReady && pool !== null;
}

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

export { pool };