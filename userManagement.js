import { getConnection } from './db.js';

export async function initializeUser(userId, firstName, lastName, username, avatarUrl) {
  let client;
  try {
    client = await getConnection();
    console.log('Connected to database for user initialization');
    await client.query('BEGIN');

    // Перевірка наявності користувача
    const checkUserQuery = 'SELECT * FROM users WHERE telegram_id = $1';
    console.log('Checking for existing user:', userId);
    let { rows: user } = await client.query(checkUserQuery, [userId]);
    console.log('Existing user check result:', user);

    if (user.length === 0) {
      console.log('Creating new user:', { userId, firstName, lastName, username });
      const referralCode = generateReferralCode();
      const insertQuery = `
        INSERT INTO users (
          telegram_id, first_name, last_name, username, 
          referral_code, coins, total_coins, level, 
          referrals, avatar
        ) VALUES ($1, $2, $3, $4, $5, 0, 0, $6, $7, $8) 
        RETURNING *
      `;
      const values = [
        userId,
        firstName || 'User',
        lastName,
        username,
        referralCode,
        'Новачок',
        [],
        avatarUrl
      ];

      try {
        const { rows: newUser } = await client.query(insertQuery, values);
        console.log('New user created:', newUser[0]);
        user = newUser;
      } catch (insertError) {
        console.error('Error creating new user:', insertError);
        throw insertError;
      }
    } else {
      console.log('Updating existing user:', userId);
      const updateQuery = `
        UPDATE users 
        SET first_name = COALESCE($2, first_name),
            last_name = COALESCE($3, last_name),
            username = COALESCE($4, username),
            avatar = COALESCE($5, avatar)
        WHERE telegram_id = $1
        RETURNING *
      `;
      const values = [userId, firstName, lastName, username, avatarUrl];

      try {
        const { rows: updatedUser } = await client.query(updateQuery, values);
        console.log('User updated:', updatedUser[0]);
        user = updatedUser;
      } catch (updateError) {
        console.error('Error updating user:', updateError);
        throw updateError;
      }
    }

    await client.query('COMMIT');
    console.log('Transaction committed successfully');

    const referralLink = `https://t.me/${process.env.BOT_USERNAME}?start=${user[0].referral_code}`;
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
      await client.query('ROLLBACK');
      console.log('Transaction rolled back due to error');
    }
    console.error('Error in initializeUser:', error);
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
    client = await getConnection();
    await client.query('BEGIN');

    console.log(`Processing referral: code=${referralCode}, userId=${userId}`);

    // Перевірка існування реферального коду
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

    // Перевірка чи користувач вже не був зареєстрований за рефералом
    const { rows: user } = await client.query(
      'SELECT * FROM users WHERE telegram_id = $1',
      [userId]
    );

    if (!user.length) {
      throw new Error('User not found');
    }

    if (user[0].referred_by) {
      throw new Error('User already referred');
    }

    // Оновлення даних користувача та реферера
    await client.query(
      'UPDATE users SET referred_by = $1 WHERE telegram_id = $2',
      [referrer[0].telegram_id, userId]
    );

    await client.query(
      'UPDATE users SET referrals = array_append(referrals, $1) WHERE telegram_id = $2',
      [userId, referrer[0].telegram_id]
    );

    // Нарахування бонусів
    const bonusCoins = 10;
    await client.query(
      `UPDATE users 
       SET coins = coins + $1, 
           total_coins = total_coins + $1 
       WHERE telegram_id IN ($2, $3)`,
      [bonusCoins, referrer[0].telegram_id, userId]
    );

    await client.query('COMMIT');
    console.log('Referral processed successfully');

    return {
      success: true,
      message: 'Referral processed successfully',
      bonusCoins
    };
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
      console.log('Transaction rolled back due to error');
    }
    console.error('Error processing referral:', error);
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
    client = await getConnection();
    console.log('Getting user data for:', userId);

    const { rows: user } = await client.query(
      'SELECT * FROM users WHERE telegram_id = $1',
      [userId]
    );

    if (user.length === 0) {
      throw new Error('User not found');
    }

    const { rows: friends } = await client.query(
      `SELECT telegram_id, first_name, last_name, username, 
              coins, total_coins, level, avatar
       FROM users
       WHERE telegram_id = ANY($1)`,
      [user[0].referrals || []]
    );

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
    client = await getConnection();
    await client.query('BEGIN');

    const { rows: result } = await client.query(
      `UPDATE users
       SET coins = coins + $1, 
           total_coins = total_coins + $1
       WHERE telegram_id = $2
       RETURNING coins, total_coins`,
      [coinsToAdd, userId]
    );

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
      console.log('Database connection released');
    }
  }
}

function generateReferralCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}