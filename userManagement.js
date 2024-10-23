import { pool } from './db.js';

// Допоміжна функція для генерації реферального коду
function generateReferralCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

async function initializeUser(userId, firstName, lastName, username, avatarUrl) {
  let client;
  try {
    client = await pool.connect();
    console.log('Connected to database for user initialization');
    await client.query('BEGIN');
    console.log('Спроба ініціалізації користувача:', userId);

    // Спочатку перевіряємо, чи існує користувач
    let { rows: user } = await client.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
    console.log('Результат SQL-запиту SELECT:', JSON.stringify(user));

    if (user.length === 0) {
      console.log('Користувача не знайдено, створюємо нового');
      const referralCode = generateReferralCode();
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
          referrals
        ) VALUES ($1, $2, $3, $4, $5, 0, 0, $6, $7, ARRAY[]::bigint[]) 
        RETURNING *`,
        [userId, firstName || null, lastName || null, username || null, referralCode, 'Silver', avatarUrl]
      );
      console.log('Результат створення нового користувача:', JSON.stringify(newUser));
      user = newUser;
    } else {
      console.log('Користувач вже існує, оновлюємо дані');
      const { rows: updatedUser } = await client.query(`
        UPDATE users 
        SET 
          first_name = COALESCE($2, first_name),
          last_name = COALESCE($3, last_name),
          username = COALESCE($4, username),
          avatar = COALESCE($5, avatar)
        WHERE telegram_id = $1 
        RETURNING *`,
        [userId, firstName, lastName, username, avatarUrl]
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
    if (client) {
      await client.query('ROLLBACK');
      console.error('Error in transaction, rolling back:', error);
    }
    throw error;
  } finally {
    if (client) {
      client.release();
      console.log('Database connection released');
    }
  }
}

async function processReferral(referralCode, userId) {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    console.log(`Processing referral: code=${referralCode}, userId=${userId}`);

    // Перевірка існування реферера
    const { rows: referrer } = await client.query('SELECT * FROM users WHERE referral_code = $1', [referralCode]);
    if (referrer.length === 0) {
      throw new Error('Invalid referral code');
    }

    // Перевірка на використання власного коду
    if (referrer[0].telegram_id.toString() === userId.toString()) {
      throw new Error('Cannot use own referral code');
    }

    // Перевірка чи користувач вже був запрошений
    const { rows: user } = await client.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
    if (!user[0]) {
      throw new Error('User not found');
    }
    if (user[0].referred_by) {
      throw new Error('User already referred');
    }

    // Оновлення зв'язків між користувачами
    await client.query('UPDATE users SET referred_by = $1 WHERE telegram_id = $2',
      [referrer[0].telegram_id, userId]);

    await client.query(`
      UPDATE users 
      SET referrals = CASE 
        WHEN referrals IS NULL THEN ARRAY[$1]::bigint[]
        ELSE array_append(referrals, $1)
      END
      WHERE telegram_id = $2`,
      [userId, referrer[0].telegram_id]
    );

    const bonusCoins = 1000;

    // Оновлення монет для обох користувачів
    const { rows: updatedReferrer } = await client.query(`
      UPDATE users 
      SET 
        coins = coins + $1,
        total_coins = total_coins + $1 
      WHERE telegram_id = $2 
      RETURNING coins, total_coins`,
      [bonusCoins, referrer[0].telegram_id]
    );

    const { rows: updatedUser } = await client.query(`
      UPDATE users 
      SET 
        coins = coins + $1,
        total_coins = total_coins + $1 
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
    if (client) {
      await client.query('ROLLBACK');
      console.error('Error processing referral, rolling back:', error);
    }
    throw error;
  } finally {
    if (client) {
      client.release();
      console.log('Database connection released');
    }
  }
}

async function getUserData(userId) {
  let client;
  try {
    client = await pool.connect();
    console.log('Connected to database for getUserData. UserId:', userId);

    // Спершу перевіряємо, чи існує користувач
    const checkUser = await client.query('SELECT EXISTS(SELECT 1 FROM users WHERE telegram_id = $1)', [userId]);
    console.log('Перевірка існування користувача:', checkUser.rows[0].exists);

    if (!checkUser.rows[0].exists) {
      console.log('Користувача не знайдено в базі даних, спроба створення');
      return await initializeUser(userId);
    }

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
    console.log('Результат запиту користувача:', JSON.stringify(user));

    if (user.length === 0) {
      throw new Error('User not found after verification');
    }

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
    console.log('Знайдено друзів:', friends.length);

    const referralLink = `https://t.me/${process.env.BOT_USERNAME}?start=${user[0].referral_code}`;

    const result = {
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

    console.log('Підготовлено дані для відправки:', JSON.stringify(result));
    return result;
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

async function updateUserLevel(userId, newLevel) {
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

async function updateUserCoins(userId, coinsToAdd) {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const { rows: result } = await client.query(`
      UPDATE users 
      SET 
        coins = coins + $1,
        total_coins = total_coins + $1
      WHERE telegram_id = $2 
      RETURNING coins, total_coins
    `, [coinsToAdd, userId]);

    if (result.length === 0) {
      throw new Error('User not found');
    }

    await client.query('COMMIT');
    console.log(`Successfully updated coins for user ${userId}. Added: ${coinsToAdd}`);

    return {
      success: true,
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

// Експортуємо всі необхідні функції
export {
  initializeUser,
  processReferral,
  getUserData,
  updateUserLevel,
  updateUserCoins
};