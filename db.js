import { createPool } from '@vercel/postgres';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.POSTGRES_URL) {
  console.error('POSTGRES_URL is not defined in environment variables');
  process.exit(1);
}

// Створення пулу з'єднань з розширеними налаштуваннями
export const pool = createPool({
  connectionString: process.env.POSTGRES_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 20, // максимальна кількість з'єднань в пулі
  idleTimeoutMillis: 30000, // час простою з'єднання перед закриттям
  connectionTimeoutMillis: 2000, // час очікування нового з'єднання
  maxUses: 7500, // максимальна кількість використань одного з'єднання
  keepAlive: true, // підтримувати з'єднання активним
  allowExitOnIdle: false // не закривати з'єднання при простої
});

// Обробка подій пулу
pool.on('connect', (client) => {
  console.log('New client connected to the database');

  // Налаштування клієнта при підключенні
  client.query('SET timezone = "UTC";', (err) => {
    if (err) {
      console.error('Error setting timezone:', err);
    }
  });
});

pool.on('error', (err, client) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

pool.on('remove', () => {
  console.log('Client removed from pool');
});

// Функція для тестування підключення
export async function testConnection() {
  let client;
  try {
    client = await pool.connect();
    console.log('Testing database connection...');

    // Перевірка з'єднання
    const result = await client.query('SELECT NOW() as current_time, version() as pg_version');
    console.log('Database connection test successful:', {
      currentTime: result.rows[0].current_time,
      pgVersion: result.rows[0].pg_version
    });

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

// Функція для ініціалізації бази даних
export async function initializeDatabase() {
  let client;
  try {
    client = await pool.connect();
    console.log('Initializing database...');

    // Створення таблиці користувачів
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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Створення індексів для оптимізації запитів
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code);
      CREATE INDEX IF NOT EXISTS idx_users_level ON users(level);
      CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by);
    `);

    // Створення тригера для автоматичного оновлення updated_at
    await client.query(`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $$ language 'plpgsql';
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS update_users_updated_at ON users;
      CREATE TRIGGER update_users_updated_at
        BEFORE UPDATE ON users
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column();
    `);

    console.log('Database initialized successfully');
    return true;
  } catch (err) {
    console.error('Error initializing database:', err);
    throw err;
  } finally {
    if (client) {
      client.release();
      console.log('Database initialization client released');
    }
  }
}

// Функція для очищення невикористаних з'єднань
async function cleanupConnections() {
  try {
    const clients = await pool.totalCount;
    const idle = await pool.idleCount;
    const waiting = await pool.waitingCount;

    console.log('Pool status:', {
      totalConnections: clients,
      idleConnections: idle,
      waitingRequests: waiting
    });

    if (idle > 5) { // Якщо більше 5 неактивних з'єднань
      console.log('Cleaning up idle connections...');
      await pool.clean();
    }
  } catch (err) {
    console.error('Error during connection cleanup:', err);
  }
}

// Встановлюємо періодичне очищення з'єднань
setInterval(cleanupConnections, 60000); // Кожну хвилину

// Обробка завершення роботи програми
process.on('exit', async () => {
  console.log('Closing database pool...');
  try {
    await pool.end();
    console.log('Database pool closed successfully');
  } catch (err) {
    console.error('Error closing database pool:', err);
  }
});

// Обробка SIGINT (Ctrl+C)
process.on('SIGINT', async () => {
  console.log('Received SIGINT. Closing database pool...');
  try {
    await pool.end();
    console.log('Database pool closed successfully');
    process.exit(0);
  } catch (err) {
    console.error('Error closing database pool:', err);
    process.exit(1);
  }
});

// Обробка необроблених помилок
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

export default pool;