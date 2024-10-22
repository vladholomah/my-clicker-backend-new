import { query, isDatabaseReady } from './db.js';

// Генерація реферального коду
function generateReferralCode(length = 6) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Генерація унікального реферального коду
async function generateUniqueReferralCode(maxAttempts = 10) {
  for (let i = 0; i < maxAttempts; i++) {
    const code = generateReferralCode();
    const { rows } = await query(
      'SELECT referral_code FROM users WHERE referral_code = $1',
      [code]
    );
    if (rows.length === 0) {
      return code;
    }
  }
  throw new Error('Не вдалося згенерувати унікальний реферальний код');
}

export async function initializeUser(userId, firstName, lastName, username, avatarUrl) {
  if (!isDatabaseReady()) {
    throw new Error('База даних не готова');
  }

  try {
    console.log('Спроба ініціалізації користувача:', userId);

    // Початок транзакції
    await query('BEGIN');

    // Перевіряємо чи існує користувач
    let { rows: user } = await query(
      'SELECT * FROM users WHERE telegram_id = $1',
      [userId]
    );

    if (user.length === 0) {
      console.log('Створення нового користувача...');
      const referralCode = await generateUniqueReferralCode();
      const { rows: newUser } = await query(`
        INSERT INTO users (
          telegram_id, 
          first_name, 
          last_name, 
          username, 
          referral_code, 
          coins,
          total_coins,
          level,
          avatar,
          created_at,
          last_active
        ) VALUES ($1, $2, $3, $4, $5, 0, 0, 'Новачок', $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        RETURNING *
      `, [userId, firstName || null, lastName || null, username || null, referralCode, avatarUrl]);

      user = newUser;
      console.log('Новий користувач створений:', newUser[0]);
    } else {
      console.log('Оновлення існуючого користувача...');
      const { rows: updatedUser } = await query(`
        UPDATE users 
        SET 
          first_name = COALESCE($2, first_name),
          last_name = COALESCE($3, last_name),
          username = COALESCE($4, username),
          avatar = COALESCE($5, avatar),
          last_active = CURRENT_TIMESTAMP
        WHERE telegram_id = $1 
        RETURNING *
      `, [userId, firstName, lastName, username, avatarUrl]);

      user = updatedUser;
      console.log('Користувач оновлений:', updatedUser[0]);
    }

    await query('COMMIT');

    const referralLink = `https://t.me/${process.env.BOT_USERNAME}?start=${user[0].referral_code}`;

    return {
      telegramId: user[0].telegram_id.toString(),
      firstName: user[0].first_name,
      lastName: user[0].last_name,
      username: user[0].username,
      referralCode: user[0].referral_code,
      referralLink: referralLink,
      coins: user[0].coins,
      totalCoins: user[0].total_coins,
      level: user[0].level,
      avatar: user[0].avatar,
      createdAt: user[0].created_at,
      lastActive: user[0].last_active
    };
  } catch (error) {
    await query('ROLLBACK');
    console.error('Помилка при ініціалізації користувача:', error);
    throw error;
  }
}

export async function processReferral(referralCode, userId) {
  if (!isDatabaseReady()) {
    throw new Error('База даних не готова');
  }

  try {
    await query('BEGIN');

    console.log(`Обробка реферального коду: ${referralCode}, userId: ${userId}`);

    // Знаходимо користувача, який надав реферальний код
    const { rows: referrer } = await query(
      'SELECT * FROM users WHERE referral_code = $1',
      [referralCode]
    );

    if (referrer.length === 0) {
      throw new Error('Недійсний реферальний код');
    }

    if (referrer[0].telegram_id === userId) {
      throw new Error('Неможливо використати власний реферальний код');
    }

    // Перевіряємо чи користувач вже не був запрошений
    const { rows: user } = await query(
      'SELECT referred_by FROM users WHERE telegram_id = $1',
      [userId]
    );

    if (user[0].referred_by) {
      throw new Error('Користувач вже був запрошений');
    }

    const bonusCoins = 10;

    // Оновлюємо дані запрошеного користувача
    await query(`
      UPDATE users 
      SET 
        referred_by = $1,
        coins = coins + $2,
        total_coins = total_coins + $2,
        last_active = CURRENT_TIMESTAMP
      WHERE telegram_id = $3
    `, [referrer[0].telegram_id, bonusCoins, userId]);

    // Оновлюємо дані запрошувача
    await query(`
      UPDATE users 
      SET 
        referrals = array_append(referrals, $1),
        coins = coins + $2,
        total_coins = total_coins + $2,
        last_active = CURRENT_TIMESTAMP
      WHERE telegram_id = $3
    `, [userId, bonusCoins, referrer[0].telegram_id]);

    await query('COMMIT');

    return {
      success: true,
      message: 'Реферальний код успішно використано',
      bonusCoins
    };
  } catch (error) {
    await query('ROLLBACK');
    console.error('Помилка обробки реферала:', error);
    throw error;
  }
}

