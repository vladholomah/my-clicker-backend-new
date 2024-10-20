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

async function testConnection() {
  try {
    const client = await pool.connect();
    try {
      const result = await client.query('SELECT NOW()');
      console.log('Database connection test successful:', result.rows[0]);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Error testing database connection:', err);
  }
}

testConnection();

process.on('exit', async () => {
  console.log('Closing database pool...');
  await pool.end();
});

export default pool;