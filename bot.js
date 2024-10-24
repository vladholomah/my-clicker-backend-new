import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import { initializeUser, processReferral, getUserData } from './userManagement.js';
import { withClient } from './db.js';

dotenv.config();

// Розширене логування конфігурації
console.log('Initializing Telegram bot...');
console.log('FRONTEND_URL:', process.env.FRONTEND_URL);
console.log('BOT_USERNAME:', process.env.BOT_USERNAME);
console.log('BOT_TOKEN length:', process.env.BOT_TOKEN ? process.env.BOT_TOKEN.length : 'not set');

// Створення екземпляра бота з розширеними налаштуваннями
const bot = new TelegramBot(process.env.BOT_TOKEN, {
  webHook: {
    port: process.env.PORT,
    host: '0.0.0.0'
  },
  polling: false,
  filepath: false, // Вимикаємо локальне збереження файлів
  onlyFirstMatch: true // Обробляємо тільки перше співпадіння команди
});

// Обробник команд
bot.on('text', async (msg) => {
  try {
    console.log('Received message:', {
      text: msg.text,
      from: msg.from?.id,
      chat: msg.chat?.id,
      timestamp: new Date().toISOString()
    });

    if (msg.text.startsWith('/start')) {
      await handleStart(msg);
    }
  } catch (error) {
    console.error('Error in message handler:', error);
    try {
      await bot.sendMessage(msg.chat.id, 'Виникла помилка при обробці вашого запиту. Спробуйте пізніше.');
    } catch (sendError) {
      console.error('Error sending error message:', sendError);
    }
  }
});

// Покращений обробник команди /start
async function handleStart(msg) {
  const startTime = Date.now();
  console.log('Starting /start command handler');

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  let userData = null;

  try {
    // Підготовка клавіатури
    const keyboard = {
      inline_keyboard: [
        [{
          text: 'Play Game',
          web_app: { url: `${process.env.FRONTEND_URL}?userId=${userId}` }
        }]
      ]
    };

    console.log('Prepared keyboard:', JSON.stringify(keyboard));

    // Відправка початкового повідомлення
    const welcomeMessage = await bot.sendMessage(
      chatId,
      'Ласкаво просимо до TWASH COIN! Натисніть кнопку нижче, щоб почати гру:',
      { reply_markup: keyboard }
    );

    console.log('Welcome message sent:', welcomeMessage.message_id);

    // Отримання аватара користувача
    let avatarUrl = null;
    try {
      const photos = await bot.getUserProfilePhotos(userId, { limit: 1 });
      if (photos && photos.total_count > 0) {
        avatarUrl = await bot.getFileLink(photos.photos[0][0].file_id);
        console.log('Got user avatar URL:', avatarUrl);
      }
    } catch (photoError) {
      console.warn('Could not get user photo:', photoError.message);
    }

    // Ініціалізація користувача з повторними спробами
    let retries = 3;
    while (retries > 0) {
      try {
        userData = await initializeUser(
          userId,
          msg.from.first_name,
          msg.from.last_name,
          msg.from.username,
          avatarUrl
        );
        console.log('User initialized successfully:', userId);
        break;
      } catch (initError) {
        retries--;
        console.error(`Error initializing user (${retries} retries left):`, initError);
        if (retries === 0) throw initError;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // Обробка реферального коду
    const startParam = msg.text.split(' ')[1];
    if (startParam) {
      try {
        const referralResult = await processReferral(startParam, userId);
        console.log('Referral processed:', referralResult);

        if (referralResult.success) {
          await bot.sendMessage(
            chatId,
            `Вітаємо! Ви успішно використали реферальний код та отримали бонус ${referralResult.bonusCoins} монет!`
          );
        }
      } catch (referralError) {
        console.error('Error processing referral:', referralError);
        // Не викидаємо помилку далі, щоб не переривати процес
      }
    }

    const executionTime = Date.now() - startTime;
    console.log(`/start command completed in ${executionTime}ms`);

  } catch (error) {
    console.error('Error in handleStart:', error);

    try {
      // Спроба надіслати повідомлення про помилку користувачу
      await bot.sendMessage(
        chatId,
        'Виникла помилка при обробці вашого запиту. Будь ласка, спробуйте ще раз через кілька хвилин.'
      );
    } catch (sendError) {
      console.error('Error sending error message:', sendError);
    }

    // Логуємо детальну інформацію про помилку
    console.error('Detailed error info:', {
      userId,
      chatId,
      errorMessage: error.message,
      errorStack: error.stack,
      userData: userData || 'not initialized'
    });
  }
}

// Обробник помилок polling
bot.on('polling_error', (error) => {
  console.error('Telegram polling error:', error);
});

// Обробник помилок webhook
bot.on('webhook_error', (error) => {
  console.error('Telegram webhook error:', error);
});

// Додаткові обробники подій
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
    try {
      await bot.answerCallbackQuery(query.id, {
        text: 'Виникла помилка. Спробуйте пізніше.'
      });
    } catch (sendError) {
      console.error('Error sending callback answer:', sendError);
    }
  }
});

// Перевірка з'єднання при запуску
bot.getMe()
  .then((botInfo) => {
    console.log('Bot successfully initialized:', botInfo);
  })
  .catch((error) => {
    console.error('Error getting bot info:', error);
  });

export default bot;