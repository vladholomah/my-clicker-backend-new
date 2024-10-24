import { pool } from './db.js';

export async function initializeUser(userId, firstName, lastName, username, avatarUrl) {
  let client;
  try {
    client = await pool.connect();
    console.log('Connected to database for user initialization');
    await client.query('BEGIN');
    console.log('Attempting to initialize user:', userId);

    let { rows: user } = await client.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
    console.log('SQL SELECT result:', JSON.stringify(user));

    if (user.length === 0) {
      console.log('User not found, creating new user');
      const referralCode = generateReferralCode();
      const { rows: newUser } = await client.query(
        'INSERT INTO users (telegram_id, first_name, last_name, username, referral_code, coins, total_coins, level, avatar, referrals) VALUES ($1, $2, $3, $4, $5, 0, 0, $6, $7, ARRAY[]::bigint[]) RETURNING *',
        [userId, firstName || null, lastName || null, username || null, referralCode, 'Silver', avatarUrl]
      );
      console.log('New user creation result:', JSON.stringify(newUser));
      user = newUser;
    } else {
      console.log('User exists, updating data');
      const { rows: updatedUser } = await client.query(
        'UPDATE users SET first_name = $2, last_name = $3, username = $4, avatar = COALESCE($5, avatar) WHERE telegram_id = $1 RETURNING *',
        [userId, firstName || null, lastName || null, username || null, avatarUrl]
      );
      user = updatedUser;
    }

    const referralLink = `https://t.me/${process.env.BOT_USERNAME}?start=${user[0].referral_code}`;

    await client.query('COMMIT');
    console.log('Transaction committed successfully');

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
      console.error('Transaction rolled back due to error:', error);
    }
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
    console.log(`Creating referral reward: referrerId=${referrerId}, referredId=${referredId}`);

    const { rows } = await client.query(`
      INSERT INTO referral_rewards 
      (referrer_id, referred_id, reward_amount, is_claimed) 
      VALUES ($1, $2, 1000, FALSE)
      ON CONFLICT (referrer_id, referred_id) DO NOTHING
      RETURNING *
    `, [referrerId, referredId]);

    await client.query('COMMIT');
    console.log('Referral reward created:', rows[0]);
    return rows[0];
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
      console.error('Error creating referral reward:', error);
    }
    throw error;
  } finally {
    if (client) {
      client.release();
      console.log('Database connection released');
    }
  }
}

