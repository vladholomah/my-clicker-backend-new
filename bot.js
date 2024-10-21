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

  try {
    console.log('Підготовка до відправки повідомлення з кнопкою "Play Game"');
    console.log('FRONTEND_URL:', process.env.FRONTEND_URL);
    console.log('Keyboard:', JSON.stringify(keyboard));

    const sentMessage = await bot.sendMessage(chatId, 'Ласкаво просимо до TWASH COIN! Натисніть кнопку нижче, щоб почати гру:', {
      reply_markup: keyboard
    });
    console.log('Повідомлення успішно відправлено:', sentMessage);

    try {
      const userData = await initializeUser(userId, msg.from.first_name, msg.from.last_name, msg.from.username);
      console.log('Користувач успішно ініціалізований:', userData);

      // Обробка реферального коду, якщо він є
      const startParam = msg.text.split(' ')[1];
      if (startParam) {
        await processReferral(startParam, userId);
        console.log('Реферальний код оброблено:', startParam);
      }
    } catch (dbError) {
      console.error('Помилка при ініціалізації користувача або обробці реферального коду:', dbError);
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

bot.getMe().then((botInfo) => {
  console.log("Бот успішно запущено. Інформація про бота:", botInfo);
}).catch((error) => {
  console.error("Помилка при отриманні інформації про бота:", error);
});

export default bot;