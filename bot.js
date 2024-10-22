import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import { initializeUser, processReferral, getUserData } from './userManagement.js';
import { isDatabaseReady } from './db.js';

dotenv.config();

// Додаємо змінну для відстеження готовності бота
let botReady = false;
let initializationInProgress = false;
let messageQueue = [];

console.log('FRONTEND_URL при запуску:', process.env.FRONTEND_URL);
console.log('POSTGRES_URL (перші 20 символів):', process.env.POSTGRES_URL.substring(0, 20) + '...');
console.log('BOT_TOKEN (перші 10 символів):', process.env.BOT_TOKEN.substring(0, 10) + '...');

// Створюємо функцію для відправки повідомлень з retry
async function sendMessageWithRetry(chatId, text, options, maxAttempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`Спроба відправки повідомлення ${attempt}/${maxAttempts}`);
      const result = await bot.sendMessage(chatId, text, options);
      console.log(`Повідомлення успішно відправлено з ${attempt} спроби:`, result.message_id);
      return result;
    } catch (error) {
      lastError = error;
      console.error(`Спроба ${attempt} невдала:`, error);
      if (attempt === maxAttempts) break;
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
  throw lastError;
}

const bot = new TelegramBot(process.env.BOT_TOKEN, {
  webHook: {
    port: process.env.PORT
  }
});

// Функція обробки черги повідомлень
async function processMessageQueue() {
  while (messageQueue.length > 0 && botReady && isDatabaseReady()) {
    const msg = messageQueue.shift();
    try {
      await handleStart(msg);
    } catch (error) {
      console.error('Помилка при обробці повідомлення з черги:', error);
    }
  }
}

// Оновлений обробник text з чергою
bot.on('text', async (msg) => {
  if (!botReady || !isDatabaseReady()) {
    console.log('Бот або база даних не готові, додаємо повідомлення в чергу');
    messageQueue.push(msg);
    return;
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
  botReady = false;
});

// Оновлена функція handleStart з додатковими перевірками
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
    if (!isDatabaseReady()) {
      throw new Error('База даних не готова');
    }

    console.log('Підготовка до відправки повідомлення');
    console.log('FRONTEND_URL:', process.env.FRONTEND_URL);
    console.log('Keyboard:', JSON.stringify(keyboard));

    const sentMessage = await sendMessageWithRetry(
      chatId,
      'Ласкаво просимо до TWASH COIN! Натисніть кнопку нижче, щоб почати гру:',
      { reply_markup: keyboard }
    );

    console.log('Повідомлення успішно відправлено:', sentMessage.message_id);

    try {
      console.log('Отримання аватару користувача...');
      const avatarUrl = await bot.getUserProfilePhotos(userId, { limit: 1 })
        .then(photos => {
          if (photos.total_count > 0) {
            return bot.getFileLink(photos.photos[0][0].file_id);
          }
          return null;
        })
        .catch(error => {
          console.error('Помилка при отриманні аватару:', error);
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
  if (!botReady || !isDatabaseReady()) {
    console.log('Бот або база даних не готові для обробки callback_query');
    return;
  }

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

// Ініціалізація бота з обробкою помилок
async function initializeBot() {
  if (initializationInProgress) return;
  initializationInProgress = true;

  try {
    const botInfo = await bot.getMe();
    console.log("Бот успішно запущено. Інформація про бота:", botInfo);
    botReady = true;
    // Обробляємо чергу повідомлень після успішної ініціалізації
    await processMessageQueue();
  } catch (error) {
    console.error("Помилка при ініціалізації бота:", error);
    botReady = false;
    // Повторна спроба ініціалізації через 5 секунд
    setTimeout(initializeBot, 5000);
  } finally {
    initializationInProgress = false;
  }
}

// Запускаємо ініціалізацію бота
initializeBot();

export const isBotReady = () => botReady;
export default bot;