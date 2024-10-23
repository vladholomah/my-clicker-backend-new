import { createPool } from '@vercel/postgres';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.POSTGRES_URL) {
  console.error('POSTGRES_URL is not defined');
  process.exit(1);
}

const pool = createPool({
  connectionString: process.env.POSTGRES_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 5, // зменшуємо максимальну кількість з'єднань
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  maxUses: 7500,
});

// Додаємо обробники подій
pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

pool.on('connect', () => {
  console.log('New database connection established');
});

// Функція для перевірки з'єднання
const testConnection = async () => {
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
      } catch (releaseError) {
        console.error('Error releasing client:', releaseError);
      }
    }
  }
};

// Функція для ініціалізації користувача
const initializeUser = async (telegramId, firstName, lastName, username) => {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // Перевіряємо чи існує користувач
    const existingUser = await client.query(
      'SELECT * FROM users WHERE telegram_id = $1',
      [telegramId]
    );

    if (existingUser.rows.length === 0) {
      // Створюємо нового користувача
      const result = await client.query(`
        INSERT INTO users (
          telegram_id, 
          first_name, 
          last_name, 
          username, 
          coins, 
          total_coins, 
          level,
          referrals
        ) VALUES ($1, $2, $3, $4, 0, 0, 'Silver', ARRAY[]::bigint[]) 
        RETURNING *
      `, [telegramId, firstName, lastName, username]);

      await client.query('COMMIT');
      return result.rows[0];
    }

    await client.query('COMMIT');
    return existingUser.rows[0];
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('Error in initializeUser:', err);
    throw err;
  } finally {
    if (client) {
      try {
        await client.release();
      } catch (releaseError) {
        console.error('Error releasing client:', releaseError);
      }
    }
  }
};

// Правильне закриття з'єднань при завершенні роботи
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

export {
  pool,
  testConnection,
  initializeUser
};