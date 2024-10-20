import { pool } from './db.js';

export default async (req, res) => {
  console.log('Отримано запит на отримання друзів:', req.method, req.url);
  console.log('Параметри запиту:', JSON.stringify(req.query));

  const { userId } = req.query;

  if (!userId) {
    console.error('Відсутній обов\'язковий параметр userId');
    return res.status(400).json({ success: false, error: 'Потрібен userId' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Отримуємо дані користувача
    const { rows: user } = await client.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);

    if (user.length === 0) {
      console.error('Користувача не знайдено');
      return res.status(404).json({ success: false, error: 'Користувача не знайдено' });
    }

    console.log('Користувач знайдений:', user[0]);

    // Отримуємо дані друзів (рефералів) користувача
    const { rows: friends } = await client.query(`
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

    await client.query('COMMIT');

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
    await client.query('ROLLBACK');
    console.error('Помилка при отриманні даних друзів:', error);
    res.status(500).json({ success: false, error: 'Внутрішня помилка сервера', details: error.message });
  } finally {
    client.release();
  }
};