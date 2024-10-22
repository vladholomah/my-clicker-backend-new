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
      // Забезпечуємо, що first_name не буде null
      const sanitizedFirstName = firstName || '';
      const { rows: newUser } = await client.query(
        `INSERT INTO users 
         (telegram_id, first_name, last_name, username, referral_code, coins, total_coins, level, avatar, referrals) 
         VALUES ($1, $2, $3, $4, $5, 0, 0, $6, $7, $8) 
         RETURNING *`,
        [userId, sanitizedFirstName, lastName, username, referralCode, 'Новачок', avatarUrl, []]
      );
      console.log('Результат створення нового користувача:', JSON.stringify(newUser));
      user = newUser;
    } else {
      console.log('Користувач вже існує, оновлюємо дані');
      // Оновлюємо тільки якщо передані нові дані
      if (firstName || lastName || username || avatarUrl) {
        const updates = [];
        const values = [userId];
        let valueIndex = 2;

        if (firstName) {
          updates.push(`first_name = $${valueIndex}`);
          values.push(firstName);
          valueIndex++;
        }
        if (lastName !== undefined) {
          updates.push(`last_name = $${valueIndex}`);
          values.push(lastName);
          valueIndex++;
        }
        if (username !== undefined) {
          updates.push(`username = $${valueIndex}`);
          values.push(username);
          valueIndex++;
        }
        if (avatarUrl) {
          updates.push(`avatar = $${valueIndex}`);
          values.push(avatarUrl);
          valueIndex++;
        }

        if (updates.length > 0) {
          const { rows: updatedUser } = await client.query(
            `UPDATE users SET ${updates.join(', ')} WHERE telegram_id = $1 RETURNING *`,
            values
          );
          user = updatedUser;
        }
      }
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
      avatar: user[0].avatar
    };
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('Error during rollback:', rollbackError);
      }
    }
    console.error('Error initializing user:', error);
    throw error;
  } finally {
    if (client) {
      try {
        await client.release(true);
        console.log('Database connection released');
      } catch (releaseError) {
        console.error('Error releasing client:', releaseError);
      }
    }
  }
}

export async function processReferral(referralCode, userId) {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    console.log(`Processing referral: code=${referralCode}, userId=${userId}`);

    // Знаходимо користувача, який надав реферальний код
    const { rows: referrer } = await client.query('SELECT * FROM users WHERE referral_code = $1', [referralCode]);
    if (referrer.length === 0) {
      throw new Error('Invalid referral code');
    }

    // Перевіряємо, чи користувач не використовує свій власний код
    if (referrer[0].telegram_id === userId) {
      throw new Error('Cannot use own referral code');
    }

    // Перевіряємо, чи користувач вже не був зареєстрований за рефералом
    const { rows: user } = await client.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
    if (user[0].referred_by) {
      throw new Error('User already referred');
    }

    // Оновлюємо дані користувача, який був запрошений
    await client.query('UPDATE users SET referred_by = $1 WHERE telegram_id = $2', [referrer[0].telegram_id, userId]);

    // Додаємо нового реферала до списку рефералів запрошувача
    await client.query('UPDATE users SET referrals = array_append(referrals, $1) WHERE telegram_id = $2', [userId, referrer[0].telegram_id]);

    // Нараховуємо бонуси (наприклад, 10 монет) обом користувачам
    const bonusCoins = 10;
    await client.query('UPDATE users SET coins = coins + $1, total_coins = total_coins + $1 WHERE telegram_id IN ($2, $3)',
      [bonusCoins, referrer[0].telegram_id, userId]);

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