import { pool } from './db.js';
import dotenv from 'dotenv';

dotenv.config();

export async function initializeUser(userId, firstName, lastName, username, avatarUrl) {
  let client;
  try {
    client = await pool.connect();
    console.log('Connected to database for user initialization');
    await client.query('BEGIN');
    console.log('Спроба ініціалізації користувача:', userId);

    const { rows: existingUsers } = await client.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
    console.log('Результат SQL-запиту SELECT:', JSON.stringify(existingUsers));

    let result;
    if (existingUsers.length === 0) {
      console.log('Користувача не знайдено, створюємо нового');
      const referralCode = generateReferralCode();
      const { rows: newUser } = await client.query(
        'INSERT INTO users (telegram_id, first_name, last_name, username, referral_code, coins, total_coins, level, avatar) VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8) RETURNING *',
        [userId, firstName, lastName, username, referralCode, 0, 'Новачок', avatarUrl]
      );
      result = newUser[0];
    } else {
      console.log('Користувач вже існує, оновлюємо дані');
      const { rows: updatedUser } = await client.query(
        'UPDATE users SET first_name = $2, last_name = $3, username = $4, avatar = $5 WHERE telegram_id = $1 RETURNING *',
        [userId, firstName, lastName, username, avatarUrl]
      );
      result = updatedUser[0];
    }

    const referralLink = `https://t.me/${process.env.BOT_USERNAME}?start=${result.referral_code}`;

    await client.query('COMMIT');
    console.log('Transaction committed');

    return {
      telegramId: result.telegram_id.toString(),
      firstName: result.first_name,
      lastName: result.last_name,
      username: result.username,
      referralCode: result.referral_code,
      referralLink,
      coins: result.coins,
      totalCoins: result.total_coins,
      level: result.level,
      avatar: result.avatar
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

export async function processReferral(referralCode, userId) {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    console.log(`Processing referral: code=${referralCode}, userId=${userId}`);

    const { rows: referrers } = await client.query('SELECT * FROM users WHERE referral_code = $1', [referralCode]);
    if (referrers.length === 0) {
      throw new Error('Invalid referral code');
    }
    const referrer = referrers[0];

    if (referrer.telegram_id === userId) {
      throw new Error('Cannot use own referral code');
    }

    const { rows: users } = await client.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
    if (users[0].referred_by) {
      throw new Error('User already referred');
    }

    await client.query('UPDATE users SET referred_by = $1 WHERE telegram_id = $2', [referrer.telegram_id, userId]);
    await client.query('UPDATE users SET referrals = array_append(referrals, $1) WHERE telegram_id = $2', [userId, referrer.telegram_id]);

    const bonusCoins = 10;
    await client.query('UPDATE users SET coins = coins + $1, total_coins = total_coins + $1 WHERE telegram_id IN ($2, $3)',
      [bonusCoins, referrer.telegram_id, userId]);

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
    const { rows: users } = await client.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
    if (users.length === 0) {
      throw new Error('User not found');
    }
    const user = users[0];

    const { rows: friends } = await client.query(`
      SELECT telegram_id, first_name, last_name, username, coins, total_coins, level, avatar
      FROM users
      WHERE telegram_id = ANY($1)
    `, [user.referrals || []]);

    const referralLink = `https://t.me/${process.env.BOT_USERNAME}?start=${user.referral_code}`;

    return {
      telegramId: user.telegram_id.toString(),
      firstName: user.first_name,
      lastName: user.last_name,
      username: user.username,
      coins: user.coins,
      totalCoins: user.total_coins,
      level: user.level,
      referralCode: user.referral_code,
      referralLink,
      avatar: user.avatar,
      friends: friends.map(friend => ({
        telegramId: friend.telegram_id.toString(),
        firstName: friend.first_name,
        lastName: friend.last_name,
        username: friend.username,
        coins: friend.coins,
        totalCoins: friend.total_coins,
        level: friend.level,
        avatar: friend.avatar
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
    if (client) {
      client.release();
    }
  }
}

function generateReferralCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}