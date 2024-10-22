import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import { initializeUser, processReferral, getUserData } from './userManagement.js';
import { testConnection } from './db.js';

dotenv.config();

// Логування конфігурації при запуску
console.log('Starting bot with configuration:');
console.log('FRONTEND_URL:', process.env.FRONTEND_URL);
console.log('BOT_USERNAME:', process.env.BOT_USERNAME);
console.log('BOT_TOKEN status:', process.env.BOT_TOKEN ? 'Set' : 'Not set');

// Перевірка обов'язкових змінних середовища
const requiredEnvVars = ['BOT_TOKEN', 'FRONTEND_URL', 'BOT_USERNAME'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}

const bot = new TelegramBot(process.env.BOT_TOKEN, {
  webHook: {
    port: process.env.PORT
  }
});

// Кеш для запобігання подвійної обробки команд
const commandCache = new Map();
const CACHE_TIMEOUT = 5000; // 5 секунд

bot.on('text', async (msg) => {
  try {
    console.log('Received message:', {
      messageId: msg.message_id,
      from: msg.from.id,
      text: msg.text
    });

    if (msg.text.startsWith('/start')) {
      // Перевірка кешу для уникнення подвійної обробки
      const cacheKey = `${msg.from.id}-${msg.text}-${msg.message_id}`;
      if (commandCache.has(cacheKey)) {
        console.log('Duplicate command detected, skipping');
        return;
      }
      commandCache.set(cacheKey, true);
      setTimeout(() => commandCache.delete(cacheKey), CACHE_TIMEOUT);

      await handleStart(msg);
    }
  } catch (error) {
    console.error('Error handling message:', error);
    try {
      await bot.sendMessage(msg.chat.id, 'Виникла помилка при обробці команди. Будь ласка, спробуйте ще раз.');
    } catch (sendError) {
      console.error('Error sending error message:', sendError);
    }
  }
});

bot.on('polling_error', (error) => {
  console.error('Polling error:', error);
});

async function handleStart(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  console.log('Starting command handling for user:', userId);

  try {
    // Перевірка з'єднання з базою даних
    const dbConnection = await testConnection();
    if (!dbConnection) {
      throw new Error('Database connection failed');
    }

    // Відправляємо повідомлення про обробку
    const processingMessage = await bot.sendMessage(chatId, 'Обробка вашого запиту...');

    // Створюємо клавіатуру
    const keyboard = {
      inline_keyboard: [
        [{
          text: 'Play Game',
          web_app: { url: `${process.env.FRONTEND_URL}?userId=${userId}` }
        }]
      ]
    };

    // Отримуємо аватар користувача
    let avatarUrl = null;
    try {
      const photos = await bot.getUserProfilePhotos(userId, { limit: 1 });
      if (photos.total_count > 0) {
        avatarUrl = await bot.getFileLink(photos.photos[0][0].file_id);
      }
    } catch (photoError) {
      console.error('Error getting user avatar:', photoError);
    }

    // Ініціалізуємо користувача
    const userData = await initializeUser(
      userId,
      msg.from.first_name,
      msg.from.last_name,
      msg.from.username,
      avatarUrl
    );
    console.log('User initialized:', userData);

    // Видаляємо повідомлення про обробку
    try {
      await bot.deleteMessage(chatId, processingMessage.message_id);
    } catch (deleteError) {
      console.error('Error deleting processing message:', deleteError);
    }

    // Відправляємо основне повідомлення
    const welcomeMessage = await bot.sendMessage(
      chatId,
      'Ласкаво просимо до TWASH COIN! Натисніть кнопку нижче, щоб почати гру:',
      { reply_markup: keyboard }
    );
    console.log('Welcome message sent:', welcomeMessage.message_id);

    // Обробляємо реферальний код, якщо він є
    const startParam = msg.text.split(' ')[1];
    if (startParam) {
      try {
        const referralResult = await processReferral(startParam, userId);
        if (referralResult.success) {
          await bot.sendMessage(
            chatId,
            `Вітаємо! Ви успішно використали реферальний код та отримали бонус ${referralResult.bonusCoins} монет!`
          );
        }
      } catch (referralError) {
        console.error('Error processing referral:', referralError);
        if (referralError.message !== 'User already referred') {
          await bot.sendMessage(chatId, 'Помилка при обробці реферального коду.');
        }
      }
    }
  } catch (error) {
    console.error('Error in handleStart:', error);
    await bot.sendMessage(
      chatId,
      'Вибачте, сталася помилка. Спробуйте ще раз через кілька хвилин або зверніться до підтримки.'
    );
  }
}

bot.on('callback_query', async (query) => {
  try {
    const chatId = query.message.chat.id;
    const userId = query.from.id;

    if (query.data === 'invite_friends') {
      const userData = await getUserData(userId);
      const inviteLink = `https://t.me/${process.env.BOT_USERNAME}?start=${userData.referralCode}`;
      await bot.answerCallbackQuery(query.id);
      await bot.sendMessage(
        chatId,
        `Ось ваше реферальне посилання: ${inviteLink}\nПоділіться ним з друзями і отримайте бонуси!`
      );
    }
  } catch (error) {
    console.error('Error handling callback query:', error);
    await bot.answerCallbackQuery(query.id, {
      text: 'Виникла помилка. Спробуйте пізніше.'
    });
  }
});

// Ініціалізація бота
bot.getMe()
  .then((botInfo) => {
    console.log("Бот успішно запущено. Інформація про бота:", botInfo);
  })
  .catch((error) => {
    console.error("Помилка при отриманні інформації про бота:", error);
  });

export default bot;