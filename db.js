import { createPool } from '@vercel/postgres';
import dotenv from 'dotenv';

dotenv.config();

let pool;

function getPool() {
    if (!pool) {
        pool = createPool({
            connectionString: process.env.POSTGRES_URL,
            ssl: {
                rejectUnauthorized: false
            },
            max: 1, // Зменшуємо максимальну кількість з'єднань
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 5000,
            keepAlive: true,
            keepAliveInitialDelayMillis: 10000
        });

        pool.on('error', (err) => {
            console.error('Unexpected error on idle client', err);
            // Не завершуємо процес при помилці
        });

        pool.on('connect', () => {
            console.log('Connected to the database');
        });
    }
    return pool;
}

// Функція для отримання з'єднання з повторними спробами
async function getConnection(retries = 3, delay = 1000) {
    let lastError;

    for (let i = 0; i < retries; i++) {
        try {
            const client = await getPool().connect();
            return client;
        } catch (error) {
            console.error(`Failed to get connection, attempt ${i + 1} of ${retries}`, error);
            lastError = error;
            if (i < retries - 1) {
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    throw lastError;
}

// Функція для виконання запиту з повторними спробами
async function executeQuery(query, params = [], retries = 3) {
    let client;
    try {
        client = await getConnection(retries);
        const result = await client.query(query, params);
        return result;
    } finally {
        if (client) {
            try {
                await client.release();
            } catch (releaseError) {
                console.error('Error releasing client:', releaseError);
            }
        }
    }
}

async function testConnection() {
    try {
        const result = await executeQuery('SELECT NOW()');
        console.log('Database connection test successful:', result.rows[0]);
        return true;
    } catch (err) {
        console.error('Error testing database connection:', err);
        return false;
    }
}

async function initializeDatabase() {
    try {
        await executeQuery(`
            CREATE TABLE IF NOT EXISTS users (
                telegram_id BIGINT PRIMARY KEY,
                first_name VARCHAR(255) DEFAULT 'User' NOT NULL,
                last_name VARCHAR(255),
                username VARCHAR(255),
                referral_code VARCHAR(10) UNIQUE,
                coins INTEGER DEFAULT 0,
                total_coins INTEGER DEFAULT 0,
                level VARCHAR(50) DEFAULT 'Новачок',
                referrals BIGINT[] DEFAULT ARRAY[]::BIGINT[],
                referred_by BIGINT,
                avatar VARCHAR(255)
            )
        `);
        console.log('Database initialized successfully');
        return true;
    } catch (err) {
        console.error('Error initializing database:', err);
        return false;
    }
}

// Функція для коректного закриття пулу
async function closePool() {
    if (pool) {
        try {
            await pool.end();
            pool = null;
            console.log('Database pool closed successfully');
        } catch (error) {
            console.error('Error closing database pool:', error);
        }
    }
}

// Обробка завершення роботи програми
process.once('SIGTERM', async () => {
    console.log('Received SIGTERM');
    await closePool();
});

process.once('SIGINT', async () => {
    console.log('Received SIGINT');
    await closePool();
});

// Експортуємо всі функції одним блоком
export {
    getPool,
    getConnection,
    executeQuery,
    testConnection,
    initializeDatabase,
    closePool
};