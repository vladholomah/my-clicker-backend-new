import { createPool } from '@vercel/postgres';
import dotenv from 'dotenv';

dotenv.config();

const poolConfig = {
  connectionString: process.env.POSTGRES_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 5, // Зменшуємо максимальну кількість з'єднань
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000, // Збільшуємо timeout для з'єднання
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000 // Додаємо початкову затримку для keepAlive
};

export const pool = createPool(poolConfig);

// Обробник помилок пулу
pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

pool.on('connect', () => {
  console.log('Connected to the database');
});

// Функція для отримання з'єднання з пулу з повторними спробами
export async function getConnection(retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const client = await pool.connect();
      return client;
    } catch (error) {
      console.error(`Failed to get connection, attempt ${i + 1} of ${retries}`, error);
      if (i === retries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
}

export async function testConnection() {
  let client;
  try {
    client = await getConnection();
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
    client = await getConnection();
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id BIGINT PRIMARY KEY,
        first_name VARCHAR(255) NOT NULL DEFAULT 'User',
        last_name VARCHAR(255),
        username VARCHAR(255),
        referral_code VARCHAR(10) UNIQUE,
        coins INTEGER DEFAULT 0,
        total_coins INTEGER DEFAULT 0,
        level VARCHAR(50) DEFAULT 'Новачок',
        referrals BIGINT[] DEFAULT '{}',
        referred_by BIGINT,
        avatar VARCHAR(255)
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

// Функція для коректного закриття пулу
export async function closePool() {
  try {
    await pool.end();
    console.log('Database pool closed successfully');
  } catch (error) {
    console.error('Error closing database pool:', error);
  }
}

// Обробка завершення роботи програми
process.on('SIGTERM', async () => {
  console.log('Received SIGTERM. Closing database pool...');
  await closePool();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('Received SIGINT. Closing database pool...');
  await closePool();
  process.exit(0);
});

export default pool;