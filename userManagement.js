import { pool } from './db.js';

// Функція для оновлення рівня користувача
export async function updateUserLevel(userId, newLevel) {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const { rows: result } = await client.query(`
      UPDATE users 
      SET level = $1
      WHERE telegram_id = $2 
      RETURNING level, coins, total_coins
    `, [newLevel, userId]);

    if (result.length === 0) {
      throw new Error('User not found');
    }

    await client.query('COMMIT');
    return result[0];
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    console.error('Error updating user level:', error);
    throw error;
  } finally {
    if (client) client.release();
  }
}

// Оновлена функція ініціалізації користувача з атомарними операціями
export async function initializeUser(userId, firstName, lastName, username, avatarUrl) {
  let client;
  try {
    client = await pool.connect();
    console.log('Connected to database for user initialization');
    await client.query('BEGIN');
    console.log('Спроба ініціалізації користувача:', userId);

    let { rows: user } = await client.query('SELECT * FROM users WHERE telegram_id = $1 FOR UPDATE', [userId]);
    console.log('Результат SQL-запиту SELECT:', JSON.stringify(user));

    if (user.length === 0) {
      console.log('Користувача не знайдено, створюємо нового');
      const referralCode = generateReferralCode();
      const { rows: newUser } = await client.query(
        `INSERT INTO users (
          telegram_id, 
          first_name, 
          last_name, 
          username, 
          referral_code, 
          coins, 
          total_coins, 
          level, 
          avatar,
          last_balance_update
        ) VALUES ($1, $2, $3, $4, $5, 0, 0, $6, $7, NOW()) 
        RETURNING *`,
        [userId, firstName || null, lastName || null, username || null, referralCode, 'Silver', avatarUrl]
      );
      console.log('Результат створення нового користувача:', JSON.stringify(newUser));
      user = newUser;
    } else {
      console.log('Користувач вже існує, оновлюємо дані');
      const { rows: updatedUser } = await client.query(
        `UPDATE users 
         SET first_name = $2, 
             last_name = $3, 
             username = $4, 
             avatar = COALESCE($5, avatar),
             last_balance_update = NOW()
         WHERE telegram_id = $1 
         RETURNING *`,
        [userId, firstName || null, lastName || null, username || null, avatarUrl]
      );
      user = updatedUser;
    }

    const referralLink = `https://t.me/${process.env.BOT_USERNAME}?start=${user[0].referral_code}`;

    await client.query('COMMIT');
    console.log('Transaction committed');

    return {
      telegramId: user[0].telegram_id.toString(),
      firstName: user[0].first_name,
      lastName: user[0].last_name,
      username: user[0].username,
      referralCode: user[0].referral_code,
      referralLink: referralLink,
      coins: user[0].coins.toString(),
      totalCoins: user[0].total_coins.toString(),
      level: user[0].level,
      photoUrl: user[0].avatar
    };
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    console.error('Error initializing user:', error);
    throw error;
  } finally {
    if (client) {
      client.release();
      console.log('Database connection released');
    }
  }
}

