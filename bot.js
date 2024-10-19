import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import { pool } from './db.js';

dotenv.config();

console.log('FRONTEND_URL при запуску:', process.env.FRONTEND_URL);
console.log('POSTGRES_URL (перші 20 символів):', process.env.POSTGRES_URL.substring(0, 20) + '...');
console.log('BOT_TOKEN (перші 10 символів):', process.env.BOT_TOKEN.substring(0, 10) + '...');

const bot = new TelegramBot(process.env.BOT_TOKEN, {
  polling: true
});

bot.on('text', async (msg) => {
  console.log('Отримано повідомлення:', msg.text);
  if (msg.text === '/start') {
    await handleStart(msg);
  }
});

async function handleStart(msg) {
  console.log('Обробка команди /start');
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
    const user = await getOrCreateUser(userId, msg.from.first_name, msg.from.last_name, msg.from.username);
    console.log('Користувач:', user);

    const keyboard = {
      inline_keyboard: [
        [{ text: 'Play Game', web_app: { url: `${process.env.FRONTEND_URL}?userId=${userId}` } }]
      ]
    };

    await bot.sendMessage(chatId, 'Ласкаво просимо до Holmah Coin! Натисніть кнопку нижче, щоб почати гру:', {
      reply_markup: keyboard
    });
    console.log('Повідомлення з кнопкою "Play Game" відправлено');
  } catch (error) {
    console.error('Помилка при обробці команди /start:', error);
    await bot.sendMessage(chatId, 'Вибачте, сталася помилка. Спробуйте ще раз пізніше.');
  }
}

async function getOrCreateUser(userId, firstName, lastName, username) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let { rows } = await client.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
    if (rows.length === 0) {
      const referralCode = generateReferralCode();
      const { rows: newUser } = await client.query(
        'INSERT INTO users (telegram_id, first_name, last_name, username, coins, total_coins, referral_code, referrals, level) VALUES ($1, $2, $3, $4, 0, 0, $5, ARRAY[]::bigint[], $6) RETURNING *',
        [userId, firstName || 'Невідомий', lastName || '', username || '', referralCode, 'Новачок']
      );
      rows = newUser;
    }
    await client.query('COMMIT');
    return rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function generateReferralCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

async function addReferralBonus(referrerId, newUserId, bonusAmount) {
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
}

export default bot;