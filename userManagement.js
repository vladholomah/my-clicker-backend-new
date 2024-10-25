import { pool } from './db.js';

function getLevelInfo(score) {
  const numScore = Number(score) || 0;
  if (numScore < 5000) return { name: 'Silver', reward: 1000 };
  if (numScore < 25000) return { name: 'Gold', reward: 10000 };
  if (numScore < 100000) return { name: 'Platinum', reward: 15000 };
  if (numScore < 1000000) return { name: 'Diamond', reward: 30000 };
  if (numScore < 2000000) return { name: 'Epic', reward: 50000 };
  return { name: 'Legendary', reward: 5000000 };
}

function generateReferralCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

export async function updateUserCoins(userId, coinsToAdd) {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    console.log(`Updating coins for user ${userId}: adding ${coinsToAdd} coins`);

    // Отримуємо поточні дані користувача
    const { rows: currentUser } = await client.query(`
      SELECT coins::text as coins, total_coins::text as total_coins 
      FROM users 
      WHERE telegram_id = $1::bigint
    `, [userId]);

    if (currentUser.length === 0) {
      throw new Error('User not found');
    }

    // Конвертуємо значення
    const currentCoins = parseInt(currentUser[0].coins || '0');
    const currentTotalCoins = parseInt(currentUser[0].total_coins || '0');
    const coinsToAddNum = parseInt(coinsToAdd.toString());

    console.log('Current values:', {
      currentCoins,
      currentTotalCoins,
      coinsToAddNum
    });

    // Розраховуємо нові значення
    const newCoins = currentCoins + coinsToAddNum;
    const newTotalCoins = currentTotalCoins + coinsToAddNum;

    console.log('New values:', { newCoins, newTotalCoins });

    // Оновлюємо значення в базі даних
    const { rows: result } = await client.query(`
      UPDATE users 
      SET 
        coins = $1::bigint,
        total_coins = $2::bigint
      WHERE telegram_id = $3::bigint
      RETURNING coins::text as coins, total_coins::text as total_coins
    `, [newCoins, newTotalCoins, userId]);

    await client.query('COMMIT');

    console.log('Update result:', result[0]);

    return {
      newCoins: result[0].coins,
      newTotalCoins: result[0].total_coins
    };
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
      console.error('Transaction rolled back:', error);
    }
    throw error;
  } finally {
    if (client) client.release();
  }
}

export async function initializeUser(userId, firstName, lastName, username, avatarUrl) {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    console.log('Starting user initialization:', { userId, firstName });

    let { rows: user } = await client.query(
      'SELECT * FROM users WHERE telegram_id = $1::bigint',
      [userId]
    );

    if (user.length === 0) {
      console.log('Creating new user');
      const referralCode = generateReferralCode();

      // Створюємо нового користувача з явними типами даних
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
          has_unclaimed_rewards
        ) 
        VALUES (
          $1::bigint,
          $2,
          $3,
          $4,
          $5,
          0::bigint,
          0::bigint,
          'Silver',
          $6,
          ARRAY[]::bigint[],
          false
        )
        RETURNING *
      `, [
        userId,
        firstName || 'User',
        lastName || null,
        username || null,
        referralCode,
        avatarUrl
      ]);

      console.log('New user created:', newUser[0]);
      user = newUser;
    } else {
      console.log('Updating existing user');
      const { rows: updatedUser } = await client.query(`
        UPDATE users 
        SET 
          first_name = COALESCE($2, first_name),
          last_name = $3,
          username = $4,
          avatar = COALESCE($5, avatar)
        WHERE telegram_id = $1::bigint
        RETURNING *
      `, [userId, firstName, lastName, username, avatarUrl]);

      console.log('User updated:', updatedUser[0]);
      user = updatedUser;
    }

    await client.query('COMMIT');

    const response = {
      telegramId: user[0].telegram_id.toString(),
      firstName: user[0].first_name,
      lastName: user[0].last_name,
      username: user[0].username,
      coins: user[0].coins ? user[0].coins.toString() : '0',
      totalCoins: user[0].total_coins ? user[0].total_coins.toString() : '0',
      referralCode: user[0].referral_code,
      referralLink: `https://t.me/${process.env.BOT_USERNAME}?start=${user[0].referral_code}`,
      level: user[0].level || 'Silver',
      photoUrl: user[0].avatar,
      hasUnclaimedRewards: user[0].has_unclaimed_rewards || false,
      referrals: user[0].referrals || []
    };

    console.log('Returning user data:', response);
    return response;
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
      console.error('Error in initializeUser:', error);
    }
    throw error;
  } finally {
    if (client) client.release();
  }
}

