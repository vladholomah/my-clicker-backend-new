import TelegramBot from 'node-telegram-bot-api';
import pkg from 'pg';
const { Pool } = pkg;
import { neon, neonConfig } from '@neondatabase/serverless';
import dotenv from 'dotenv';

dotenv.config();

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });

neonConfig.fetchConnectionCache = true;

const sql = neon(process.env.POSTGRES_URL);
const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
  ssl: {
    rejectUnauthorized: false,
  },
  max: 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

const generateReferralCode = () => {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
};

const addReferralBonus = async (referrerId, newUserId, bonusAmount) => {
  console.log(`Додавання реферального бонусу: referrerId=${referrerId}, newUserId=${newUserId}, bonusAmount=${bonusAmount}`);

  try {
    await sql.transaction(async (tx) => {
      const referrer = await tx`SELECT * FROM users WHERE telegram_id = ${referrerId}`;
      const newUser = await tx`SELECT * FROM users WHERE telegram_id = ${newUserId}`;

      if (referrer.length === 0 || newUser.length === 0) {
        throw new Error('Referrer or new user not found');
      }

      await tx`
        UPDATE users 
        SET referrals = array_append(referrals, ${newUserId}),
            coins = coins + ${bonusAmount},
            total_coins = total_coins + ${bonusAmount}
        WHERE telegram_id = ${referrerId}
      `;

      await tx`
        UPDATE users
        SET coins = coins + ${bonusAmount},
            total_coins = total_coins + ${bonusAmount},
            referred_by = ${referrerId}
        WHERE telegram_id = ${newUserId}
      `;
    });

    console.log('Реферальний бонус успішно додано');
  } catch (error) {
    console.error('Помилка при додаванні реферального бонусу:', error);
    throw error;
  }
};

const getOrCreateUser = async (userId, firstName, lastName, username) => {
  console.log(`Спроба отримати або створити користувача: ${userId}`);
  try {
    let user = await sql`SELECT * FROM users WHERE telegram_id = ${userId}`;
    if (user.length === 0) {
      console.log('Користувача не знайдено, створюємо нового');
      const referralCode = generateReferralCode();
      const newUser = await sql`
        INSERT INTO users (telegram_id, first_name, last_name, username, coins, total_coins, referral_code, referrals, referred_by, avatar, level)
        VALUES (${userId}, ${firstName || 'Невідомий'}, ${lastName || ''}, ${username || ''}, 0, 0, ${referralCode}, ARRAY[]::text[], NULL, NULL, 'Новачок')
        RETURNING *
      `;
      console.log('Новий користувач створений:', newUser[0]);
      return newUser[0];
    }
    console.log('Користувача знайдено:', user[0]);
    return user[0];
  } catch (error) {
    console.error('Помилка при отриманні або створенні користувача:', error);
    throw error;
  }
};

bot.onText(/\/start (.+)?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const referralCode = match[1];
  console.log(`Отримано команду /start від користувача ${userId}, referralCode: ${referralCode}`);

  try {
    const user = await getOrCreateUser(userId.toString(), msg.from.first_name, msg.from.last_name, msg.from.username);

    if (referralCode && user.referred_by === null) {
      const referrer = await sql`SELECT * FROM users WHERE referral_code = ${referralCode}`;
      if (referrer.length > 0 && referrer[0].telegram_id !== userId.toString()) {
        await addReferralBonus(referrer[0].telegram_id, userId.toString(), 5000);
        await bot.sendMessage(chatId, 'Вітаємо! Ви отримали реферальний бонус!');
      }
    }

    const keyboard = {
      inline_keyboard: [
        [{ text: 'Play Now', web_app: { url: process.env.FRONTEND_URL } }]
      ]
    };

    await bot.sendMessage(chatId, 'Ласкаво просимо! Натисніть кнопку "Play Now", щоб почати гру.', { reply_markup: keyboard });
  } catch (error) {
    console.error('Помилка при обробці команди /start:', error);
    await bot.sendMessage(chatId, 'Сталася помилка. Будь ласка, спробуйте пізніше.');
  }
});

bot.on('text', async (msg) => {
  if (msg.text === 'Запросити друзів') {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    try {
      const user = await sql`SELECT referral_code FROM users WHERE telegram_id = ${userId}`;
      if (user.length > 0) {
        const referralLink = `https://t.me/${process.env.BOT_USERNAME}?start=${user[0].referral_code}`;
        await bot.sendMessage(chatId, `Запросіть друзів за цим посиланням і отримайте бонус:\n${referralLink}`);
      } else {
        await bot.sendMessage(chatId, 'Помилка: користувача не знайдено.');
      }
    } catch (error) {
      console.error('Помилка при отриманні реферального коду:', error);
      await bot.sendMessage(chatId, 'Сталася помилка. Будь ласка, спробуйте пізніше.');
    }
  }
});

export default bot;