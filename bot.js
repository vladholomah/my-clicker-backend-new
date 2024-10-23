import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import { initializeUser, processReferral, getUserData } from './userManagement.js';

dotenv.config();

// Перевірка наявності необхідних змінних середовища
const requiredEnvVars = ['BOT_TOKEN', 'FRONTEND_URL', 'BOT_USERNAME'];
requiredEnvVars.forEach(varName => {
  if (!process.env[varName]) {
    console.error(`Missing required environment variable: ${varName}`);
    process.exit(1);
  }
});

console.log('FRONTEND_URL при запуску:', process.env.FRONTEND_URL);
console.log('POSTGRES_URL (перші 20 символів):', process.env.POSTGRES_URL.substring(0, 20) + '...');
console.log('BOT_TOKEN (перші 10 символів):', process.env.BOT_TOKEN.substring(0, 10) + '...');

const bot = new TelegramBot(process.env.BOT_TOKEN, {
  webHook: {
    port: process.env.PORT
  }
});

// Обробка текстових повідомлень
bot.on('text', async (msg) => {
  try {
    console.log('Отримано повідомлення:', msg.text);
    if (msg.text.startsWith('/start')) {
      console.log('Обробка команди /start');
      await handleStart(msg);
    }
  } catch (error) {
    console.error('Помилка при обробці текстового повідомлення:', error);
    try {
      await bot.sendMessage(msg.chat.id, 'Виникла помилка при обробці вашого повідомлення. Спробуйте пізніше.');
    } catch (sendError) {
      console.error('Помилка при відправці повідомлення про помилку:', sendError);
    }
  }
});

// Обробка помилок при опитуванні Telegram API
bot.on('polling_error', (error) => {
  console.error('Помилка при опитуванні Telegram API:', error);
});

// Обробка callback-запитів
bot.on('callback_query', async (query) => {
  try {
    const chatId = query.message.chat.id;
    const userId = query.from.id;

    if (query.data === 'invite_friends') {
      try {
        const userData = await getUserData(userId);
        if (!userData) {
          throw new Error('User data not found');
        }

        const inviteLink = `https://t.me/${process.env.BOT_USERNAME}?start=${userData.referralCode}`;
        await bot.answerCallbackQuery(query.id);
        await bot.sendMessage(
          chatId,
          `🎁 Ось ваше реферальне посилання: ${inviteLink}\n\n` +
          `Поділіться ним з друзями і отримайте ${1000} монет за кожного запрошеного друга!\n\n` +
          `Ваш поточний баланс: ${userData.coins} монет`
        );
      } catch (error) {
        console.error('Помилка при отриманні реферального посилання:', error);
        await bot.answerCallbackQuery(query.id, {
          text: 'Виникла помилка. Спробуйте пізніше.',
          show_alert: true
        });
      }
    }
  } catch (error) {
    console.error('Помилка при обробці callback_query:', error);
  }
});

// Головний обробник команди /start
async function handleStart(msg) {
  console.log('Початок обробки команди /start');
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
    // Створюємо клавіатуру з веб-додатком
    const keyboard = {
      inline_keyboard: [
        [{
          text: '🎮 Play Game',
          web_app: { url: `${process.env.FRONTEND_URL}?userId=${userId}` }
        }],
        [{
          text: '👥 Запросити друзів',
          callback_data: 'invite_friends'
        }]
      ]
    };

    console.log('Підготовка до відправки повідомлення');
    console.log('FRONTEND_URL:', process.env.FRONTEND_URL);
    console.log('Keyboard:', JSON.stringify(keyboard));

    // Отримуємо фото профілю користувача
    let avatarUrl = null;
    try {
      const photos = await bot.getUserProfilePhotos(userId, { limit: 1 });
      if (photos.total_count > 0) {
        avatarUrl = await bot.getFileLink(photos.photos[0][0].file_id);
      }
    } catch (photoError) {
      console.error('Помилка при отриманні фото профілю:', photoError);
    }

    // Ініціалізуємо користувача
    try {
      const userData = await initializeUser(
        userId,
        msg.from.first_name,
        msg.from.last_name,
        msg.from.username,
        avatarUrl
      );
      console.log('Користувач успішно ініціалізований:', userData);

      // Обробка реферального коду
      const startParam = msg.text.split(' ')[1];
      if (startParam) {
        try {
          const referralResult = await processReferral(startParam, userId);
          console.log('Реферальний код оброблено:', referralResult);

          if (referralResult.success) {
            await bot.sendMessage(
              chatId,
              `🎉 Вітаємо! Ви успішно використали реферальний код та отримали бонус ${referralResult.bonusCoins} монет!`
            );
          }
        } catch (refError) {
          console.error('Помилка при обробці реферального коду:', refError);
          if (refError.message !== 'User already referred') {
            await bot.sendMessage(
              chatId,
              'На жаль, виникла помилка при обробці реферального коду. Спробуйте пізніше.'
            );
          }
        }
      }

      // Відправляємо привітальне повідомлення
      const welcomeMessage = `
🎮 Ласкаво просимо до TWASH COIN!

💰 Ваш поточний баланс: ${userData.coins} монет
🏆 Ваш рівень: ${userData.level}

Натисніть кнопку нижче, щоб почати гру!
      `;

      const sentMessage = await bot.sendMessage(chatId, welcomeMessage, {
        reply_markup: keyboard
      });
      console.log('Повідомлення успішно відправлено:', sentMessage);

    } catch (dbError) {
      console.error('Помилка при ініціалізації користувача:', dbError);
      await bot.sendMessage(
        chatId,
        'Виникла помилка при обробці вашого запиту. Будь ласка, спробуйте ще раз пізніше.'
      );
    }
  } catch (error) {
    console.error('Помилка при обробці команди /start:', error);
    try {
      await bot.sendMessage(
        chatId,
        'Вибачте, сталася помилка. Спробуйте ще раз пізніше або зверніться до підтримки.'
      );
    } catch (sendError) {
      console.error('Помилка при відправці повідомлення про помилку:', sendError);
    }
  }
  console.log('Завершення обробки команди /start');
}

// Ініціалізація бота
bot.getMe().then((botInfo) => {
  console.log("Бот успішно запущено. Інформація про бота:", botInfo);
}).catch((error) => {
  console.error("Помилка при отриманні інформації про бота:", error);
});

// WebHook management functions
async function setWebhook() {
  try {
    const webhookUrl = `${process.env.WEBHOOK_URL}/bot${process.env.BOT_TOKEN}`;
    const result = await bot.setWebHook(webhookUrl);
    console.log('Webhook set result:', result);
    return result;
  } catch (error) {
    console.error('Error setting webhook:', error);
    throw error;
  }
}

async function deleteWebhook() {
  try {
    const result = await bot.deleteWebHook();
    console.log('Webhook deleted result:', result);
    return result;
  } catch (error) {
    console.error('Error deleting webhook:', error);
    throw error;
  }
}

// Експортуємо бот та допоміжні функції
export default bot;
export { setWebhook, deleteWebhook };