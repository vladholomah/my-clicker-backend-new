import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { pool, testConnection, initializeDatabase, isDatabaseReady } from './db.js';
import bot from './bot.js';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { initializeUser, processReferral, getUserData, updateUserCoins } from './userManagement.js';

dotenv.config();

console.log('Запуск сервера...');
console.log('Змінні оточення:');
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('POSTGRES_URL (перші 20 символів):', process.env.POSTGRES_URL.substring(0, 20) + '...');
console.log('BOT_TOKEN:', process.env.BOT_TOKEN ? 'Встановлено' : 'Не встановлено');
console.log('FRONTEND_URL:', process.env.FRONTEND_URL);
console.log('BOT_USERNAME:', process.env.BOT_USERNAME);

// Функція для warm-up сервера
async function warmupServer() {
  try {
    console.log('Початок warm-up серверу...');

    // Чекаємо на ініціалізацію бази даних
    await new Promise((resolve) => {
      const checkDb = async () => {
        if (isDatabaseReady()) {
          console.log('База даних готова');
          resolve();
        } else {
          console.log('Очікування готовності бази даних...');
          setTimeout(checkDb, 100);
        }
      };
      checkDb();
    });

    // Перевіряємо з'єднання з базою даних
    const dbConnection = await testConnection();
    if (!dbConnection) {
      throw new Error('Не вдалося встановити з\'єднання з базою даних');
    }

    // Чекаємо на готовність бота
    await new Promise((resolve) => {
      const checkBot = async () => {
        try {
          const botInfo = await bot.getMe();
          console.log('Бот готовий:', botInfo.username);
          resolve();
        } catch (error) {
          console.log('Очікування готовності бота...');
          setTimeout(checkBot, 100);
        }
      };
      checkBot();
    });

    console.log('Warm-up завершено успішно');
    return true;
  } catch (error) {
    console.error('Помилка при warm-up:', error);
    return false;
  }
}

const app = express();

// Налаштування довіри до проксі
app.set('trust proxy', 1);
app.enable('trust proxy');
console.log('Налаштування trust proxy:', app.get('trust proxy'));

// Налаштування безпеки
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", process.env.FRONTEND_URL],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: false
}));

// Налаштування CORS
app.use(cors({
  origin: process.env.FRONTEND_URL,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Налаштування rate limiter
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  trustProxy: true,
  keyGenerator: (req) => req.ip,
  handler: (req, res) => {
    console.log(`Rate limit перевищено для IP: ${req.ip}`);
    res.status(429).json({
      error: 'Забагато запитів, спробуйте пізніше'
    });
  }
});

app.use(limiter);

// Логування запитів
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url} - ${res.statusCode} - ${duration}ms`);
  });

  console.log('IP:', req.ip);
  console.log('X-Forwarded-For:', req.headers['x-forwarded-for']);
  console.log('Headers:', JSON.stringify(req.headers));
  console.log('Body:', JSON.stringify(req.body));
  next();
});

// Перевірка здоров'я сервера
app.get('/health', async (req, res) => {
  const dbStatus = isDatabaseReady();
  const botStatus = await bot.getMe().catch(() => null);

  res.json({
    status: dbStatus && botStatus ? 'ok' : 'initializing',
    timestamp: new Date().toISOString(),
    database: dbStatus ? 'connected' : 'disconnected',
    bot: botStatus ? 'ready' : 'initializing',
    environment: process.env.NODE_ENV
  });
});

// Webhook для бота з підтримкою warm-up
app.post(`/bot${process.env.BOT_TOKEN}`, async (req, res) => {
  try {
    console.log('Webhook: отримано оновлення від Telegram');
    console.log('Тіло запиту:', JSON.stringify(req.body));

    if (!isDatabaseReady()) {
      console.log('Сервер ще не готовий, виконується warm-up...');
      await warmupServer();
    }

    if (!isDatabaseReady()) {
      throw new Error('Сервер не готовий після warm-up');
    }

    await bot.processUpdate(req.body);
    console.log('Webhook: оновлення успішно оброблено');
    res.sendStatus(200);
  } catch (error) {
    console.error('Помилка обробки webhook:', error);
    // Відправляємо 503 замість 500, щоб Telegram повторив запит
    res.status(503).json({
      error: 'Сервер готується до роботи, спробуйте за мить',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// API ендпоінти з перевіркою готовності
app.post('/api/initUser', async (req, res) => {
  if (!isDatabaseReady()) {
    return res.status(503).json({ error: 'Сервер ініціалізується' });
  }

  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ error: 'Потрібен userId' });
  }

  try {
    const userData = await initializeUser(userId);
    res.json(userData);
  } catch (error) {
    console.error('Помилка ініціалізації користувача:', error);
    res.status(500).json({
      error: 'Внутрішня помилка сервера',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

app.get('/api/getUserData', async (req, res) => {
  if (!isDatabaseReady()) {
    return res.status(503).json({ error: 'Сервер ініціалізується' });
  }

  const { userId } = req.query;
  if (!userId) {
    return res.status(400).json({ error: 'Потрібен userId' });
  }

  try {
    const userData = await getUserData(userId);
    res.json(userData);
  } catch (error) {
    console.error('Помилка отримання даних користувача:', error);
    res.status(500).json({
      error: 'Внутрішня помилка сервера',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

app.post('/api/updateUserCoins', async (req, res) => {
  if (!isDatabaseReady()) {
    return res.status(503).json({ error: 'Сервер ініціалізується' });
  }

  const { userId, coinsToAdd } = req.body;
  if (!userId || coinsToAdd === undefined) {
    return res.status(400).json({ error: 'Потрібні userId та coinsToAdd' });
  }

  try {
    const result = await updateUserCoins(userId, coinsToAdd);
    res.json(result);
  } catch (error) {
    console.error('Помилка оновлення монет користувача:', error);
    res.status(500).json({
      error: 'Внутрішня помилка сервера',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

app.post('/api/processReferral', async (req, res) => {
  if (!isDatabaseReady()) {
    return res.status(503).json({ error: 'Сервер ініціалізується' });
  }

  const { referralCode, userId } = req.body;
  if (!referralCode || !userId) {
    return res.status(400).json({ error: 'Потрібні referralCode та userId' });
  }

  try {
    const result = await processReferral(referralCode, userId);
    res.json(result);
  } catch (error) {
    console.error('Помилка обробки реферала:', error);
    res.status(500).json({
      error: 'Внутрішня помилка сервера',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Головна сторінка
app.get('/', (req, res) => {
  res.send('TWASH COIN Bot Server працює!');
});

// Обробка помилок
app.use((err, req, res, next) => {
  console.error('Необроблена помилка:', err.stack);
  res.status(500).json({
    error: 'Щось пішло не так!',
    details: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Обробка необроблених відхилень промісів
process.on('unhandledRejection', (reason, promise) => {
  console.error('Необроблена відмова промісу:', promise, 'причина:', reason);
});

// Запуск сервера з warm-up
const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`Сервер запущено на порту ${PORT}`);

  try {
    await initializeDatabase();
    console.log('База даних успішно ініціалізована');

    // Виконуємо warm-up при старті
    const warmupResult = await warmupServer();
    if (warmupResult) {
      console.log('Сервер повністю готовий до роботи');
    } else {
      console.log('Сервер запущено, але деякі компоненти можуть бути не готові');
    }
  } catch (err) {
    console.error('Помилка при ініціалізації:', err);
  }
});

export default app;