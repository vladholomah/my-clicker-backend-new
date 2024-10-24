import { pool } from './db.js';

// Додаємо нові функції для роботи з винагородами

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

    // Перевіряємо та отримуємо винагороду
    const { rows: rewards } = await client.query(`
      SELECT * FROM referral_rewards 
      WHERE id = $1 AND referrer_id = $2 AND is_claimed = FALSE
    `, [rewardId, userId]);

    if (rewards.length === 0) {
      throw new Error('Reward not found or already claimed');
    }

    // Оновлюємо статус винагороди
    await client.query(`
      UPDATE referral_rewards 
      SET is_claimed = TRUE, claimed_at = CURRENT_TIMESTAMP 
      WHERE id = $1
    `, [rewardId]);

    // Додаємо монети користувачу
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

// Оновлюємо існуючу функцію processReferral
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

    // Створюємо запис про винагороду
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

// Оновлюємо функцію getUserData щоб включити інформацію про невитребувані винагороди
export async function getUserData(userId) {
  let client;
  try {
    client = await pool.connect();

    const [userResult, friendsResult, rewardsResult] = await Promise.all([
      client.query('SELECT * FROM users WHERE telegram_id = $1', [userId]),
      client.query(`
        SELECT telegram_id, first_name, last_name, username, coins, total_coins, level, avatar
        FROM users
        WHERE telegram_id = ANY($1)
      `, [userResult.rows[0].referrals || []]),
      client.query(`
        SELECT COUNT(*) as count
        FROM referral_rewards
        WHERE referrer_id = $1 AND is_claimed = FALSE
      `, [userId])
    ]);

    const user = userResult.rows[0];
    if (!user) {
      throw new Error('User not found');
    }

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