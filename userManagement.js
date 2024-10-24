import { pool } from './db.js';

function getLevelInfo(score) {
  if (score < 5000) return { name: 'Silver', reward: 1000 };
  if (score < 25000) return { name: 'Gold', reward: 10000 };
  if (score < 100000) return { name: 'Platinum', reward: 15000 };
  if (score < 1000000) return { name: 'Diamond', reward: 30000 };
  if (score < 2000000) return { name: 'Epic', reward: 50000 };
  return { name: 'Legendary', reward: 5000000 };
}

export async function updateUserCoins(userId, coinsToAdd) {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    console.log(`Updating coins for user ${userId}: adding ${coinsToAdd} coins`);

    // Отримуємо поточні дані користувача
    const { rows: currentUser } = await client.query(
      'SELECT coins, total_coins, level FROM users WHERE telegram_id = $1',
      [userId]
    );

    if (currentUser.length === 0) {
      throw new Error('User not found');
    }

    // Розраховуємо нові значення
    const newCoins = currentUser[0].coins + coinsToAdd;
    const newTotalCoins = currentUser[0].total_coins + coinsToAdd;

    // Визначаємо новий рівень на основі оновленого балансу
    const newLevelInfo = getLevelInfo(newCoins);

    // Оновлюємо дані користувача
    const { rows: result } = await client.query(`
      UPDATE users 
      SET coins = $1,
          total_coins = $2,
          level = CASE 
            WHEN level != $3 THEN $3
            ELSE level
          END
      WHERE telegram_id = $4
      RETURNING coins, total_coins, level
    `, [newCoins, newTotalCoins, newLevelInfo.name, userId]);

    console.log('User update result:', result[0]);

    // Якщо рівень змінився, додаємо бонус за новий рівень
    if (currentUser[0].level !== newLevelInfo.name) {
      console.log(`Level changed from ${currentUser[0].level} to ${newLevelInfo.name}. Adding reward: ${newLevelInfo.reward}`);

      const { rows: bonusResult } = await client.query(`
        UPDATE users
        SET coins = coins + $1,
            total_coins = total_coins + $1
        WHERE telegram_id = $2
        RETURNING coins, total_coins
      `, [newLevelInfo.reward, userId]);

      console.log('Bonus update result:', bonusResult[0]);

      // Повертаємо оновлені значення після бонусу
      result[0] = bonusResult[0];
    }

    await client.query('COMMIT');

    console.log('Transaction committed successfully');
    return {
      newCoins: result[0].coins,
      newTotalCoins: result[0].total_coins
    };
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
      console.log('Transaction rolled back due to error');
    }
    console.error('Error in updateUserCoins:', error);
    throw error;
  } finally {
    if (client) {
      client.release();
      console.log('Database client released');
    }
  }
}

// Existing functions with updated logging

export async function updateUserLevel(userId, newLevel) {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    console.log(`Updating level for user ${userId} to ${newLevel}`);

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
    console.log('Level update committed successfully:', result[0]);
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
    console.log('Starting user initialization for:', userId);

    let { rows: user } = await client.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
    console.log('Existing user check result:', user);

    if (user.length === 0) {
      console.log('Creating new user');
      const referralCode = generateReferralCode();
      const { rows: newUser } = await client.query(
        'INSERT INTO users (telegram_id, first_name, last_name, username, referral_code, coins, total_coins, level, avatar) VALUES ($1, $2, $3, $4, $5, 0, 0, $6, $7) RETURNING *',
        [userId, firstName || null, lastName || null, username || null, referralCode, 'Silver', avatarUrl]
      );
      console.log('New user created:', newUser[0]);
      user = newUser;
    } else {
      console.log('Updating existing user');
      const { rows: updatedUser } = await client.query(
        'UPDATE users SET first_name = $2, last_name = $3, username = $4, avatar = COALESCE($5, avatar) WHERE telegram_id = $1 RETURNING *',
        [userId, firstName || null, lastName || null, username || null, avatarUrl]
      );
      console.log('User updated:', updatedUser[0]);
      user = updatedUser;
    }

    const referralLink = `https://t.me/${process.env.BOT_USERNAME}?start=${user[0].referral_code}`;

    await client.query('COMMIT');
    console.log('User initialization completed successfully');

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
    if (client) {
      await client.query('ROLLBACK');
      console.log('Initialization rolled back due to error');
    }
    console.error('Error in initializeUser:', error);
    throw error;
  } finally {
    if (client) {
      client.release();
      console.log('Database client released');
    }
  }
}

// Helper function to generate referral code
function generateReferralCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

export async function processReferral(referralCode, userId) {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    console.log(`Processing referral: code=${referralCode} for user=${userId}`);

    const { rows: referrer } = await client.query('SELECT * FROM users WHERE referral_code = $1', [referralCode]);
    if (referrer.length === 0) {
      throw new Error('Invalid referral code');
    }

    const { rows: user } = await client.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
    if (user[0].referred_by) {
      throw new Error('User already referred');
    }

    console.log('Updating referred_by status');
    await client.query('UPDATE users SET referred_by = $1 WHERE telegram_id = $2',
      [referrer[0].telegram_id, userId]);

    console.log('Updating referrals array');
    await client.query('UPDATE users SET referrals = array_append(referrals, $1) WHERE telegram_id = $2',
      [userId, referrer[0].telegram_id]);

    console.log('Setting unclaimed rewards flags');
    await client.query(`
      UPDATE users 
      SET has_unclaimed_rewards = true 
      WHERE telegram_id IN ($1, $2)
    `, [referrer[0].telegram_id, userId]);

    await client.query('COMMIT');
    console.log('Referral processing completed successfully');

    return {
      success: true,
      message: 'Referral processed successfully',
      bonusCoins: 1000
    };
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
      console.log('Referral processing rolled back due to error');
    }
    console.error('Error in processReferral:', error);
    throw error;
  } finally {
    if (client) client.release();
  }
}

export async function getUserData(userId) {
  let client;
  try {
    client = await pool.connect();
    console.log(`Getting user data for userId: ${userId}`);

    const { rows: user } = await client.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
    if (user.length === 0) {
      throw new Error('User not found');
    }

    console.log('Found user:', user[0]);

    const { rows: friends } = await client.query(`
      SELECT telegram_id, first_name, last_name, username, coins, total_coins, level, avatar
      FROM users
      WHERE telegram_id = ANY($1)
    `, [user[0].referrals || []]);

    console.log(`Found ${friends.length} friends`);

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
    console.error('Error in getUserData:', error);
    throw error;
  } finally {
    if (client) {
      client.release();
      console.log('Database client released');
    }
  }
}