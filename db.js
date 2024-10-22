import { createPool } from '@vercel/postgres';
import dotenv from 'dotenv';

dotenv.config();

// Змінна для відстеження стану підключення
let dbReady = false;
let connectionAttempts = 0;
const MAX_CONNECTION_ATTEMPTS = 5;

// Налаштування пула підключень з розширеними параметрами
export const pool = createPool({
  connectionString: process.env.POSTGRES_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 20, // максимальна кількість клієнтів в пулі
  idleTimeoutMillis: 30000, // час очікування перед закриттям неактивного з'єднання
  connectionTimeoutMillis: 5000, // збільшений таймаут підключення
  keepAlive: true, // підтримка активного з'єднання
  keepAliveInitialDelayMillis: 10000 // затримка перед початком перевірки з'єднання
});

// Покращена обробка помилок пула
pool.on('error', (err) => {
  console.error('Неочікувана помилка в пулі підключень:', err);
  dbReady = false;
  // Спроба перепідключення
  attemptReconnect();
});

// Обробка успішного підключення
pool.on('connect', () => {
  console.log('Успішне підключення до бази даних');
  dbReady = true;
  connectionAttempts = 0;
});

// Функція спроби перепідключення
async function attemptReconnect() {
  if (connectionAttempts >= MAX_CONNECTION_ATTEMPTS) {
    console.error('Досягнуто максимальної кількості спроб підключення');
    return;
  }

  connectionAttempts++;
  console.log(`Спроба перепідключення до бази даних (${connectionAttempts}/${MAX_CONNECTION_ATTEMPTS})`);

  try {
    const client = await pool.connect();
    client.release();
    console.log('Перепідключення успішне');
    dbReady = true;
    connectionAttempts = 0;
  } catch (error) {
    console.error('Помилка при перепідключенні:', error);
    setTimeout(attemptReconnect, 5000 * connectionAttempts);
  }
}

// Функція для перевірки стану підключення
export async function testConnection() {
  let client;
  try {
    client = await pool.connect();
    const result = await client.query('SELECT NOW()');
    console.log('Тест підключення до бази даних успішний:', result.rows[0]);
    return true;
  } catch (err) {
    console.error('Помилка при тестуванні підключення до бази даних:', err);
    dbReady = false;
    attemptReconnect();
    return false;
  } finally {
    if (client) {
      client.release();
    }
  }
}

// Функція ініціалізації бази даних з повторними спробами
export async function initializeDatabase(maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let client;
    try {
      console.log(`Спроба ініціалізації бази даних (${attempt}/${maxAttempts})`);
      client = await pool.connect();

      // Створення таблиці користувачів з розширеними полями
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
          referrals BIGINT[] DEFAULT ARRAY[]::BIGINT[],
          referred_by BIGINT,
          avatar VARCHAR(255),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          settings JSONB DEFAULT '{}'::JSONB
        )
      `);

      // Створення індексів для оптимізації
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_referral_code ON users(referral_code);
        CREATE INDEX IF NOT EXISTS idx_coins ON users(coins);
        CREATE INDEX IF NOT EXISTS idx_total_coins ON users(total_coins);
      `);

      console.log('База даних успішно ініціалізована');
      dbReady = true;
      return true;
    } catch (err) {
      console.error(`Помилка при ініціалізації бази даних (спроба ${attempt}):`, err);
      if (attempt === maxAttempts) {
        throw new Error('Не вдалося ініціалізувати базу даних після всіх спроб');
      }
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
    } finally {
      if (client) {
        client.release();
      }
    }
  }
}

// Функція для перевірки готовності бази даних
export function isDatabaseReady() {
  return dbReady;
}

// Обробка завершення роботи
process.on('exit', async () => {
  console.log('Закриття пулу підключень до бази даних...');
  await pool.end();
});

// Обробка необроблених помилок
process.on('unhandledRejection', (reason, promise) => {
  console.error('Необроблена відмова промісу:', promise, 'причина:', reason);
});

export default pool;