import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import { sql } from "@vercel/postgres";

dotenv.config();

console.log('FRONTEND_URL при запуску:', process.env.FRONTEND_URL);
console.log('DB URL (перші 20 символів):', process.env.POSTGRES_URL.substring(0, 20) + '...');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });

bot.getMe().then((botInfo) => {
  console.log("Інформація про бота:", botInfo);
}).catch((error) => {
  console.error("Помилка отримання інформації про бота:", error);
});

const generateReferralCode = () => {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
};

const getOrCreateUser = async (userId, firstName, lastName, username) => {
  console.log('Отриманий userId:', userId);
  console.log('Тип userId:', typeof userId);

  try {
    // Спробуємо знайти користувача
    const { rows } = await sql`SELECT * FROM users WHERE telegram_id = ${userId}`;
    console.log('Результат пошуку користувача:', rows);

    if (rows.length === 0) {
      console.log('Користувача не знайдено, створюємо нового');
      const referralCode = generateReferralCode();
      const insertQuery = sql`
        INSERT INTO users (telegram_id, first_name, last_name, username, coins, total_coins, referral_code, referrals, referred_by, avatar, level)
        VALUES (${userId}, ${firstName || 'Невідомий'}, ${lastName || ''}, ${username || ''}, 0, 0, ${referralCode}, ARRAY[]::bigint[], NULL, NULL, 'Новачок')
        RETURNING *
      `;
      console.log('SQL запит для створення користувача:', insertQuery);
      const { rows: newUserRows } = await insertQuery;
      console.log('Новий користувач створений:', JSON.stringify(newUserRows[0]));
      return newUserRows[0];
    } else {
      console.log('Користувача знайдено в базі даних:', JSON.stringify(rows[0]));
      return rows[0];
    }
  } catch (error) {
    console.error('Помилка при отриманні або створенні користувача:', error);
    throw error;
  }
};

bot.onText(/\/start(.*)/, async (msg, match) => {
  try {
    console.log('Отримано команду /start:', JSON.stringify(msg));
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const referralCode = match[1] ? match[1].trim() : null;
    console.log(`Команда /start від користувача ${userId}, referralCode: ${referralCode}`);

    console.log('Початок обробки команди /start');
    const user = await getOrCreateUser(userId, msg.from.first_name, msg.from.last_name, msg.from.username);
    console.log('Користувач отриманий або створений:', JSON.stringify(user));

    if (referralCode && user.referred_by === null) {
      console.log(`Обробка реферального коду: ${referralCode}`);
      const { rows: referrerRows } = await sql`SELECT * FROM users WHERE referral_code = ${referralCode}`;
      if (referrerRows.length > 0 && referrerRows[0].telegram_id !== userId) {
        await sql`
          UPDATE users 
          SET referrals = array_append(referrals, ${userId}),
              coins = coins + 5000,
              total_coins = total_coins + 5000
          WHERE telegram_id = ${referrerRows[0].telegram_id}
        `;
        await sql`
          UPDATE users
          SET coins = coins + 5000,
              total_coins = total_coins + 5000,
              referred_by = ${referrerRows[0].telegram_id}
          WHERE telegram_id = ${userId}
        `;
        console.log('Реферальний бонус додано');
        await bot.sendMessage(chatId, 'Вітаємо! Ви отримали реферальний бонус!');
      }
    }

    const keyboard = {
      inline_keyboard: [
        [{ text: 'Грати', web_app: { url: process.env.FRONTEND_URL } }]
      ]
    };

    console.log('FRONTEND_URL:', process.env.FRONTEND_URL);
    console.log('Підготовка клавіатури для повідомлення:', JSON.stringify(keyboard));
    console.log('Підготовка повідомлення з кнопкою "Грати"');
    const sentMessage = await bot.sendMessage(chatId, 'Ласкаво просимо! Натисніть кнопку "Грати", щоб почати гру.', { reply_markup: keyboard });
    console.log('Повідомлення з кнопкою "Грати" успішно відправлено:', JSON.stringify(sentMessage));
  } catch (error) {
    console.error('Глобальна помилка при обробці команди /start:', error);
  }
});

export default bot;