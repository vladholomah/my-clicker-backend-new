import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import { initializeUser, processReferral, getUserData } from './userManagement.js';

dotenv.config();

// Додаємо змінну для відстеження готовності бота
let botReady = false;

console.log('FRONTEND_URL при запуску:', process.env.FRONTEND_URL);
console.log('POSTGRES_URL (перші 20 символів):', process.env.POSTGRES_URL.substring(0, 20) + '...');
console.log('BOT_TOKEN (перші 10 символів):', process.env.BOT_TOKEN.substring(0, 10) + '...');

// Створюємо функцію для відправки повідомлень з retry
async function sendMessageWithRetry(chatId, text, options, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await bot.sendMessage(chatId, text, options);
      console.log(`Повідомлення успішно відправлено з ${attempt} спроби:`, result);
      return result;
    } catch (error) {
      console.error(`Спроба ${attempt} невдала:`, error);
      if (attempt === maxAttempts) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
}

const bot = new TelegramBot(process.env.BOT_TOKEN, {
  webHook: {
    port: process.env.PORT
  }
});

// Оновлений обробник text з перевіркою готовності
bot.on('text', async (msg) => {
  if (!botReady) {
    console.log('Бот ще не готовий до обробки повідомлень. Очікуйте...');
    await new Promise(resolve => setTimeout(resolve, 2000));
    if (!botReady) {
      console.log('Бот все ще не готовий після очікування');
      return;
    }
  }

  console.log('Отримано повідомлення:', msg.text);
  if (msg.text.startsWith('/start')) {
    console.log('Обробка команди /start');
    await handleStart(msg);
  }
});

// Покращений обробник помилок
bot.on('polling_error', (error) => {
  console.error('Помилка при опитуванні Telegram API:', error);
});

// Оновлена функція handleStart з покращеним логуванням та обробкою помилок
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

    const sentMessage = await sendMessageWithRetry(
      chatId,
      'Ласкаво просимо до TWASH COIN! Натисніть кнопку нижче, щоб почати гру:',
      { reply_markup: keyboard }
    );

    console.log('Повідомлення успішно відправлено:', sentMessage);

    try {
      console.log('Отримання аватару користувача...');
      const avatarUrl = await bot.getUserProfilePhotos(userId, { limit: 1 }).then(photos => {
        if (photos.total_count > 0) {
          return bot.getFileLink(photos.photos[0][0].file_id);
        }
        return null;
      });

      console.log('Ініціалізація користувача...');
      const userData = await initializeUser(userId, msg.from.first_name, msg.from.last_name, msg.from.username, avatarUrl);
      console.log('Користувач успішно ініціалізований:', userData);

      const startParam = msg.text.split(' ')[1];
      if (startParam) {
        console.log('Обробка реферального коду:', startParam);
        const referralResult = await processReferral(startParam, userId);
        console.log('Реферальний код оброблено:', referralResult);

        if (referralResult.success) {
          await sendMessageWithRetry(
            chatId,
            `Вітаємо! Ви успішно використали реферальний код та отримали бонус ${referralResult.bonusCoins} монет!`
          );
        }
      }
    } catch (dbError) {
      console.error('Помилка при ініціалізації користувача або обробці реферального коду:', dbError);
      await sendMessageWithRetry(
        chatId,
        'Виникла помилка при обробці вашого запиту. Будь ласка, спробуйте ще раз пізніше.'
      );
    }
  } catch (error) {
    console.error('Помилка при обробці команди /start:', error);
    console.log('Завершення обробки команди /start');
    try {
      await sendMessageWithRetry(
        chatId,
        'Вибачте, сталася помилка. Спробуйте ще раз пізніше або зверніться до підтримки.'
      );
    } catch (sendError) {
      console.error('Критична помилка при відправці повідомлення про помилку:', sendError);
    }
  }
}

// Оновлений обробник callback_query
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;

  if (query.data === 'invite_friends') {
    try {
      const userData = await getUserData(userId);
      const inviteLink = `https://t.me/${process.env.BOT_USERNAME}?start=${userData.referralCode}`;
      await bot.answerCallbackQuery(query.id);
      await sendMessageWithRetry(chatId, `Ось ваше реферальне посилання: ${inviteLink}\nПоділіться ним з друзями і отримайте бонуси!`);
    } catch (error) {
      console.error('Помилка при отриманні реферального посилання:', error);
      await bot.answerCallbackQuery(query.id, { text: 'Виникла помилка. Спробуйте пізніше.' });
    }
  }
});

// Ініціалізація бота з перевіркою готовності
bot.getMe().then((botInfo) => {
  console.log("Бот успішно запущено. Інформація про бота:", botInfo);
  botReady = true;
}).catch((error) => {
  console.error("Помилка при отриманні інформації про бота:", error);
});

export default bot;