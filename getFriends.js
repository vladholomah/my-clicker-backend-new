import { Pool } from '@vercel/postgres';
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 1,
  connectionTimeoutMillis: 0,
  idleTimeoutMillis: 0
});

async function connectWithRetry(maxRetries = 10, delay = 10000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      console.log(`Спроба підключення до бази даних ${i + 1}/${maxRetries}`);
      const result = await pool.query('SELECT NOW()');
      console.log('Підключення до бази даних успішне:', result.rows[0]);
      return;
    } catch (error) {
      console.error(`Спроба ${i + 1} не вдалася. Повторна спроба через ${delay / 1000} секунд...`);
      console.error('Деталі помилки:', error);
      if (i === maxRetries - 1) {
        console.error('Помилка підключення до бази даних:', error);
      }
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error('Не вдалося підключитися до бази даних після кількох спроб');
}

export default async (req, res) => {
  console.log('Отримано запит на отримання друзів:', req.method, req.url);
  console.log('Параметри запиту:', JSON.stringify(req.query));

  const { userId } = req.query;

  if (!userId) {
    console.error('Відсутній обов\'язковий параметр userId');
    return res.status(400).json({ success: false, error: 'Потрібен userId' });
  }

  try {
    console.log('Підключення до PostgreSQL');
    await connectWithRetry();

    // Отримуємо дані користувача
    const { rows: user } = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);

    if (user.length === 0) {
      console.error('Користувача не знайдено');
      return res.status(404).json({ success: false, error: 'Користувача не знайдено' });
    }

    console.log('Користувач знайдений:', user[0]);

    // Отримуємо дані друзів (рефералів) користувача
    const { rows: friends } = await pool.query(`
      SELECT telegram_id, first_name, last_name, username, coins, total_coins, level, avatar
      FROM users 
      WHERE telegram_id = ANY($1)
    `, [user[0].referrals]);

    console.log('Знайдено друзів:', friends.length);

    const friendsData = friends.map(friend => ({
      telegramId: friend.telegram_id.toString(),
      firstName: friend.first_name,
      lastName: friend.last_name,
      username: friend.username,
      coins: friend.coins,
      totalCoins: friend.total_coins,
      level: friend.level,
      avatar: friend.avatar
    }));

    const referralLink = `https://t.me/${process.env.BOT_USERNAME}?start=${user[0].referral_code}`;
    console.log('Згенеровано реферальне посилання:', referralLink);

    res.status(200).json({
      success: true,
      friends: friendsData,
      referralLink: referralLink,
      userCoins: user[0].coins,
      userTotalCoins: user[0].total_coins,
      userLevel: user[0].level
    });

    console.log('Успішно відправлено дані про друзів');
  } catch (error) {
    console.error('Помилка при отриманні даних друзів:', error);
    res.status(500).json({ success: false, error: 'Внутрішня помилка сервера', details: error.message });
  }
};