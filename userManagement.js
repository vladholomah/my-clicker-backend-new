import { pool } from './db.js';

// New function for level updates
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

export async function processReferral(referralCode, userId) {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    console.log(`Processing referral: code=${referralCode}, userId=${userId}`);

    // Перевірка існування реферера (того, хто запросив)
    const { rows: referrer } = await client.query('SELECT * FROM users WHERE referral_code = $1', [referralCode]);
    if (referrer.length === 0) {
      throw new Error('Invalid referral code');
    }

    // Перевірка чи користувач не використовує свій власний код
    if (referrer[0].telegram_id === userId) {
      throw new Error('Cannot use own referral code');
    }

    // Перевірка чи користувач вже не був запрошений
    const { rows: user } = await client.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
    if (user[0].referred_by) {
      throw new Error('User already referred');
    }

    // Оновлення зв'язків між користувачами
    await client.query('UPDATE users SET referred_by = $1 WHERE telegram_id = $2',
      [referrer[0].telegram_id, userId]);

    await client.query('UPDATE users SET referrals = array_append(referrals, $1) WHERE telegram_id = $2',
      [userId, referrer[0].telegram_id]);

    // Нарахування бонусних монет обом користувачам
    const bonusCoins = 1000;

    // Оновлення монет для обох користувачів
    const { rows: updatedReferrer } = await client.query(`
      UPDATE users 
      SET coins = coins + $1, total_coins = total_coins + $1 
      WHERE telegram_id = $2 
      RETURNING coins, total_coins`,
      [bonusCoins, referrer[0].telegram_id]
    );

    const { rows: updatedUser } = await client.query(`
      UPDATE users 
      SET coins = coins + $1, total_coins = total_coins + $1 
      WHERE telegram_id = $2 
      RETURNING coins, total_coins`,
      [bonusCoins, userId]
    );

    await client.query('COMMIT');

    console.log('Referral processed successfully');
    return {
      success: true,
      message: 'Referral processed successfully',
      bonusCoins,
      referrerNewBalance: updatedReferrer[0].coins,
      userNewBalance: updatedUser[0].coins,
      referrerTotalCoins: updatedReferrer[0].total_coins,
      userTotalCoins: updatedUser[0].total_coins
    };

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

    // Отримуємо оновлені дані користувача після всіх транзакцій
    const { rows: user } = await client.query(`
      SELECT 
        telegram_id, 
        first_name, 
        last_name, 
        username, 
        coins, 
        total_coins, 
        level, 
        referral_code,
        referrals,
        avatar
      FROM users 
      WHERE telegram_id = $1
    `, [userId]);

    if (user.length === 0) {
      throw new Error('User not found');
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
        avatar
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
    const { rows: result } = await client.query(`
      UPDATE users
      SET coins = coins + $1, total_coins = total_coins + $1
      WHERE telegram_id = $2
      RETURNING coins, total_coins
    `, [coinsToAdd, userId]);

    if (result.length === 0) {
      throw new Error('User not found');
    }

    await client.query('COMMIT');
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