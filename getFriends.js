import { getConnection } from './db.js';

export default async (req, res) => {
  const requestId = Math.random().toString(36).substring(7);
  console.log(`[${requestId}] Отримано запит на отримання друзів:`, req.method, req.url);
  console.log(`[${requestId}] Параметри запиту:`, JSON.stringify(req.query));

  const { userId } = req.query;

  if (!userId) {
    console.error(`[${requestId}] Відсутній обов'язковий параметр userId`);
    return res.status(400).json({
      success: false,
      error: 'Потрібен userId'
    });
  }

  let client;
  try {
    // Використовуємо нову функцію getConnection замість прямого pool.connect
    client = await getConnection();
    console.log(`[${requestId}] Підключено до бази даних`);

    // Використовуємо транзакцію для узгодженості даних
    await client.query('BEGIN');

    // Отримуємо дані користувача
    const { rows: user } = await client.query(
      'SELECT * FROM users WHERE telegram_id = $1',
      [userId]
    );

    if (user.length === 0) {
      console.error(`[${requestId}] Користувача не знайдено`);
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        error: 'Користувача не знайдено'
      });
    }

    console.log(`[${requestId}] Користувач знайдений:`, {
      telegramId: user[0].telegram_id,
      firstName: user[0].first_name,
      referralsCount: user[0].referrals ? user[0].referrals.length : 0
    });

    // Отримуємо дані друзів (рефералів) користувача
    const { rows: friends } = await client.query(`
      SELECT 
        telegram_id,
        first_name,
        last_name,
        username,
        coins,
        total_coins,
        level,
        avatar
      FROM users 
      WHERE telegram_id = ANY($1)
      ORDER BY total_coins DESC
    `, [user[0].referrals || []]);

    console.log(`[${requestId}] Знайдено друзів:`, friends.length);

    const friendsData = friends.map(friend => ({
      telegramId: friend.telegram_id.toString(),
      firstName: friend.first_name || 'User',
      lastName: friend.last_name,
      username: friend.username,
      coins: parseInt(friend.coins) || 0,
      totalCoins: parseInt(friend.total_coins) || 0,
      level: friend.level || 'Новачок',
      avatar: friend.avatar
    }));

    const referralLink = `https://t.me/${process.env.BOT_USERNAME}?start=${user[0].referral_code}`;
    console.log(`[${requestId}] Згенеровано реферальне посилання:`, referralLink);

    await client.query('COMMIT');

    const response = {
      success: true,
      friends: friendsData,
      referralLink: referralLink,
      userCoins: parseInt(user[0].coins) || 0,
      userTotalCoins: parseInt(user[0].total_coins) || 0,
      userLevel: user[0].level || 'Новачок',
      referralCode: user[0].referral_code
    };

    res.status(200).json(response);

    console.log(`[${requestId}] Успішно відправлено дані про друзів`);
  } catch (error) {
    console.error(`[${requestId}] Помилка при отриманні даних друзів:`, error);

    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error(`[${requestId}] Помилка при відкаті транзакції:`, rollbackError);
      }
    }

    res.status(500).json({
      success: false,
      error: 'Внутрішня помилка сервера',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    if (client) {
      try {
        client.release();
        console.log(`[${requestId}] З'єднання з базою даних звільнено`);
      } catch (releaseError) {
        console.error(`[${requestId}] Помилка при звільненні з'єднання:`, releaseError);
      }
    }
  }
};