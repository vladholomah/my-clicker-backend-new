import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import { initializeUser, processReferral } from './userManagement.js';

dotenv.config();

console.log('FRONTEND_URL при запуску:', process.env.FRONTEND_URL);
console.log('POSTGRES_URL (перші 20 символів):', process.env.POSTGRES_URL.substring(0, 20) + '...');
console.log('BOT_TOKEN (перші 10 символів):', process.env.BOT_TOKEN.substring(0, 10) + '...');

const bot = new TelegramBot(process.env.BOT_TOKEN, {
  webHook: {
    port: process.env.PORT
  }
});

// Зберігаємо час останнього запиту для кожного користувача
const userLastRequest = new Map();
const COOLDOWN_TIME = 2000; // 2 секунди між командами

bot.on('text', async (msg) => {
  console.log('Отримано повідомлення:', msg.text);
  const userId = msg.from.id;

  if (msg.text.startsWith('/start')) {
    const now = Date.now();
    const lastRequest = userLastRequest.get(userId) || 0;

    // Перевіряємо чи не занадто часто користувач надсилає команди
    if (now - lastRequest < COOLDOWN_TIME) {
      console.log('Занадто часті запити від користувача:', userId);
      return;
    }

    userLastRequest.set(userId, now);
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

    await bot.sendMessage(chatId, 'Ласкаво просимо до TWASH COIN! Натисніть кнопку нижче, щоб почати гру:', {
      reply_markup: keyboard
    });

    try {
      let avatarUrl = null;
      const photos = await bot.getUserProfilePhotos(userId, { limit: 1 });
      if (photos && photos.total_count > 0) {
        avatarUrl = await bot.getFileLink(photos.photos[0][0].file_id);
      }

      // Спроба ініціалізації користувача з повторами у разі помилки
      let retryCount = 0;
      let userData = null;

      while (retryCount < 3 && !userData) {
        try {
          userData = await initializeUser(
            userId,
            msg.from.first_name || '',
            msg.from.last_name,
            msg.from.username,
            avatarUrl
          );
          console.log('Користувач успішно ініціалізований:', userData);
          break;
        } catch (initError) {
          console.error(`Спроба ${retryCount + 1} ініціалізації користувача не вдалась:`, initError);
          retryCount++;
          if (retryCount < 3) {
            await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
          }
        }
      }

      // Обробка реферального коду
      const startParam = msg.text.split(' ')[1];
      if (startParam && userData) {
        try {
          const referralResult = await processReferral(startParam, userId);
          console.log('Реферальний код оброблено:', referralResult);

          if (referralResult.success) {
            await bot.sendMessage(chatId,
              `Вітаємо! Ви успішно використали реферальний код та отримали бонус ${referralResult.bonusCoins} монет!`
            );
          }
        } catch (referralError) {
          console.error('Помилка при обробці реферального коду:', referralError);
          // Не показуємо помилку користувачу, якщо це помилка реферальної системи
        }
      }
    } catch (dbError) {
      console.error('Помилка при ініціалізації користувача:', dbError);
      // Не показуємо технічну помилку користувачу
    }
  } catch (error) {
    console.error('Помилка при обробці команди /start:', error);
    try {
      await bot.sendMessage(chatId,
        'Вибачте, сталася помилка. Спробуйте ще раз пізніше або зверніться до підтримки.'
      );
    } catch (sendError) {
      console.error('Помилка при відправці повідомлення про помилку:', sendError);
    }
  }
}

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;

  // Перевіряємо час останнього запиту
  const now = Date.now();
  const lastRequest = userLastRequest.get(userId) || 0;

  if (now - lastRequest < COOLDOWN_TIME) {
    await bot.answerCallbackQuery(query.id);
    return;
  }

  userLastRequest.set(userId, now);

  if (query.data === 'invite_friends') {
    try {
      const userData = await getUserData(userId);
      const inviteLink = `https://t.me/${process.env.BOT_USERNAME}?start=${userData.referralCode}`;
      await bot.answerCallbackQuery(query.id);
      await bot.sendMessage(chatId,
        `Ось ваше реферальне посилання: ${inviteLink}\nПоділіться ним з друзями і отримайте бонуси!`
      );
    } catch (error) {
      console.error('Помилка при отриманні реферального посилання:', error);
      await bot.answerCallbackQuery(query.id, {
        text: 'Виникла помилка. Спробуйте пізніше.'
      });
    }
  }
});

bot.getMe().then((botInfo) => {
  console.log("Бот успішно запущено. Інформація про бота:", botInfo);
}).catch((error) => {
  console.error("Помилка при отриманні інформації про бота:", error);
});

export default bot;