export async function updateUserLevel(userId, newLevel) {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const { rows: result } = await client.query(`
      UPDATE users 
      SET level = $1
      WHERE telegram_id = $2::bigint 
      RETURNING level, coins::text, total_coins::text
    `, [newLevel, userId]);

    if (result.length === 0) {
      throw new Error('User not found');
    }

    await client.query('COMMIT');
    return result[0];
  } catch (error) {
    if (client) await client.query('ROLLBACK');
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

    // Знаходимо користувача, який запросив
    const { rows: referrer } = await client.query(
      'SELECT * FROM users WHERE referral_code = $1',
      [referralCode]
    );

    if (referrer.length === 0) {
      throw new Error('Invalid referral code');
    }

    // Перевіряємо чи користувач вже був запрошений
    const { rows: user } = await client.query(
      'SELECT * FROM users WHERE telegram_id = $1::bigint',
      [userId]
    );

    if (user[0].referred_by) {
      throw new Error('User already referred');
    }

    // Оновлюємо дані запрошеного користувача
    await client.query(`
      UPDATE users 
      SET 
        referred_by = $1::bigint,
        has_unclaimed_rewards = true
      WHERE telegram_id = $2::bigint
    `, [referrer[0].telegram_id, userId]);

    // Оновлюємо дані користувача, який запросив
    await client.query(`
      UPDATE users 
      SET 
        referrals = array_append(referrals, $1::bigint),
        has_unclaimed_rewards = true
      WHERE telegram_id = $2::bigint
    `, [userId, referrer[0].telegram_id]);

    await client.query('COMMIT');

    return {
      success: true,
      message: 'Referral processed successfully',
      bonusCoins: 1000
    };
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    throw error;
  } finally {
    if (client) client.release();
  }
}

export async function getUserData(userId) {
  let client;
  try {
    client = await pool.connect();

    // Отримуємо дані користувача
    const { rows: user } = await client.query(`
      SELECT 
        telegram_id,
        first_name,
        last_name,
        username,
        coins::text,
        total_coins::text,
        level,
        referral_code,
        avatar,
        referrals,
        has_unclaimed_rewards
      FROM users 
      WHERE telegram_id = $1::bigint
    `, [userId]);

    if (user.length === 0) {
      throw new Error('User not found');
    }

    // Отримуємо дані друзів
    const { rows: friends } = await client.query(`
      SELECT 
        telegram_id,
        first_name,
        last_name,
        username,
        coins::text as coins,
        total_coins::text as total_coins,
        level,
        avatar
      FROM users
      WHERE telegram_id = ANY($1::bigint[])
    `, [user[0].referrals || []]);

    return {
      telegramId: user[0].telegram_id.toString(),
      firstName: user[0].first_name,
      lastName: user[0].last_name,
      username: user[0].username,
      coins: user[0].coins || '0',
      totalCoins: user[0].total_coins || '0',
      level: user[0].level,
      referralCode: user[0].referral_code,
      referralLink: `https://t.me/${process.env.BOT_USERNAME}?start=${user[0].referral_code}`,
      photoUrl: user[0].avatar,
      hasUnclaimedRewards: user[0].has_unclaimed_rewards,
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
    throw error;
  } finally {
    if (client) client.release();
  }
}