export async function getUnclaimedRewards(userId) {
  let client;
  try {
    client = await pool.connect();
    console.log(`Getting unclaimed rewards for userId: ${userId}`);

    const { rows } = await client.query(`
      SELECT 
        rr.id,
        rr.referrer_id,
        rr.referred_id,
        rr.reward_amount,
        rr.created_at,
        u.first_name,
        u.last_name,
        u.username
      FROM referral_rewards rr
      JOIN users u ON u.telegram_id = rr.referred_id
      WHERE rr.referrer_id = $1 
      AND rr.is_claimed = FALSE
      ORDER BY rr.created_at DESC
    `, [userId]);

    console.log(`Found ${rows.length} unclaimed rewards`);

    return rows.map(row => ({
      id: row.id,
      referredUser: {
        id: row.referred_id.toString(),
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
    if (client) {
      client.release();
      console.log('Database connection released');
    }
  }
}

export async function claimReward(userId, rewardId) {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    console.log(`Claiming reward: userId=${userId}, rewardId=${rewardId}`);

    // Перевіряємо і отримуємо винагороду
    const { rows: rewards } = await client.query(`
      SELECT * FROM referral_rewards 
      WHERE id = $1 AND referrer_id = $2 AND is_claimed = FALSE
      FOR UPDATE
    `, [rewardId, userId]);

    if (rewards.length === 0) {
      throw new Error('Reward not found or already claimed');
    }

    // Позначаємо винагороду як отриману
    await client.query(`
      UPDATE referral_rewards 
      SET is_claimed = TRUE, 
          claimed_at = CURRENT_TIMESTAMP 
      WHERE id = $1
    `, [rewardId]);

    // Оновлюємо баланс користувача
    const { rows: updatedUser } = await client.query(`
      UPDATE users 
      SET coins = coins + $1, 
          total_coins = total_coins + $1 
      WHERE telegram_id = $2 
      RETURNING coins, total_coins
    `, [rewards[0].reward_amount, userId]);

    await client.query('COMMIT');
    console.log('Reward claimed successfully');

    return {
      success: true,
      claimedAmount: rewards[0].reward_amount,
      newBalance: updatedUser[0].coins,
      newTotalCoins: updatedUser[0].total_coins
    };
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
      console.error('Error claiming reward:', error);
    }
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

    // Знаходимо користувача, який запросив (реферера)
    const { rows: referrer } = await client.query('SELECT * FROM users WHERE referral_code = $1', [referralCode]);
    if (referrer.length === 0) {
      throw new Error('Invalid referral code');
    }

    if (referrer[0].telegram_id === userId) {
      throw new Error('Cannot use own referral code');
    }

    // Перевіряємо чи користувач вже був запрошений
    const { rows: user } = await client.query('SELECT referred_by FROM users WHERE telegram_id = $1', [userId]);
    if (user[0].referred_by) {
      throw new Error('User already referred');
    }

    // Оновлюємо дані про реферала
    await client.query(`
      UPDATE users 
      SET referred_by = $1,
          referrals = COALESCE(referrals, ARRAY[]::bigint[]) || ARRAY[$2]::bigint[]
      WHERE telegram_id = $1
    `, [referrer[0].telegram_id, userId]);

    // Оновлюємо дані запрошеного користувача
    await client.query(`
      UPDATE users 
      SET referred_by = $1 
      WHERE telegram_id = $2
    `, [referrer[0].telegram_id, userId]);

    // Створюємо запис про винагороду
    await createReferralReward(referrer[0].telegram_id, userId);

    await client.query('COMMIT');
    console.log('Referral processed successfully');

    return {
      success: true,
      message: 'Referral processed successfully',
      bonusCoins: 1000
    };
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
      console.error('Error processing referral:', error);
    }
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
    console.log(`Getting user data for userId: ${userId}`);

    // Отримуємо основні дані користувача
    const { rows: user } = await client.query(`
      SELECT 
        u.*,
        COUNT(DISTINCT rr.id) FILTER (WHERE rr.is_claimed = FALSE) as unclaimed_rewards_count
      FROM users u
      LEFT JOIN referral_rewards rr ON rr.referrer_id = u.telegram_id
      WHERE u.telegram_id = $1
      GROUP BY u.telegram_id
    `, [userId]);

    if (!user.length) {
      throw new Error('User not found');
    }

    console.log('User referrals array:', user[0].referrals);

    // Отримуємо дані про друзів
    const friends = user[0].referrals && user[0].referrals.length > 0
      ? await client.query(`
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
          ORDER BY total_coins DESC
        `, [user[0].referrals])
      : { rows: [] };

    const referralLink = `https://t.me/${process.env.BOT_USERNAME}?start=${user[0].referral_code}`;

    console.log(`Found ${friends.rows.length} friends for user`);

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
      hasUnclaimedRewards: user[0].unclaimed_rewards_count > 0,
      friends: friends.rows.map(friend => ({
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
      console.log('Database connection released');
    }
  }
}

export async function updateUserLevel(userId, newLevel) {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    console.log(`Updating user level: userId=${userId}, newLevel=${newLevel}`);

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
    console.log('User level updated successfully');
    return result[0];
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
      console.error('Error updating user level:', error);
    }
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
    console.log(`Updating coins: userId=${userId}, coinsToAdd=${coinsToAdd}`);

    const { rows: result } = await client.query(`
      UPDATE users
      SET coins = coins + $1, 
          total_coins = total_coins + $1
      WHERE telegram_id = $2
      RETURNING coins, total_coins
    `, [coinsToAdd, userId]);

    if (result.length === 0) {
      throw new Error('User not found');
    }

    await client.query('COMMIT');
    console.log('User coins updated successfully');
    return {
      newCoins: result[0].coins,
      newTotalCoins: result[0].total_coins
    };
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
      console.error('Error updating user coins:', error);
    }
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