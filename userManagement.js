import { pool, withClient } from './db.js';

// Утиліти для генерації та валідації
function generateReferralCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function validateReferralCode(code) {
  return /^[A-Z0-9]{6}$/.test(code);
}

// Ініціалізація користувача з оптимізованою обробкою помилок
export async function initializeUser(userId, firstName, lastName, username, avatarUrl) {
  console.log('Starting user initialization:', { userId, firstName, lastName, username });

  return withClient(async (client) => {
    try {
      await client.query('BEGIN');

      // Перевіряємо чи існує користувач
      let { rows: user } = await client.query(
        'SELECT * FROM users WHERE telegram_id = $1',
        [userId]
      );

      let result;
      if (user.length === 0) {
        console.log('Creating new user:', userId);
        const referralCode = generateReferralCode();

        // Використовуємо COALESCE для обробки null значень
        const { rows: newUser } = await client.query(`
          INSERT INTO users (
            telegram_id, first_name, last_name, username, 
            referral_code, coins, total_coins, level, 
            avatar, referrals
          ) 
          VALUES ($1, $2, $3, $4, $5, 0, 0, 'Silver', $6, ARRAY[]::bigint[])
          RETURNING *
        `, [userId, firstName || '', lastName || '', username || '', referralCode, avatarUrl]);

        result = newUser[0];
      } else {
        console.log('Updating existing user:', userId);
        const { rows: updatedUser } = await client.query(`
          UPDATE users 
          SET 
            first_name = COALESCE($2, first_name),
            last_name = COALESCE($3, last_name),
            username = COALESCE($4, username),
            avatar = COALESCE($5, avatar)
          WHERE telegram_id = $1
          RETURNING *
        `, [userId, firstName || '', lastName || '', username || '', avatarUrl]);

        result = updatedUser[0];
      }

      await client.query('COMMIT');
      return {
        telegramId: result.telegram_id.toString(),
        firstName: result.first_name || '',
        lastName: result.last_name || '',
        username: result.username || '',
        referralCode: result.referral_code,
        referralLink: `https://t.me/${process.env.BOT_USERNAME}?start=${result.referral_code}`,
        coins: result.coins,
        totalCoins: result.total_coins,
        level: result.level,
        photoUrl: result.avatar
      };
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in initializeUser:', error);
      throw new Error(`Failed to initialize user: ${error.message}`);
    }
  });
}

// Створення реферальної винагороди
export async function createReferralReward(referrerId, referredId) {
  console.log('Creating referral reward:', { referrerId, referredId });

  return withClient(async (client) => {
    try {
      const { rows } = await client.query(`
        INSERT INTO referral_rewards 
        (referrer_id, referred_id, reward_amount, is_claimed)
        VALUES ($1, $2, 1000, FALSE)
        ON CONFLICT (referrer_id, referred_id) DO NOTHING
        RETURNING *
      `, [referrerId, referredId]);

      console.log('Referral reward created:', rows[0]);
      return rows[0];
    } catch (error) {
      console.error('Error creating referral reward:', error);
      throw new Error(`Failed to create referral reward: ${error.message}`);
    }
  });
}

