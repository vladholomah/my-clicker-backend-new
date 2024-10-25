import { pool } from './db.js';

// Оновлена функція для оновлення монет
export async function updateUserCoins(userId, coinsToAdd) {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // Отримуємо поточні дані користувача
    const { rows: currentData } = await client.query(
      'SELECT coins, total_coins FROM users WHERE telegram_id = $1',
      [userId]
    );

    if (currentData.length === 0) {
      throw new Error('User not found');
    }

    // Конвертуємо string в BigInt для безпечних обчислень
    const currentCoins = BigInt(currentData[0].coins);
    const currentTotalCoins = BigInt(currentData[0].total_coins);
    const coinsToAddBigInt = BigInt(coinsToAdd);

    // Обчислюємо нові значення
    const newCoins = currentCoins + coinsToAddBigInt;
    const newTotalCoins = currentTotalCoins + (coinsToAddBigInt > 0n ? coinsToAddBigInt : 0n);

    // Оновлюємо дані в БД
    const { rows: result } = await client.query(`
      UPDATE users 
      SET coins = $1, total_coins = $2
      WHERE telegram_id = $3 
      RETURNING coins, total_coins
    `, [newCoins.toString(), newTotalCoins.toString(), userId]);

    await client.query('COMMIT');

    console.log('Coins updated successfully:', {
      userId,
      oldCoins: currentCoins.toString(),
      newCoins: result[0].coins,
      oldTotalCoins: currentTotalCoins.toString(),
      newTotalCoins: result[0].total_coins
    });

    return {
      newCoins: result[0].coins,
      newTotalCoins: result[0].total_coins
    };
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    console.error('Error updating user coins:', error);
    throw error;
  } finally {
    if (client) client.release();
  }
}

// Функція для оновлення рівня
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

export async function initializeUser(userId, firstName, lastName, username, avatarUrl) {
  let client;
  try {
    client = await pool.connect();
    console.log('Connected to database for user initialization');
    await client.query('BEGIN');
    console.log('Спроба ініціалізації користувача:', userId);

    let { rows: user } = await client.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
    console.log('Результат SQL-запиту SELECT:', JSON.stringify(user));

    if (user.length === 0) {
      console.log('Користувача не знайдено, створюємо нового');
      const referralCode = generateReferralCode();
      const { rows: newUser } = await client.query(
        'INSERT INTO users (telegram_id, first_name, last_name, username, referral_code, coins, total_coins, level, avatar) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *',
        [userId, firstName || null, lastName || null, username || null, referralCode, '0', '0', 'Silver', avatarUrl]
      );
      console.log('Результат створення нового користувача:', JSON.stringify(newUser));
      user = newUser;
    } else {
      console.log('Користувач вже існує, оновлюємо дані');
      const { rows: updatedUser } = await client.query(
        'UPDATE users SET first_name = $2, last_name = $3, username = $4, avatar = COALESCE($5, avatar) WHERE telegram_id = $1 RETURNING *',
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
      coins: user[0].coins,
      totalCoins: user[0].total_coins,
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

export async function getUserData(userId) {
  let client;
  try {
    client = await pool.connect();
    console.log('Connected to database for getUserData');
    const { rows: user } = await client.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);

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
      coins: user[0].coins,
      totalCoins: user[0].total_coins,
      level: user[0].level,
      referralCode: user[0].referral_code,
      referralLink: referralLink,
      photoUrl: user[0].avatar,
      friends: friends.map(friend => ({
        telegramId: friend.telegram_id.toString(),
        firstName: friend.first_name,
        lastName: friend.last_name,
        username: friend.username,
        coins: friend.coins,
        totalCoins: friend.total_coins,
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

export async function processReferral(referralCode, userId) {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // Перевірка існування реферального коду
    const { rows: referrer } = await client.query(
      'SELECT telegram_id FROM users WHERE referral_code = $1',
      [referralCode]
    );

    if (referrer.length === 0) {
      throw new Error('Invalid referral code');
    }

    // Перевірка чи користувач вже використовував реферальний код
    const { rows: user } = await client.query(
      'SELECT referred_by FROM users WHERE telegram_id = $1',
      [userId]
    );

    if (user[0].referred_by) {
      throw new Error('User already referred');
    }

    // Оновлення даних користувача та реферера
    await client.query(
      'UPDATE users SET referred_by = $1 WHERE telegram_id = $2',
      [referrer[0].telegram_id, userId]
    );

    await client.query(
      'UPDATE users SET referrals = array_append(referrals, $1) WHERE telegram_id = $2',
      [userId, referrer[0].telegram_id]
    );

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

export default {
  updateUserCoins,
  updateUserLevel,
  initializeUser,
  getUserData,
  processReferral
};