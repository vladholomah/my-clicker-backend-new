import { createPool } from '@vercel/postgres';
import dotenv from 'dotenv';

dotenv.config();

// Оптимізовані налаштування пулу
const poolConfig = {
  connectionString: process.env.POSTGRES_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 5, // Зменшуємо максимальну кількість з'єднань для serverless середовища
  min: 0, // Мінімальна кількість з'єднань
  idleTimeoutMillis: 10000, // Час очікування перед закриттям неактивного з'єднання
  connectionTimeoutMillis: 5000, // Таймаут підключення
  maxUses: 7500, // Максимальна кількість використань одного з'єднання
  keepAlive: true,
  allowExitOnIdle: true
};

// Створення пулу з обробкою помилок
let pool;
try {
  pool = createPool(poolConfig);
  console.log('Database pool created successfully');
} catch (error) {
  console.error('Error creating database pool:', error);
  process.exit(1);
}

// Обробники подій пулу
pool.on('connect', (client) => {
  console.log('New client connected to database');

  client.on('error', (err) => {
    console.error('Database client error:', err);
  });
});

pool.on('error', (err, client) => {
  console.error('Unexpected error on idle client', err);
  if (client) {
    try {
      client.release(true);
    } catch (releaseError) {
      console.error('Error releasing client:', releaseError);
    }
  }
});

pool.on('remove', () => {
  console.log('Client removed from pool');
});

// Функція для безпечного отримання з'єднання
export async function getConnection() {
  let retries = 3;
  while (retries > 0) {
    try {
      const client = await pool.connect();
      console.log('Successfully acquired database connection');
      return client;
    } catch (error) {
      retries--;
      console.error(`Error acquiring connection. Retries left: ${retries}`, error);
      if (retries === 0) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

// Функція для безпечного виконання запиту
export async function executeQuery(query, params = []) {
  let client;
  try {
    client = await getConnection();
    const result = await client.query(query, params);
    return result;
  } catch (error) {
    console.error('Error executing query:', error);
    throw error;
  } finally {
    if (client) {
      try {
        await client.release(true);
        console.log('Database connection released');
      } catch (releaseError) {
        console.error('Error releasing client:', releaseError);
      }
    }
  }
}

// Функція для тестування підключення
export async function testConnection() {
  let client;
  try {
    client = await getConnection();
    const result = await client.query('SELECT NOW()');
    console.log('Database connection test successful:', result.rows[0]);
    return true;
  } catch (error) {
    console.error('Error testing database connection:', error);
    return false;
  } finally {
    if (client) {
      try {
        await client.release(true);
      } catch (releaseError) {
        console.error('Error releasing client:', releaseError);
      }
    }
  }
}

// Функція для ініціалізації бази даних
export async function initializeDatabase() {
  let client;
  try {
    client = await getConnection();
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id BIGINT PRIMARY KEY,
        first_name VARCHAR(255) NOT NULL DEFAULT '',
        last_name VARCHAR(255),
        username VARCHAR(255),
        referral_code VARCHAR(10) UNIQUE,
        coins INTEGER DEFAULT 0,
        total_coins INTEGER DEFAULT 0,
        level VARCHAR(50) DEFAULT 'Новачок',
        referrals BIGINT[] DEFAULT ARRAY[]::BIGINT[],
        referred_by BIGINT,
        avatar VARCHAR(255),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        last_active TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Error initializing database:', error);
    throw error;
  } finally {
    if (client) {
      try {
        await client.release(true);
      } catch (releaseError) {
        console.error('Error releasing client:', releaseError);
      }
    }
  }
}

// Функція для безпечного закриття пулу
export async function closePool() {
  try {
    console.log('Closing database pool...');
    await pool.end();
    console.log('Database pool closed successfully');
  } catch (error) {
    console.error('Error closing database pool:', error);
  }
}

// Обробка завершення процесу
process.on('exit', async () => {
  await closePool();
});

process.on('SIGINT', async () => {
  await closePool();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await closePool();
  process.exit(0);
});

// Обробка необроблених помилок
process.on('uncaughtException', async (error) => {
  console.error('Uncaught Exception:', error);
  await closePool();
  process.exit(1);
});

process.on('unhandledRejection', async (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  await closePool();
  process.exit(1);
});

export default pool;