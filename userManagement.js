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
            referrals
          ) VALUES ($1, $2, $3, $4, $5, 0, 0, $6, $7, $8) 
          RETURNING *
        `, [
          userId,
          firstName || '',
          lastName,
          username,
          referralCode,
          'Beginner',
          avatarUrl,
          []
        ]);

        user = newUser;
      } else {
        console.log('Користувач вже існує, оновлюємо дані');

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
        avatar: user[0].avatar
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
        await new Promise(resolve => setTimeout(resolve, 1000 * (4 - retries)));
        continue;
      }
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
}

export async function getUserData(userId) {
  let client;
  try {
    client = await getConnection();
    console.log('Connected to database for getUserData');

    const { rows: user } = await client.query(`
      SELECT * FROM users WHERE telegram_id = $1
    `, [userId]);

    if (user.length === 0) {
      throw new Error('User not found');
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
      try {
        await client.release(true);
        console.log('Database connection released');
      } catch (releaseError) {
        console.error('Error releasing client:', releaseError);
      }
    }
  }
}