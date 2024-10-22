import { pool, isDatabaseReady } from './db.js';

// Утиліта для генерації унікального реферального коду
function generateReferralCode(length = 6) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Функція ініціалізації користувача з повторними спробами
export async function initializeUser(userId, firstName, lastName, username, avatarUrl, maxAttempts = 3) {
  if (!isDatabaseReady()) {
    throw new Error('База даних не готова');
  }

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let client;
    try {
      client = await pool.connect();
      console.log(`Спроба ініціалізації користувача ${attempt}/${maxAttempts}`);

      await client.query('BEGIN');

      // Перевіряємо чи існує користувач
      let { rows: user } = await client.query(
        'SELECT * FROM users WHERE telegram_id = $1',
        [userId]
      );

      if (user.length === 0) {
        console.log('Створення нового користувача...');
        const referralCode = await generateUniqueReferralCode(client);
        const { rows: newUser } = await client.query(`
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
            referrals,
            created_at,
            last_active
          ) VALUES ($1, $2, $3, $4, $5, 0, 0, 'Новачок', $6, ARRAY[]::BIGINT[], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          RETURNING *
        `, [userId, firstName || null, lastName || null, username || null, referralCode, avatarUrl]);

        user = newUser;
        console.log('Новий користувач створений:', newUser[0]);
      } else {
        console.log('Оновлення існуючого користувача...');
        const { rows: updatedUser } = await client.query(`
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

      await client.query('COMMIT');

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
      lastError = error;
      console.error(`Помилка при ініціалізації користувача (спроба ${attempt}):`, error);

      if (client) {
        await client.query('ROLLBACK');
      }

      if (attempt === maxAttempts) {
        throw new Error(`Не вдалося ініціалізувати користувача після ${maxAttempts} спроб: ${error.message}`);
      }

      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    } finally {
      if (client) {
        client.release();
      }
    }
  }

  throw lastError;
}

// Генерація унікального реферального коду
async function generateUniqueReferralCode(client, maxAttempts = 10) {
  for (let i = 0; i < maxAttempts; i++) {
    const code = generateReferralCode();
    const { rows } = await client.query(
      'SELECT referral_code FROM users WHERE referral_code = $1',
      [code]
    );
    if (rows.length === 0) {
      return code;
    }
  }
  throw new Error('Не вдалося згенерувати унікальний реферальний код');
}

// Обробка реферального коду
export async function processReferral(referralCode, userId, maxAttempts = 3) {
  if (!isDatabaseReady()) {
    throw new Error('База даних не готова');
  }

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');

      console.log(`Обробка реферального коду: ${referralCode} для користувача ${userId}`);

      // Перевіряємо реферальний код
      const { rows: referrer } = await client.query(
        'SELECT * FROM users WHERE referral_code = $1',
        [referralCode]
      );

      if (referrer.length === 0) {
        throw new Error('Недійсний реферальний код');
      }

      // Перевіряємо чи користувач не використовує свій код
      if (referrer[0].telegram_id === userId) {
        throw new Error('Неможливо використати власний реферальний код');
      }

      // Перевіряємо чи користувач вже не був запрошений
      const { rows: user } = await client.query(
        'SELECT referred_by FROM users WHERE telegram_id = $1',
        [userId]
      );

      if (user[0].referred_by) {
        throw new Error('Користувач вже був запрошений');
      }

      const bonusCoins = 10;

      // Оновлюємо дані запрошеного користувача
      await client.query(`
        UPDATE users 
        SET 
          referred_by = $1,
          coins = coins + $2,
          total_coins = total_coins + $2
        WHERE telegram_id = $3
      `, [referrer[0].telegram_id, bonusCoins, userId]);

      // Оновлюємо дані запрошувача
      await client.query(`
        UPDATE users 
        SET 
          referrals = array_append(referrals, $1),
          coins = coins + $2,
          total_coins = total_coins + $2
        WHERE telegram_id = $3
      `, [userId, bonusCoins, referrer[0].telegram_id]);

      await client.query('COMMIT');

      return {
        success: true,
        message: 'Реферальний код успішно використано',
        bonusCoins
      };
    } catch (error) {
      lastError = error;
      if (client) {
        await client.query('ROLLBACK');
      }

      if (attempt === maxAttempts) {
        throw error;
      }

      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    } finally {
      if (client) {
        client.release();
      }
    }
  }

  throw lastError;
}

// Отримання даних користувача
export async function getUserData(userId) {
  if (!isDatabaseReady()) {
    throw new Error('База даних не готова');
  }

  let client;
  try {
    client = await pool.connect();

    // Оновлюємо last_active та отримуємо дані користувача
    const { rows: user } = await client.query(`
      UPDATE users 
      SET last_active = CURRENT_TIMESTAMP 
      WHERE telegram_id = $1 
      RETURNING *
    `, [userId]);

    if (user.length === 0) {
      throw new Error('Користувача не знайдено');
    }

    // Отримуємо дані про друзів
    const { rows: friends } = await client.query(`
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
  } finally {
    if (client) {
      client.release();
    }
  }
}

// Оновлення монет користувача
export async function updateUserCoins(userId, coinsToAdd) {
  if (!isDatabaseReady()) {
    throw new Error('База даних не готова');
  }

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // Перевіряємо чи існує користувач
    const { rows: user } = await client.query(
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
    const { rows: result } = await client.query(`
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

    await client.query('COMMIT');

    return {
      newCoins: result[0].coins,
      newTotalCoins: result[0].total_coins
    };
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    throw error;
  } finally {
    if (client) {
      client.release();
    }
  }
}