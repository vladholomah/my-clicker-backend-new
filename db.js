import { createPool } from '@vercel/postgres';
import dotenv from 'dotenv';

dotenv.config();

console.log('Initializing database connection pool...');

// Створюємо пул з'єднань з оптимізованими налаштуваннями для serverless
const pool = createPool({
  connectionString: process.env.POSTGRES_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 1, // Оптимальне значення для serverless
  idleTimeoutMillis: 10000, // 10 секунд
  connectionTimeoutMillis: 5000, // 5 секунд
  maxUses: 7500, // Максимальна кількість використань одного з'єднання
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000
});

// Обробники подій пула
pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  // Спроба відновити з'єднання
  setTimeout(() => {
    console.log('Attempting to recover pool...');
    pool.connect().then(client => client.release());
  }, 5000);
});

pool.on('connect', () => {
  console.log('New database connection established');
});

pool.on('acquire', () => {
  console.log('Connection acquired from pool');
});

pool.on('remove', () => {
  console.log('Connection removed from pool');
});

// Функція перевірки з'єднання
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
      try {
        await client.release();
      } catch (releaseErr) {
        console.error('Error releasing client:', releaseErr);
      }
    }
  }
}

// Функція ініціалізації бази даних
export async function initializeDatabase() {
  let client;
  try {
    client = await pool.connect();
    console.log('Connected to database for initialization');

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
        referrals BIGINT[] DEFAULT ARRAY[]::BIGINT[],
        referred_by BIGINT,
        avatar VARCHAR(255),
        has_unclaimed_rewards BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        last_updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
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

      CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
      CREATE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code);
      CREATE INDEX IF NOT EXISTS idx_referral_rewards_referrer ON referral_rewards(referrer_id);
    `);

    console.log('Database initialized successfully');
  } catch (err) {
    console.error('Error initializing database:', err);
    throw err;
  } finally {
    if (client) {
      try {
        await client.release();
        console.log('Database initialization client released');
      } catch (releaseErr) {
        console.error('Error releasing initialization client:', releaseErr);
      }
    }
  }
}

// Покращена функція очистки при завершенні
const cleanupOnExit = async () => {
  console.log('Starting database cleanup...');
  try {
    await pool.end().catch(err => {
      console.error('Error during pool ending:', err);
    });
    console.log('Database pool closed successfully');
  } catch (err) {
    console.error('Final error closing pool:', err);
  }
};

// Обробники завершення процесу
process.once('SIGTERM', async () => {
  console.log('SIGTERM received');
  await cleanupOnExit();
  process.exit(0);
});

process.once('SIGINT', async () => {
  console.log('SIGINT received');
  await cleanupOnExit();
  process.exit(0);
});

// Обробник необроблених помилок
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  cleanupOnExit().then(() => {
    process.exit(1);
  });
});

// Експортуємо пул для використання в інших модулях
export { pool };

// Додаткова функція для отримання клієнта з автоматичним звільненням
export async function withClient(callback) {
  let client;
  try {
    client = await pool.connect();
    return await callback(client);
  } finally {
    if (client) {
      try {
        await client.release();
      } catch (releaseErr) {
        console.error('Error releasing client in withClient:', releaseErr);
      }
    }
  }
}