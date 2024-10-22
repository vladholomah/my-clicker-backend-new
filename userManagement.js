import { executeQuery, getConnection } from './db.js';

// Допоміжна функція для генерації реферального коду
function generateReferralCode(length = 6) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Функція для ініціалізації користувача з повторними спробами
export async function initializeUser(userId, firstName = '', lastName = null, username = null, avatarUrl = null) {
  let client;
  let retries = 3;

  while (retries > 0) {
    try {
      client = await getConnection();
      console.log('Connected to database for user initialization');

      await client.query('BEGIN');
      console.log('Спроба ініціалізації користувача:', userId);

      // Перевіряємо чи існує користувач
      let { rows: user } = await client.query(
        'SELECT * FROM users WHERE telegram_id = $1',
        [userId]
      );
      console.log('Результат SQL-запиту SELECT:', JSON.stringify(user));

      if (user.length === 0) {
        console.log('Користувача не знайдено, створюємо нового');

        // Генеруємо унікальний реферальний код
        let referralCode;
        let isUnique = false;
        while (!isUnique) {
          referralCode = generateReferralCode();
          const { rows } = await client.query(
            'SELECT referral_code FROM users WHERE referral_code = $1',
            [referralCode]
          );
          isUnique = rows.length === 0;
        }

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
            last_active
          ) VALUES ($1, $2, $3, $4, $5, 0, 0, $6, $7, $8, CURRENT_TIMESTAMP)
          RETURNING *
        `, [
          userId,
          firstName || '',
          lastName,
          username,
          referralCode,
          'Новачок',
          avatarUrl,
          []
        ]);

        console.log('Результат створення нового користувача:', JSON.stringify(newUser));
        user = newUser;
      } else {
        console.log('Користувач вже існує, оновлюємо дані');

        // Формуємо динамічний UPDATE запит
        const updates = [];
        const values = [userId];
        let paramIndex = 2;

        if (firstName !== undefined) {
          updates.push(`first_name = $${paramIndex}`);
          values.push(firstName || '');
          paramIndex++;
        }
        if (lastName !== undefined) {
          updates.push(`last_name = $${paramIndex}`);
          values.push(lastName);
          paramIndex++;
        }
        if (username !== undefined) {
          updates.push(`username = $${paramIndex}`);
          values.push(username);
          paramIndex++;
        }
        if (avatarUrl !== undefined) {
          updates.push(`avatar = $${paramIndex}`);
          values.push(avatarUrl);
          paramIndex++;
        }

        updates.push('last_active = CURRENT_TIMESTAMP');

        if (updates.length > 0) {
          const { rows: updatedUser } = await client.query(`
            UPDATE users 
            SET ${updates.join(', ')} 
            WHERE telegram_id = $1 
            RETURNING *
          `, values);
          user = updatedUser;
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
        avatar: user[0].avatar,
        createdAt: user[0].created_at,
        lastActive: user[0].last_active
      };

    } catch (error) {
      if (client) {
        try {
          await client.query('ROLLBACK');
          console.log('Transaction rolled back');
        } catch (rollbackError) {
          console.error('Error during rollback:', rollbackError);
        }
      }

      console.error('Error initializing user:', error);
      retries--;

      if (retries > 0) {
        console.log(`Retrying... ${retries} attempts left`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      } else {
        throw error;
      }
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
}

// Функція обробки реферального коду
export async function processReferral(referralCode, userId) {
  let client;
  try {
    client = await getConnection();
    await client.query('BEGIN');

    console.log(`Processing referral: code=${referralCode}, userId=${userId}`);

    // Перевіряємо валідність реферального коду
    const { rows: referrer } = await client.query(
      'SELECT * FROM users WHERE referral_code = $1',
      [referralCode]
    );

    if (referrer.length === 0) {
      throw new Error('Invalid referral code');
    }

    // Перевіряємо чи користувач не використовує свій код
    if (referrer[0].telegram_id === userId) {
      throw new Error('Cannot use own referral code');
    }

    // Перевіряємо чи користувач вже не був запрошений
    const { rows: user } = await client.query(
      'SELECT * FROM users WHERE telegram_id = $1',
      [userId]
    );

    if (user[0].referred_by) {
      throw new Error('User already referred');
    }

    const bonusCoins = 10;

    // Оновлюємо дані користувачів
    await Promise.all([
      // Оновлюємо дані запрошеного користувача
      client.query(`
        UPDATE users 
        SET 
          referred_by = $1,
          coins = coins + $2,
          total_coins = total_coins + $2,
          last_active = CURRENT_TIMESTAMP
        WHERE telegram_id = $3
      `, [referrer[0].telegram_id, bonusCoins, userId]),

      // Оновлюємо дані запрошувача
      client.query(`
        UPDATE users 
        SET 
          referrals = array_append(referrals, $1),
          coins = coins + $2,
          total_coins = total_coins + $2,
          last_active = CURRENT_TIMESTAMP
        WHERE telegram_id = $3
      `, [userId, bonusCoins, referrer[0].telegram_id])
    ]);

    await client.query('COMMIT');
    console.log('Referral processed successfully');

    return {
      success: true,
      message: 'Referral processed successfully',
      bonusCoins
    };

  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
        console.log('Transaction rolled back');
      } catch (rollbackError) {
        console.error('Error during rollback:', rollbackError);
      }
    }
    console.error('Error processing referral:', error);
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

// Функція отримання даних користувача
export async function getUserData(userId) {
  let client;
  try {
    client = await getConnection();
    console.log('Connected to database for getUserData');

    // Отримуємо дані користувача
    const { rows: user } = await client.query(`
      SELECT * FROM users 
      WHERE telegram_id = $1
    `, [userId]);

    if (user.length === 0) {
      throw new Error('User not found');
    }

    // Оновлюємо час останньої активності
    await client.query(`
      UPDATE users 
      SET last_active = CURRENT_TIMESTAMP 
      WHERE telegram_id = $1
    `, [userId]);

    // Отримуємо дані друзів
    const { rows: friends } = await client.query(`
      SELECT 
        telegram_id, 
        first_name, 
        last_name, 
        username, 
        coins, 
        total_coins, 
        level, 
        avatar,
        created_at,
        last_active
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
      createdAt: user[0].created_at,
      lastActive: user[0].last_active,
      friends: friends.map(friend => ({
        telegramId: friend.telegram_id.toString(),
        firstName: friend.first_name,
        lastName: friend.last_name,
        username: friend.username,
        coins: friend.coins,
        totalCoins: friend.total_coins,
        level: friend.level,
        avatar: friend.avatar,
        createdAt: friend.created_at,
        lastActive: friend.last_active
      }))
    };
  } catch (error) {
    console.error('Error fetching user data:', error);
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

// Функція оновлення монет користувача
export async function updateUserCoins(userId, coinsToAdd) {
  let client;
  try {
    client = await getConnection();
    await client.query('BEGIN');

    const { rows: result } = await client.query(`
      UPDATE users
      SET 
        coins = coins + $1,
        total_coins = total_coins + $1,
        last_active = CURRENT_TIMESTAMP
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
    if (client) {
      try {
        await client.query('ROLLBACK');
        console.log('Transaction rolled back');
      } catch (rollbackError) {
        console.error('Error during rollback:', rollbackError);
      }
    }
    console.error('Error updating user coins:', error);
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