// Оновлена функція оновлення монет з оптимістичним блокуванням
export async function updateUserCoins(userId, coinsToAdd) {
  let client;
  let retries = 3;

  while (retries > 0) {
    try {
      client = await pool.connect();
      await client.query('BEGIN');

      // Отримуємо поточний стан з блокуванням
      const { rows: currentState } = await client.query(
        'SELECT coins, total_coins, last_balance_update FROM users WHERE telegram_id = $1 FOR UPDATE',
        [userId]
      );

      if (currentState.length === 0) {
        throw new Error('User not found');
      }

      // Перевіряємо чи не було конфліктуючих оновлень
      const newCoins = parseInt(currentState[0].coins) + parseInt(coinsToAdd);
      const newTotalCoins = parseInt(currentState[0].total_coins) + (coinsToAdd > 0 ? parseInt(coinsToAdd) : 0);

      if (newCoins < 0) {
        throw new Error('Insufficient coins');
      }

      // Оновлюємо баланс
      const { rows: result } = await client.query(`
        UPDATE users 
        SET coins = $1, 
            total_coins = $2,
            last_balance_update = NOW()
        WHERE telegram_id = $3 
        RETURNING coins, total_coins
      `, [newCoins, newTotalCoins, userId]);

      await client.query('COMMIT');

      return {
        success: true,
        newCoins: result[0].coins.toString(),
        newTotalCoins: result[0].total_coins.toString()
      };
    } catch (error) {
      if (client) await client.query('ROLLBACK');

      if (error.message === 'User not found' || error.message === 'Insufficient coins') {
        throw error;
      }

      retries--;
      if (retries === 0) {
        console.error('Failed to update coins after all retries:', error);
        throw error;
      }

      console.log(`Retrying update coins operation. Attempts left: ${retries}`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    } finally {
      if (client) client.release();
    }
  }
}

// Оновлена функція обробки реферальних кодів
export async function processReferral(referralCode, userId) {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const { rows: referrer } = await client.query(
      'SELECT * FROM users WHERE referral_code = $1 FOR UPDATE',
      [referralCode]
    );

    if (referrer.length === 0) {
      throw new Error('Invalid referral code');
    }

    const { rows: user } = await client.query(
      'SELECT * FROM users WHERE telegram_id = $1 FOR UPDATE',
      [userId]
    );

    if (user[0].referred_by) {
      throw new Error('User already referred');
    }

    // Оновлюємо статус referred_by для нового користувача
    await client.query(
      'UPDATE users SET referred_by = $1 WHERE telegram_id = $2',
      [referrer[0].telegram_id, userId]
    );

    // Додаємо нового користувача до списку рефералів
    await client.query(
      'UPDATE users SET referrals = array_append(referrals, $1) WHERE telegram_id = $2',
      [userId, referrer[0].telegram_id]
    );

    // Встановлюємо has_unclaimed_rewards для обох користувачів
    await client.query(`
      UPDATE users 
      SET has_unclaimed_rewards = true,
          last_balance_update = NOW()
      WHERE telegram_id IN ($1, $2)
    `, [referrer[0].telegram_id, userId]);

    await client.query('COMMIT');

    return {
      success: true,
      message: 'Referral processed successfully',
      bonusCoins: '1000'
    };
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    console.error('Error processing referral:', error);
    throw error;
  } finally {
    if (client) client.release();
  }
}

// Оновлена функція отримання даних користувача
export async function getUserData(userId) {
  let client;
  try {
    client = await pool.connect();
    console.log('Connected to database for getUserData');

    const { rows: user } = await client.query(`
      SELECT *,
             EXTRACT(EPOCH FROM (NOW() - last_balance_update)) as time_since_last_update
      FROM users 
      WHERE telegram_id = $1
    `, [userId]);

    if (user.length === 0) {
      throw new Error('User not found');
    }

    const { rows: friends } = await client.query(`
      SELECT telegram_id, first_name, last_name, username, coins, total_coins, level, avatar
      FROM users
      WHERE telegram_id = ANY($1)
    `, [user[0].referrals || []]);

    const referralLink = `https://t.me/${process.env.BOT_USERNAME}?start=${user[0].referral_code}`;

    return {
      telegramId: user[0].telegram_id.toString(),
      firstName: user[0].first_name,
      lastName: user[0].last_name,
      username: user[0].username,
      coins: user[0].coins.toString(),
      totalCoins: user[0].total_coins.toString(),
      level: user[0].level,
      referralCode: user[0].referral_code,
      referralLink: referralLink,
      photoUrl: user[0].avatar,
      lastBalanceUpdate: user[0].last_balance_update,
      timeSinceLastUpdate: user[0].time_since_last_update,
      friends: friends.map(friend => ({
        telegramId: friend.telegram_id.toString(),
        firstName: friend.first_name,
        lastName: friend.last_name,
        username: friend.username,
        coins: friend.coins.toString(),
        totalCoins: friend.total_coins.toString(),
        level: friend.level,
        photoUrl: friend.avatar
      }))
    };
  } catch (error) {
    console.error('Error fetching user data:', error);
    throw error;
  } finally {
    if (client) {
      client.release();
      console.log('Database connection released');
    }
  }
}

function generateReferralCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

export default {
  updateUserLevel,
  initializeUser,
  updateUserCoins,
  processReferral,
  getUserData
};