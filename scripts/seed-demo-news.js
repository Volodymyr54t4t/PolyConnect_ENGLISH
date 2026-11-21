require("dotenv").config()

const { Pool } = require("pg")

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL не задано")

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })

const topics = {
  "Бакалаври": ["Практична зустріч для студентів бакалаврату", "Відкрито реєстрацію на вибіркові дисципліни", "Консультація щодо навчальних проєктів"],
  "Магістри": ["Семінар з підготовки магістерських робіт", "Зустріч з гарантами магістерської програми", "Дедлайн подання тем кваліфікаційних робіт"],
  "Аспіранти": ["Науковий семінар для аспірантів", "Консультація щодо індивідуального плану аспіранта", "Відкритий воркшоп з академічного письма"],
  "Викладачі": ["Методична нарада кафедри", "Підвищення кваліфікації для викладачів", "Обговорення оновлення освітніх компонент"],
  "Акредитація": ["Підготовка матеріалів до акредитації програми", "Відкрита зустріч з експертною групою", "Обговорення результатів акредитаційної експертизи"],
  "Захисти аспірантів": ["Анонс захисту дисертаційного дослідження", "Успішний захист дисертації аспіранта", "Відкрите засідання разової спеціалізованої ради"],
  "Наукові досягнення": ["Науковці кафедри отримали грантову підтримку", "Публікація дослідження у міжнародному виданні", "Команда представила результати на науковій конференції"],
  "Олімпіади": ["Відбір до команди з програмування", "Студенти посіли призові місця в олімпіаді", "Тренування перед Всеукраїнською олімпіадою"],
  Erasmus: ["Інформаційна зустріч про програму Erasmus+", "Відкрито конкурс на академічну мобільність", "Досвід навчання студентів за Erasmus+"],
  "Активності": ["Студентська активність: день відкритих лабораторій", "Відбулася командна зустріч ІТ-спільноти", "Запрошуємо до участі в факультетській події"],
  "Оголошення": ["Важливе оголошення для здобувачів освіти", "Зміни у графіку консультацій", "Нагадування про подання документів"],
  "Запрошені лекції": ["Запрошена лекція від ІТ-фахівця", "Відкрита лекція про сучасні технології", "Гостьовий спікер розкаже про кар'єру в ІТ"],
  "Інше": ["Корисна інформація для спільноти кафедри", "Підсумки тижня факультету", "Новина з життя освітньої програми"],
}

async function main() {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const author = await client.query("SELECT id FROM users WHERE email=$1 AND role='Викладач' LIMIT 1", ["vova.chyzhevskyi@ztu.edu.ua"])
    if (!author.rows.length) throw new Error("Не знайдено тестового викладача для створення новин")

    for (const [categoryName, titles] of Object.entries(topics)) {
      const category = await client.query("INSERT INTO news_categories(name) VALUES($1) ON CONFLICT(name) DO UPDATE SET name=EXCLUDED.name RETURNING id", [categoryName])
      for (const [index, title] of titles.entries()) {
        const content = `Тестова новина для перевірки категорії «${categoryName}». Тут можна перевірити відображення картки, фільтрацію та вивантаження у PDF.`
        let news = await client.query("SELECT id FROM news WHERE author_id=$1 AND title=$2 AND content=$3 LIMIT 1", [author.rows[0].id, title, content])
        if (!news.rows.length) {
          news = await client.query(
            "INSERT INTO news(author_id,title,content,category,status,is_pinned,created_at) VALUES($1,$2,$3,$4,'published',$5,now()-($6::int * interval '1 day')) RETURNING id",
            [author.rows[0].id, title, content, categoryName, index === 0, index + 1],
          )
        }
        await client.query("INSERT INTO news_category_links(news_id,category_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [news.rows[0].id, category.rows[0].id])
        if (index === 1 && categoryName !== "Оголошення") {
          const announcement = await client.query("INSERT INTO news_categories(name) VALUES('Оголошення') ON CONFLICT(name) DO UPDATE SET name=EXCLUDED.name RETURNING id")
          await client.query("INSERT INTO news_category_links(news_id,category_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [news.rows[0].id, announcement.rows[0].id])
        }
      }
    }
    await client.query("COMMIT")
    console.log("Створено 39 тестових новин")
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1 }).finally(() => pool.end())
