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

async function getUserProfilePhoto(userId) {
  try {
    const photos = await bot.getUserProfilePhotos(userId, { limit: 1 });
    if (photos && photos.total_count > 0) {
      const fileLink = await bot.getFileLink(photos.photos[0][0].file_id);
      console.log('Отримано фото профілю:', fileLink);
      return fileLink;
    }
    console.log('Фото профілю не знайдено');
    return null;
  } catch (error) {
    console.error('Помилка при отриманні фото профілю:', error);
    return null;
  }
}

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

bot.on('error', (error) => {
  console.error('Telegram bot error:', error);
});

bot.on('webhook_error', (error) => {
  console.error('Webhook error:', error);
});

// Додаємо graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received');
  try {
    await bot.close();
    console.log('Bot connection closed');
  } catch (err) {
    console.error('Error during bot shutdown:', err);
  }
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

    try {
      // Отримуємо фото профілю
      const avatarUrl = await getUserProfilePhoto(userId);
      console.log('Отримано URL аватара:', avatarUrl);

      const userData = await initializeUser(userId, msg.from.first_name, msg.from.last_name, msg.from.username, avatarUrl);
      console.log('Користувач успішно ініціалізований:', userData);

      // Обробка реферального коду, якщо він є
      const startParam = msg.text.split(' ')[1];
      if (startParam) {
        const referralResult = await processReferral(startParam, userId);
        console.log('Реферальний код оброблено:', referralResult);

        if (referralResult.success) {
          await bot.sendMessage(chatId, `Вітаємо! Ви успішно використали реферальний код та отримали бонус ${referralResult.bonusCoins} монет!`);
        }
      }
    } catch (dbError) {
      console.error('Помилка при ініціалізації користувача або обробці реферального коду:', dbError);
      await bot.sendMessage(chatId, 'Виникла помилка при обробці вашого запиту. Будь ласка, спробуйте ще раз пізніше.');
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

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;

  if (query.data === 'invite_friends') {
    try {
      const userData = await getUserData(userId);
      const inviteLink = `https://t.me/${process.env.BOT_USERNAME}?start=${userData.referralCode}`;
      await bot.answerCallbackQuery(query.id);
      await bot.sendMessage(chatId, `Ось ваше реферальне посилання: ${inviteLink}\nПоділіться ним з друзями і отримайте бонуси!`);
    } catch (error) {
      console.error('Помилка при отриманні реферального посилання:', error);
      await bot.answerCallbackQuery(query.id, { text: 'Виникла помилка. Спробуйте пізніше.' });
    }
  }
});

bot.getMe().then((botInfo) => {
  console.log("Бот успішно запущено. Інформація про бота:", botInfo);
}).catch((error) => {
  console.error("Помилка при отриманні інформації про бота:", error);
});

export default bot;