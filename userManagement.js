import { pool } from './db.js';

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
        'INSERT INTO users (telegram_id, first_name, last_name, username, referral_code, coins, total_coins, level, avatar) VALUES ($1, $2, $3, $4, $5, 0, 0, $6, $7) RETURNING *',
        [userId, firstName || null, lastName || null, username || null, referralCode, 'Новачок', avatarUrl]
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

export async function updateUserLevel(userId, coins) {
  let client;
  try {
    client = await pool.connect();
    console.log('Updating user level for userId:', userId, 'coins:', coins);

    // Визначаємо рівень на основі кількості монет
    let newLevel = 'Новачок';
    if (coins >= 2000000) newLevel = 'Legendary';
    else if (coins >= 1000000) newLevel = 'Epic';
    else if (coins >= 100000) newLevel = 'Diamond';
    else if (coins >= 25000) newLevel = 'Platinum';
    else if (coins >= 5000) newLevel = 'Gold';
    else if (coins > 0) newLevel = 'Silver';

    // Оновлюємо рівень в базі даних
    const { rows } = await client.query(
      'UPDATE users SET level = $1 WHERE telegram_id = $2 RETURNING *',
      [newLevel, userId]
    );

    console.log('User level updated successfully:', newLevel);
    return rows[0];
  } catch (error) {
    console.error('Error updating user level:', error);
    throw error;
  } finally {
    if (client) {
      client.release();
      console.log('Database connection released after level update');
    }
  }
}

export async function processReferral(referralCode, userId) {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    console.log(`Processing referral: code=${referralCode}, userId=${userId}`);

    const { rows: referrer } = await client.query('SELECT * FROM users WHERE referral_code = $1', [referralCode]);
    if (referrer.length === 0) {
      throw new Error('Invalid referral code');
    }

    if (referrer[0].telegram_id === userId) {
      throw new Error('Cannot use own referral code');
    }

    const { rows: user } = await client.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
    if (user[0].referred_by) {
      throw new Error('User already referred');
    }

    await client.query('UPDATE users SET referred_by = $1 WHERE telegram_id = $2', [referrer[0].telegram_id, userId]);
    await client.query('UPDATE users SET referrals = array_append(referrals, $1) WHERE telegram_id = $2', [userId, referrer[0].telegram_id]);

    const bonusCoins = 1000;
    await client.query('UPDATE users SET coins = coins + $1, total_coins = total_coins + $1 WHERE telegram_id IN ($2, $3)',
      [bonusCoins, referrer[0].telegram_id, userId]);

    // Оновлюємо рівні обох користувачів після нарахування бонусів
    const { rows: updatedReferrer } = await client.query('SELECT coins FROM users WHERE telegram_id = $1', [referrer[0].telegram_id]);
    const { rows: updatedUser } = await client.query('SELECT coins FROM users WHERE telegram_id = $1', [userId]);

    await updateUserLevel(referrer[0].telegram_id, updatedReferrer[0].coins);
    await updateUserLevel(userId, updatedUser[0].coins);

    await client.query('COMMIT');
    console.log('Referral processed successfully');
    return { success: true, message: 'Referral processed successfully', bonusCoins };
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    console.error('Error processing referral:', error);
    throw error;
  } finally {
    if (client) client.release();
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

export async function updateUserCoins(userId, coinsToAdd) {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // Оновлюємо монети
    const { rows: result } = await client.query(`
      UPDATE users
      SET coins = coins + $1, total_coins = total_coins + $1
      WHERE telegram_id = $2
      RETURNING coins, total_coins
    `, [coinsToAdd, userId]);

    if (result.length === 0) {
      throw new Error('User not found');
    }

    // Оновлюємо рівень користувача
    await updateUserLevel(userId, result[0].coins);

    await client.query('COMMIT');
    console.log('Coins and level updated successfully');
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

function generateReferralCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}