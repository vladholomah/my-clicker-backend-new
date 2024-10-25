import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import { initializeUser, processReferral, getUserData } from './userManagement.js';

dotenv.config();

console.log('FRONTEND_URL при запуску:', process.env.FRONTEND_URL);
console.log('POSTGRES_URL (перші 20 символів):', process.env.POSTGRES_URL.substring(0, 20) + '...');
console.log('BOT_TOKEN (перші 10 символів):', process.env.BOT_TOKEN.substring(0, 10) + '...');

const bot = new TelegramBot(process.env.BOT_TOKEN, {
  webHook: {
    port: process.env.PORT
  }
});

// Додаємо обробку помилок для бота
bot.on('error', (error) => {
  console.error('Telegram bot error:', error);
});

bot.on('webhook_error', (error) => {
  console.error('Webhook error:', error);
});

bot.on('polling_error', (error) => {
  console.error('Polling error:', error);
});

// Оновлена функція обробки команди /start
async function handleStart(msg) {
  console.log('Початок обробки команди /start');
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const keyboard = {
    inline_keyboard: [
      [{
        text: 'Play Game',
        web_app: {
          url: `${process.env.FRONTEND_URL}?userId=${userId}`
        }
      }]
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

    try {
      // Отримуємо аватар користувача
      const avatarUrl = await bot.getUserProfilePhotos(userId, { limit: 1 })
        .then(photos => {
          if (photos.total_count > 0) {
            return bot.getFileLink(photos.photos[0][0].file_id);
          }
          return null;
        });

      // Ініціалізуємо користувача з актуальними даними
      const userData = await initializeUser(
        userId,
        msg.from.first_name,
        msg.from.last_name,
        msg.from.username,
        avatarUrl
      );
      console.log('Користувач успішно ініціалізований:', userData);

      // Перевіряємо наявність реферального коду
      const startParam = msg.text.split(' ')[1];
      if (startParam) {
        try {
          console.log('Знайдено реферальний код:', startParam);
          const referralResult = await processReferral(startParam, userId);
          console.log('Реферальний код оброблено:', referralResult);

          if (referralResult.success) {
            await bot.sendMessage(
              chatId,
              `Вітаємо! Ви успішно використали реферальний код та отримали бонус ${referralResult.bonusCoins} монет!`
            );
          }
        } catch (referralError) {
          console.error('Помилка при обробці реферального коду:', referralError);
          if (referralError.message !== 'User already referred') {
            await bot.sendMessage(
              chatId,
              'Виникла помилка при обробці реферального коду. Спробуйте пізніше.'
            );
          }
        }
      }

      // Оновлюємо дані користувача після всіх операцій
      const updatedUserData = await getUserData(userId);
      console.log('Оновлені дані користувача:', updatedUserData);

    } catch (dbError) {
      console.error('Помилка при ініціалізації користувача або обробці реферального коду:', dbError);
      await bot.sendMessage(
        chatId,
        'Виникла помилка при обробці вашого запиту. Будь ласка, спробуйте ще раз пізніше.'
      );
    }
  } catch (error) {
    console.error('Помилка при обробці команди /start:', error);
    console.log('Завершення обробки команди /start');
    try {
      await bot.sendMessage(
        chatId,
        'Вибачте, сталася помилка. Спробуйте ще раз пізніше або зверніться до підтримки.'
      );
    } catch (sendError) {
      console.error('Помилка при відправці повідомлення про помилку:', sendError);
    }
  }
}

// Обробка текстових повідомлень
bot.on('text', async (msg) => {
  console.log('Отримано повідомлення:', msg.text);
  if (msg.text.startsWith('/start')) {
    console.log('Обробка команди /start');
    await handleStart(msg);
  }
});

// Обробка callback-запитів
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;

  if (query.data === 'invite_friends') {
    try {
      const userData = await getUserData(userId);
      const inviteLink = `https://t.me/${process.env.BOT_USERNAME}?start=${userData.referralCode}`;
      await bot.answerCallbackQuery(query.id);
      await bot.sendMessage(
        chatId,
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

// Перевірка статусу бота при запуску
bot.getMe().then((botInfo) => {
  console.log("Бот успішно запущено. Інформація про бота:", botInfo);
}).catch((error) => {
  console.error("Помилка при отриманні інформації про бота:", error);
});

export default bot;