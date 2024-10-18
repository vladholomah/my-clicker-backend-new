import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import { neon, neonConfig } from '@neondatabase/serverless';

dotenv.config();

console.log('FRONTEND_URL при запуску:', process.env.FRONTEND_URL);

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });

bot.getMe().then((botInfo) => {
  console.log("Інформація про бота:", botInfo);
}).catch((error) => {
  console.error("Помилка отримання інформації про бота:", error);
});

neonConfig.fetchConnectionCache = true;

const sql = neon(process.env.POSTGRES_URL);

// Перевірка підключення до бази даних
const checkDatabaseConnection = async () => {
  try {
    const result = await sql`SELECT 1`;
    console.log('Успішне підключення до бази даних');
  } catch (error) {
    console.error('Помилка підключення до бази даних:', error);
  }
};

checkDatabaseConnection();

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
        SET referrals = array_append(referrals, ${newUserId}::bigint),
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
    let user = await sql`SELECT * FROM users WHERE telegram_id = ${BigInt(userId)}`;
    console.log('Результат SQL-запиту SELECT:', JSON.stringify(user));
    if (user.length === 0) {
      console.log('Користувача не знайдено, створюємо нового');
      const referralCode = generateReferralCode();
      const insertQuery = sql`
        INSERT INTO users (telegram_id, first_name, last_name, username, coins, total_coins, referral_code, referrals, referred_by, avatar, level)
        VALUES (${BigInt(userId)}, ${firstName || 'Невідомий'}, ${lastName || ''}, ${username || ''}, 0, 0, ${referralCode}, ARRAY[]::bigint[], NULL, NULL, 'Новачок')
        RETURNING *
      `;
      console.log('SQL запит для створення користувача:', insertQuery);
      const newUser = await insertQuery;
      console.log('Новий користувач створений:', JSON.stringify(newUser[0]));
      return newUser[0];
    } else {
      console.log('Користувача знайдено в базі даних:', JSON.stringify(user[0]));
    }
    return user[0];
  } catch (error) {
    console.error('Помилка при отриманні або створенні користувача:', error);
    throw error;
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
    let user;
    try {
      user = await getOrCreateUser(userId, msg.from.first_name, msg.from.last_name, msg.from.username);
      console.log('Користувач отриманий або створений:', JSON.stringify(user));
    } catch (userError) {
      console.error('Помилка при отриманні або створенні користувача:', userError);
      throw userError;
    }

    if (referralCode && user.referred_by === null) {
      console.log(`Обробка реферального коду: ${referralCode}`);
      try {
        const referrer = await sql`SELECT * FROM users WHERE referral_code = ${referralCode}`;
        if (referrer.length > 0 && referrer[0].telegram_id !== BigInt(userId)) {
          await addReferralBonus(referrer[0].telegram_id, BigInt(userId), 5000);
          console.log('Реферальний бонус додано');
          try {
            await bot.sendMessage(chatId, 'Вітаємо! Ви отримали реферальний бонус!');
            console.log('Повідомлення про реферальний бонус відправлено');
          } catch (sendError) {
            console.error('Помилка при відправці повідомлення про реферальний бонус:', sendError);
          }
        }
      } catch (referralError) {
        console.error('Помилка при обробці реферального коду:', referralError);
      }
    }

    const gameUrl = `https://t.me/${process.env.BOT_USERNAME}?start=game`;
    const keyboard = {
      inline_keyboard: [
        [{ text: 'Грати', web_app: { url: process.env.FRONTEND_URL } }]
      ]
    };

    console.log('FRONTEND_URL:', process.env.FRONTEND_URL);
    console.log('Підготовка клавіатури для повідомлення:', JSON.stringify(keyboard));
    console.log('Підготовка повідомлення з кнопкою "Грати"');
    try {
      const sentMessage = await bot.sendMessage(chatId, 'Ласкаво просимо! Натисніть кнопку "Грати", щоб почати гру.', { reply_markup: keyboard });
      console.log('Повідомлення з кнопкою "Грати" успішно відправлено:', JSON.stringify(sentMessage));
    } catch (sendError) {
      console.error('Помилка при відправці повідомлення з кнопкою "Грати":', sendError);
      throw sendError;
    }
  } catch (error) {
    console.error('Помилка при обробці команди /start:', error);
    try {
      await bot.sendMessage(chatId, 'Сталася помилка. Будь ласка, спробуйте пізніше.');
      console.log('Повідомлення про помилку відправлено користувачу');
    } catch (sendError) {
      console.error('Не вдалося відправити повідомлення про помилку:', sendError);
    }
  }
});

export default bot;