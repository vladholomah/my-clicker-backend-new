import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import { createPool } from '@vercel/postgres';

dotenv.config();

console.log('FRONTEND_URL при запуску:', process.env.FRONTEND_URL);
console.log('POSTGRES_URL (перші 20 символів):', process.env.POSTGRES_URL.substring(0, 20) + '...');
console.log('BOT_TOKEN (перші 10 символів):', process.env.BOT_TOKEN.substring(0, 10) + '...');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });

const pool = createPool({
  connectionString: process.env.POSTGRES_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 1,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 10000,
  allowExitOnIdle: true
});

bot.getMe().then((botInfo) => {
  console.log("Інформація про бота:", botInfo);
}).catch((error) => {
  console.error("Помилка отримання інформації про бота:", error);
});

async function connectWithRetry(maxRetries = 10, delay = 10000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const client = await pool.connect();
      const result = await client.query('SELECT NOW()');
      console.log('Підключення до бази даних успішне:', result.rows[0]);
      client.release();
      return;
    } catch (error) {
      console.error(`Спроба ${i + 1} не вдалася. Повторна спроба через ${delay / 1000} секунд...`);
      console.error('Деталі помилки:', error);
      if (i === maxRetries - 1) {
        console.error('Помилка підключення до бази даних:', error);
      }
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error('Не вдалося підключитися до бази даних після кількох спроб');
}

connectWithRetry().catch(console.error);

const generateReferralCode = () => {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
};

const addReferralBonus = async (referrerId, newUserId, bonusAmount) => {
  console.log(`Додавання реферального бонусу: referrerId=${referrerId}, newUserId=${newUserId}, bonusAmount=${bonusAmount}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: referrer } = await client.query('SELECT * FROM users WHERE telegram_id = $1', [referrerId]);
    const { rows: newUser } = await client.query('SELECT * FROM users WHERE telegram_id = $1', [newUserId]);

    if (referrer.length === 0 || newUser.length === 0) {
      throw new Error('Referrer or new user not found');
    }

    await client.query(`
      UPDATE users 
      SET referrals = array_append(referrals, $1),
          coins = coins + $2,
          total_coins = total_coins + $2
      WHERE telegram_id = $3
    `, [newUserId, bonusAmount, referrerId]);

    await client.query(`
      UPDATE users
      SET coins = coins + $1,
          total_coins = total_coins + $1,
          referred_by = $2
      WHERE telegram_id = $3
    `, [bonusAmount, referrerId, newUserId]);

    await client.query('COMMIT');
    console.log('Реферальний бонус успішно додано');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Помилка при додаванні реферального бонусу:', error);
    throw error;
  } finally {
    client.release();
  }
};

const getOrCreateUser = async (userId, firstName, lastName, username) => {
  console.log(`Спроба отримати або створити користувача: ${userId}`);
  console.log('Тип userId:', typeof userId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
    console.log('Результат SQL-запиту SELECT:', JSON.stringify(rows));
    if (rows.length === 0) {
      console.log('Користувача не знайдено, створюємо нового');
      const referralCode = generateReferralCode();
      const { rows: newUser } = await client.query(
        'INSERT INTO users (telegram_id, first_name, last_name, username, coins, total_coins, referral_code, referrals, referred_by, avatar, level) VALUES ($1, $2, $3, $4, 0, 0, $5, ARRAY[]::bigint[], NULL, NULL, $6) RETURNING *',
        [userId, firstName || 'Невідомий', lastName || '', username || '', referralCode, 'Новачок']
      );
      console.log('Новий користувач створений:', JSON.stringify(newUser[0]));
      await client.query('COMMIT');
      return newUser[0];
    } else {
      console.log('Користувача знайдено в базі даних:', JSON.stringify(rows[0]));
      await client.query('COMMIT');
      return rows[0];
    }
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Помилка при отриманні або створенні користувача:', error);
    throw error;
  } finally {
    client.release();
  }
};

bot.onText(/\/start(.*)/, async (msg, match) => {
  console.log('Отримано команду /start:', JSON.stringify(msg));
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const referralCode = match[1] ? match[1].trim() : null;
  console.log(`Команда /start від користувача ${userId}, referralCode: ${referralCode}`);

  try {
    console.log('Початок обробки команди /start');
    let user = await getOrCreateUser(userId, msg.from.first_name, msg.from.last_name, msg.from.username);
    console.log('Користувач отриманий або створений:', JSON.stringify(user));

    if (referralCode && user.referred_by === null) {
      console.log(`Обробка реферального коду: ${referralCode}`);
      try {
        const client = await pool.connect();
        const { rows: referrer } = await client.query('SELECT * FROM users WHERE referral_code = $1', [referralCode]);
        client.release();
        if (referrer.length > 0 && referrer[0].telegram_id !== userId) {
          await addReferralBonus(referrer[0].telegram_id, userId, 5000);
          console.log('Реферальний бонус додано');
          await bot.sendMessage(chatId, 'Вітаємо! Ви отримали реферальний бонус!');
        }
      } catch (referralError) {
        console.error('Помилка при обробці реферального коду:', referralError);
      }
    }

    const keyboard = {
      inline_keyboard: [
        [{ text: 'Play Game', web_app: { url: `${process.env.FRONTEND_URL}?userId=${userId}` } }]
      ]
    };

    console.log('FRONTEND_URL:', process.env.FRONTEND_URL);
    console.log('Підготовка клавіатури для повідомлення:', JSON.stringify(keyboard));

    try {
      console.log('Спроба відправити повідомлення з кнопкою "Play Game"');
      const sentMessage = await bot.sendMessage(chatId, 'Ласкаво просимо до Holmah Coin! Натисніть кнопку нижче, щоб почати гру:', { reply_markup: keyboard });
      console.log('Повідомлення з кнопкою "Play Game" успішно відправлено:', JSON.stringify(sentMessage));
    } catch (sendError) {
      console.error('Помилка при відправці повідомлення з кнопкою "Play Game":', sendError);
    }

  } catch (error) {
    console.error('Глобальна помилка при обробці команди /start:', error);
    try {
      await bot.sendMessage(chatId, 'Сталася помилка. Будь ласка, спробуйте пізніше.');
      console.log('Повідомлення про помилку відправлено користувачу');
    } catch (sendError) {
      console.error('Не вдалося відправити повідомлення про помилку:', sendError);
    }
  }
});

export default bot;