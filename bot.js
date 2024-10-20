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

  console.log('Підготовка до відправки повідомлення з кнопкою "Play Game"');
  console.log('FRONTEND_URL:', process.env.FRONTEND_URL);
  console.log('Keyboard:', JSON.stringify(keyboard));

  try {
    const sentMessage = await bot.sendMessage(chatId, 'Ласкаво просимо до TWASH COIN! Натисніть кнопку нижче, щоб почати гру:', {
      reply_markup: keyboard
    });
    console.log('Повідомлення з кнопкою "Play Game" відправлено:', sentMessage);
  } catch (sendError) {
    console.error('Помилка при відправці повідомлення:', sendError);
    throw sendError;
  }

  // Перевірка на наявність реферального коду
  const referralCode = msg.text.split(' ')[1];
  if (referralCode) {
    console.log(`Отримано реферальний код: ${referralCode}`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: user } = await client.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
      if (user.length > 0 && user[0].referred_by === null) {
        await processReferral(client, referralCode, userId);
      } else {
        console.log('Користувач вже був запрошений раніше або не існує');
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Помилка при обробці реферального коду:', error);
    } finally {
      client.release();
    }
  }
}

async function processReferral(client, referralCode, newUserId) {
  const { rows: referrer } = await client.query('SELECT * FROM users WHERE referral_code = $1', [referralCode]);
  if (referrer.length > 0 && referrer[0].telegram_id !== newUserId) {
    await addReferralBonus(client, referrer[0].telegram_id, newUserId, 5000);
    console.log('Реферальний бонус додано');
    await bot.sendMessage(newUserId, 'Вітаємо! Ви отримали реферальний бонус!');
  }
}

async function addReferralBonus(client, referrerId, newUserId, bonusAmount) {
  console.log(`Додавання реферального бонусу: referrerId=${referrerId}, newUserId=${newUserId}, bonusAmount=${bonusAmount}`);

  try {
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

    console.log('Реферальний бонус успішно додано');
  } catch (error) {
    console.error('Помилка при додаванні реферального бонусу:', error);
    throw error;
  }
}

bot.getMe().then((botInfo) => {
  console.log("Бот успішно запущено. Інформація про бота:", botInfo);
}).catch((error) => {
  console.error("Помилка при отриманні інформації про бота:", error);
});

export default bot;