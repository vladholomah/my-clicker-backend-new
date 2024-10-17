import { neon } from '@neondatabase/serverless';
import dotenv from 'dotenv';

dotenv.config();

const sql = neon(process.env.POSTGRES_URL);

export default async (req, res) => {
  console.log('Отримано реферальний запит:', req.method, req.url);
  console.log('Тіло запиту:', JSON.stringify(req.body));

  const { referrerId, newUserId } = req.body;

  if (!referrerId || !newUserId) {
    console.error('Відсутні обов\'язкові параметри');
    return res.status(400).json({ success: false, error: 'Потрібні referrerId та newUserId' });
  }

  if (referrerId === newUserId) {
    console.error('Користувач намагається запросити сам себе');
    return res.status(400).json({ success: false, error: 'Неможливо запросити самого себе' });
  }

  try {
    console.log('Підключення до PostgreSQL');
    const bonusAmount = 5000;

    await sql.transaction(async (tx) => {
      console.log('Пошук реферера');
      const referrer = await tx`SELECT * FROM users WHERE telegram_id = ${referrerId}`;
      console.log('Реферер перед оновленням:', referrer[0]);

      if (referrer.length === 0) {
        throw new Error('Реферера не знайдено');
      }

      console.log('Пошук нового користувача');
      const newUser = await tx`SELECT * FROM users WHERE telegram_id = ${newUserId}`;
      if (newUser.length === 0) {
        throw new Error('Нового користувача не знайдено');
      }

      if (newUser[0].referred_by) {
        throw new Error('Користувач вже був запрошений');
      }

      console.log('Оновлення даних реферера');
      await tx`
        UPDATE users 
        SET referrals = array_append(referrals, ${newUserId}),
            coins = coins + ${bonusAmount},
            total_coins = total_coins + ${bonusAmount}
        WHERE telegram_id = ${referrerId}
      `;

      console.log('Оновлення даних нового користувача');
      await tx`
        UPDATE users
        SET coins = coins + ${bonusAmount},
            total_coins = total_coins + ${bonusAmount},
            referred_by = ${referrerId}
        WHERE telegram_id = ${newUserId}
      `;
    });

    console.log('Реферальний бонус успішно додано');
    res.status(200).json({
      success: true,
      referrerBonus: bonusAmount,
      newUserBonus: bonusAmount
    });
  } catch (error) {
    console.error('Помилка обробки реферального запиту:', error);
    if (error.message === 'Реферера не знайдено') {
      return res.status(404).json({ success: false, error: error.message });
    } else if (error.message === 'Нового користувача не знайдено') {
      return res.status(404).json({ success: false, error: error.message });
    } else if (error.message === 'Користувач вже був запрошений') {
      return res.status(400).json({ success: false, error: error.message });
    }
    res.status(500).json({ success: false, error: 'Внутрішня помилка сервера', details: error.message });
  }
};