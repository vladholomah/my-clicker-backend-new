import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import { pool } from './db.js';

dotenv.config();

console.log('FRONTEND_URL при запуску:', process.env.FRONTEND_URL);
console.log('POSTGRES_URL (перші 20 символів):', process.env.POSTGRES_URL.substring(0, 20) + '...');
console.log('BOT_TOKEN (перші 10 символів):', process.env.BOT_TOKEN.substring(0, 10) + '...');

const bot = new TelegramBot(process.env.BOT_TOKEN, {
  webHook: {
    port: process.env.PORT
  }
});

bot.on('text', async (msg) => {
  console.log('Отримано повідомлення:', msg.text);
  if (msg.text.startsWith('/start')) {
    console.log('Обробка команди /start');
    await handleStart(msg);
  }
});

bot.on('polling_error', (error) => {
  console.error('Помилка при опитуванні Telegram API:', error);
});

async function handleStart(msg) {
  console.log('Початок обробки команди /start');
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const keyboard = {
    inline_keyboard: [
      [{ text: 'Play Game', web_app: { url: `${process.env.FRONTEND_URL}?userId=${userId}` } }]
    ]
  };

  try {
    console.log('Підготовка до відправки повідомлення з кнопкою "Play Game"');
    console.log('FRONTEND_URL:', process.env.FRONTEND_URL);
    console.log('Keyboard:', JSON.stringify(keyboard));

    const sentMessage = await bot.sendMessage(chatId, 'Ласкаво просимо до TWASH COIN! Натисніть кнопку нижче, щоб почати гру:', {
      reply_markup: keyboard
    });
    console.log('Повідомлення успішно відправлено:', sentMessage);

    // Ініціалізація користувача після відправки повідомлення
    try {
       await initializeUser(userId, msg.from.first_name, msg.from.last_name, msg.from.username);
      console.log('Користувач успішно ініціалізований');
    } catch (dbError) {
      console.error('Помилка при ініціалізації користувача:', dbError);
    }
  } catch (error) {
    console.error('Помилка при обробці команди /start:', error);
    console.log('Завершення обробки команди /start');
    try {
      await bot.sendMessage(chatId, 'Вибачте, сталася помилка. Спробуйте ще раз пізніше або зверніться до підтримки.');
    } catch (sendError) {
      console.error('Помилка при відправці повідомлення про помилку:', sendError);
    }
  }
}

async function initializeUser(userId, firstName, lastName, username) {
  let client;
  try {
    client = await pool.connect();
     console.log('Підключено до бази даних');
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
    if (rows.length === 0) {
      const referralCode = generateReferralCode();
      await client.query(
        'INSERT INTO users (telegram_id, first_name, last_name, username, coins, total_coins, referral_code, referrals, level) VALUES ($1, $2, $3, $4, 0, 0, $5, ARRAY[]::bigint[], $6)',
        [userId, firstName || 'Невідомий', lastName || '', username || '', referralCode, 'Новачок']
      );
      console.log('Новий користувач створений:', userId);
    } else {
      console.log('Користувач вже існує:', userId);
    }
    await client.query('COMMIT');
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    console.error('Помилка при ініціалізації користувача:', error);
    throw error;
  } finally {
    if (client) client.release();
  }
}

function generateReferralCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

bot.getMe().then((botInfo) => {
  console.log("Бот успішно запущено. Інформація про бота:", botInfo);
}).catch((error) => {
  console.error("Помилка при отриманні інформації про бота:", error);
});

export default bot;