export async function getUserData(userId) {
  if (!isDatabaseReady()) {
    throw new Error('База даних не готова');
  }

  try {
    // Оновлюємо last_active та отримуємо дані користувача
    const { rows: user } = await query(`
      UPDATE users 
      SET last_active = CURRENT_TIMESTAMP 
      WHERE telegram_id = $1 
      RETURNING *
    `, [userId]);

    if (user.length === 0) {
      throw new Error('Користувача не знайдено');
    }

    // Отримуємо дані про друзів
    const { rows: friends } = await query(`
      SELECT 
        telegram_id, 
        first_name, 
        last_name, 
        username, 
        coins, 
        total_coins, 
        level,
        avatar,
        created_at,
        last_active
      FROM users
      WHERE telegram_id = ANY($1)
    `, [user[0].referrals]);

    const referralLink = `https://t.me/${process.env.BOT_USERNAME}?start=${user[0].referral_code}`;

    return {
      telegramId: user[0].telegram_id.toString(),
      firstName: user[0].first_name,
      lastName: user[0].last_name,
      username: user[0].username,
      coins: user[0].coins,
      totalCoins: user[0].total_coins,
      level: user[0].level,
      referralCode: user[0].referral_code,
      referralLink: referralLink,
      avatar: user[0].avatar,
      createdAt: user[0].created_at,
      lastActive: user[0].last_active,
      friends: friends.map(friend => ({
        telegramId: friend.telegram_id.toString(),
        firstName: friend.first_name,
        lastName: friend.last_name,
        username: friend.username,
        coins: friend.coins,
        totalCoins: friend.total_coins,
        level: friend.level,
        avatar: friend.avatar,
        createdAt: friend.created_at,
        lastActive: friend.last_active
      }))
    };
  } catch (error) {
    console.error('Помилка отримання даних користувача:', error);
    throw error;
  }
}

export async function updateUserCoins(userId, coinsToAdd) {
  if (!isDatabaseReady()) {
    throw new Error('База даних не готова');
  }

  try {
    await query('BEGIN');

    // Перевіряємо чи існує користувач та його поточний баланс
    const { rows: user } = await query(
      'SELECT coins FROM users WHERE telegram_id = $1',
      [userId]
    );

    if (user.length === 0) {
      throw new Error('Користувача не знайдено');
    }

    // Перевіряємо чи не стане баланс від'ємним
    if (user[0].coins + coinsToAdd < 0) {
      throw new Error('Недостатньо монет');
    }

    // Оновлюємо баланс
    const { rows: result } = await query(`
      UPDATE users
      SET 
        coins = coins + $1,
        total_coins = CASE 
          WHEN $1 > 0 THEN total_coins + $1
          ELSE total_coins
        END,
        last_active = CURRENT_TIMESTAMP
      WHERE telegram_id = $2
      RETURNING coins, total_coins
    `, [coinsToAdd, userId]);

    await query('COMMIT');

    return {
      newCoins: result[0].coins,
      newTotalCoins: result[0].total_coins
    };
  } catch (error) {
    await query('ROLLBACK');
    console.error('Помилка оновлення монет:', error);
    throw error;
  }
}