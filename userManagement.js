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
        [userId, firstName || null, lastName || null, username || null, referralCode, 'Silver', avatarUrl]
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

export async function createReferralReward(referrerId, referredId) {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const { rows } = await client.query(`
      INSERT INTO referral_rewards 
      (referrer_id, referred_id, reward_amount, is_claimed) 
      VALUES ($1, $2, 1000, FALSE)
      ON CONFLICT (referrer_id, referred_id) DO NOTHING
      RETURNING *
    `, [referrerId, referredId]);

    await client.query('COMMIT');
    return rows[0];
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    console.error('Error creating referral reward:', error);
    throw error;
  } finally {
    if (client) client.release();
  }
}

export async function getUnclaimedRewards(userId) {
  let client;
  try {
    client = await pool.connect();
    const { rows } = await client.query(`
      SELECT 
        rr.*,
        u.first_name,
        u.last_name,
        u.username
      FROM referral_rewards rr
      JOIN users u ON u.telegram_id = rr.referred_id
      WHERE rr.referrer_id = $1 
      AND rr.is_claimed = FALSE
    `, [userId]);

    return rows.map(row => ({
      id: row.id,
      referredUser: {
        id: row.referred_id,
        name: [row.first_name, row.last_name].filter(Boolean).join(' '),
        username: row.username
      },
      amount: row.reward_amount,
      createdAt: row.created_at
    }));
  } catch (error) {
    console.error('Error getting unclaimed rewards:', error);
    throw error;
  } finally {
    if (client) client.release();
  }
}

export async function claimReward(userId, rewardId) {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const { rows: rewards } = await client.query(`
      SELECT * FROM referral_rewards 
      WHERE id = $1 AND referrer_id = $2 AND is_claimed = FALSE
    `, [rewardId, userId]);

    if (rewards.length === 0) {
      throw new Error('Reward not found or already claimed');
    }

    await client.query(`
      UPDATE referral_rewards 
      SET is_claimed = TRUE, claimed_at = CURRENT_TIMESTAMP 
      WHERE id = $1
    `, [rewardId]);

    const { rows: updatedUser } = await client.query(`
      UPDATE users 
      SET coins = coins + $1, total_coins = total_coins + $1 
      WHERE telegram_id = $2 
      RETURNING coins, total_coins
    `, [rewards[0].reward_amount, userId]);

    await client.query('COMMIT');
    return {
      success: true,
      claimedAmount: rewards[0].reward_amount,
      newBalance: updatedUser[0].coins
    };
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    console.error('Error claiming reward:', error);
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

    await createReferralReward(referrer[0].telegram_id, userId);

    await client.query('COMMIT');
    console.log('Referral processed successfully');
    return { success: true, message: 'Referral processed successfully', bonusCoins: 1000 };
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

    const userResult = await client.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
    const user = userResult.rows[0];

    if (!user) {
      throw new Error('User not found');
    }

    const [friendsResult, rewardsResult] = await Promise.all([
      client.query(`
        SELECT telegram_id, first_name, last_name, username, coins, total_coins, level, avatar
        FROM users
        WHERE telegram_id = ANY($1)
      `, [user.referrals || []]),
      client.query(`
        SELECT COUNT(*) as count
        FROM referral_rewards
        WHERE referrer_id = $1 AND is_claimed = FALSE
      `, [userId])
    ]);

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
      referralLink: referralLink,
      photoUrl: user.avatar,
      hasUnclaimedRewards: rewardsResult.rows[0].count > 0,
      friends: friendsResult.rows.map(friend => ({
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
    if (client) client.release();
  }
}

// Додаємо нову функцію updateUserLevel
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