// Отримання невитребуваних винагород
export async function getUnclaimedRewards(userId) {
  console.log('Getting unclaimed rewards for user:', userId);

  return withClient(async (client) => {
    try {
      const { rows } = await client.query(`
        SELECT 
          rr.*,
          u.first_name,
          u.last_name,
          u.username
        FROM referral_rewards rr
        JOIN users u ON u.telegram_id = rr.referred_id
        WHERE rr.referrer_id = $1 AND rr.is_claimed = FALSE
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
      throw new Error(`Failed to get unclaimed rewards: ${error.message}`);
    }
  });
}

// Отримання винагороди з транзакційною безпекою
export async function claimReward(userId, rewardId) {
  console.log('Claiming reward:', { userId, rewardId });

  return withClient(async (client) => {
    try {
      await client.query('BEGIN');

      // Перевіряємо і блокуємо винагороду
      const { rows: rewards } = await client.query(`
        SELECT * FROM referral_rewards 
        WHERE id = $1 AND referrer_id = $2 AND is_claimed = FALSE
        FOR UPDATE
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

      // Оновлюємо баланс користувача
      const { rows: updatedUser } = await client.query(`
        UPDATE users 
        SET 
          coins = coins + $1,
          total_coins = total_coins + $1,
          last_updated_at = CURRENT_TIMESTAMP
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
      await client.query('ROLLBACK');
      console.error('Error claiming reward:', error);
      throw new Error(`Failed to claim reward: ${error.message}`);
    }
  });
}

// Обробка реферального коду
export async function processReferral(referralCode, userId) {
  console.log('Processing referral:', { referralCode, userId });

  if (!validateReferralCode(referralCode)) {
    throw new Error('Invalid referral code format');
  }

  return withClient(async (client) => {
    try {
      await client.query('BEGIN');

      // Перевіряємо реферальний код
      const { rows: referrer } = await client.query(
        'SELECT * FROM users WHERE referral_code = $1',
        [referralCode]
      );

      if (referrer.length === 0) {
        throw new Error('Invalid referral code');
      }

      if (referrer[0].telegram_id === userId) {
        throw new Error('Cannot use own referral code');
      }

      // Перевіряємо чи користувач вже був запрошений
      const { rows: user } = await client.query(
        'SELECT referred_by FROM users WHERE telegram_id = $1',
        [userId]
      );

      if (user[0].referred_by) {
        throw new Error('User already referred');
      }

      // Оновлюємо дані користувача та реферера
      await client.query(`
        UPDATE users 
        SET 
          referred_by = $1,
          last_updated_at = CURRENT_TIMESTAMP
        WHERE telegram_id = $2
      `, [referrer[0].telegram_id, userId]);

      await client.query(`
        UPDATE users 
        SET 
          referrals = array_append(COALESCE(referrals, ARRAY[]::bigint[]), $1),
          last_updated_at = CURRENT_TIMESTAMP
        WHERE telegram_id = $2
      `, [userId, referrer[0].telegram_id]);

      // Створюємо винагороду
      await createReferralReward(referrer[0].telegram_id, userId);

      await client.query('COMMIT');

      console.log('Referral processed successfully');
      return {
        success: true,
        message: 'Referral processed successfully',
        bonusCoins: 1000
      };
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error processing referral:', error);
      throw new Error(`Failed to process referral: ${error.message}`);
    }
  });
}

// Отримання даних користувача з оптимізованим запитом
export async function getUserData(userId) {
  console.log('Getting user data:', userId);

  return withClient(async (client) => {
    try {
      // Отримуємо дані користувача з об'єднаним запитом
      const { rows: user } = await client.query(`
        SELECT 
          u.*,
          COUNT(DISTINCT rr.id) FILTER (WHERE rr.is_claimed = FALSE) as unclaimed_rewards_count
        FROM users u
        LEFT JOIN referral_rewards rr ON rr.referrer_id = u.telegram_id
        WHERE u.telegram_id = $1
        GROUP BY u.telegram_id
      `, [userId]);

      if (user.length === 0) {
        throw new Error('User not found');
      }

      // Отримуємо дані друзів
      const friends = user[0].referrals && user[0].referrals.length > 0
        ? await client.query(`
            SELECT 
              telegram_id, first_name, last_name, username,
              coins, total_coins, level, avatar
            FROM users 
            WHERE telegram_id = ANY($1)
            ORDER BY total_coins DESC
          `, [user[0].referrals])
        : { rows: [] };

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
        referralLink: `https://t.me/${process.env.BOT_USERNAME}?start=${user[0].referral_code}`,
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
      throw new Error(`Failed to get user data: ${error.message}`);
    }
  });
}

// Оновлення рівня користувача
export async function updateUserLevel(userId, newLevel) {
  console.log('Updating user level:', { userId, newLevel });

  return withClient(async (client) => {
    try {
      const { rows: result } = await client.query(`
        UPDATE users 
        SET level = $1
        WHERE telegram_id = $2 
        RETURNING level, coins, total_coins
      `, [newLevel, userId]);

      if (result.length === 0) {
        throw new Error('User not found');
      }

      console.log('User level updated successfully');
      return result[0];
    } catch (error) {
      console.error('Error updating user level:', error);
      throw new Error(`Failed to update user level: ${error.message}`);
    }
  });
}

// Оновлення монет користувача
export async function updateUserCoins(userId, coinsToAdd) {
  console.log('Updating user coins:', { userId, coinsToAdd });

  return withClient(async (client) => {
    try {
      const { rows: result } = await client.query(`
        UPDATE users
        SET 
          coins = coins + $1,
          total_coins = total_coins + $1,
          last_updated_at = CURRENT_TIMESTAMP
        WHERE telegram_id = $2
        RETURNING coins, total_coins
      `, [coinsToAdd, userId]);

      if (result.length === 0) {
        throw new Error('User not found');
      }

      console.log('User coins updated successfully');
      return {
        newCoins: result[0].coins,
        newTotalCoins: result[0].total_coins
      };
    } catch (error) {
      console.error('Error updating user coins:', error);
      throw new Error(`Failed to update user coins: ${error.message}`);
    }
  });
}