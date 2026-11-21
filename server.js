require("dotenv").config()

const path = require("path")
const crypto = require("crypto")
const express = require("express")
const cookieParser = require("cookie-parser")
const bcrypt = require("bcryptjs")
const jwt = require("jsonwebtoken")
const { Pool } = require("pg")
const nodemailer = require("nodemailer")

const app = express()

const PORT = process.env.PORT || 3000
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me"
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d"
const ALLOWED_DOMAINS = (process.env.ALLOWED_EMAIL_DOMAIN || "@ztu.edu.ua,@student.ztu.edu.ua")
  .split(",")
  .map((domain) => domain.trim().toLowerCase())
  .filter(Boolean)
const ALLOWED_DOMAINS_LABEL = ALLOWED_DOMAINS.join(" або ")
const DEVELOPER_ROLE = "Розробник"
const DEVELOPER_EMAIL = String(process.env.DEVELOPER_ADMIN_EMAIL || "").trim().toLowerCase()
const DEVELOPER_PASSWORD = String(process.env.DEVELOPER_ADMIN_PASSWORD || "")
const PROFILE_MAIL_FROM = String(process.env.PROFILE_MAIL_FROM || process.env.DEVELOPER_ADMIN_EMAIL || "").trim()
const PROFILE_MAIL_PASSWORD = String(process.env.PROFILE_MAIL_APP_PASSWORD || "").replace(/\s+/g, "")
const VALID_ROLES = [DEVELOPER_ROLE, "ДеканФІКТ", "Завідувач Кафедри", "Викладач", "Студент"]
const PRESENCE_STATUSES = ["available", "away", "dnd", "offline"]

function effectivePresence(status, lastSeen, lastActiveAt) {
  if (!PRESENCE_STATUSES.includes(status) || status === "offline") return "offline"
  const now = Date.now()
  const seenAt = lastSeen ? new Date(lastSeen).getTime() : 0
  if (!seenAt || now - seenAt > 120_000) return "offline"
  const activeAt = lastActiveAt ? new Date(lastActiveAt).getTime() : seenAt
  if (status === "available" && now - activeAt > 300_000) return "away"
  return status
}

const PRESENCE_SQL = `CASE
  WHEN u.user_status = 'offline' OR u.last_seen IS NULL OR u.last_seen < now() - interval '2 minutes' THEN 'offline'
  WHEN u.user_status = 'available' AND (u.last_active_at IS NULL OR u.last_active_at < now() - interval '5 minutes') THEN 'away'
  ELSE u.user_status END`

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL не задано у .env")
  process.exit(1)
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: Math.max(2, Math.min(30, Number.parseInt(process.env.PG_POOL_MAX || "10", 10) || 10)),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
})
pool.on("error", (err) => console.error("PostgreSQL idle connection error:", err.message))

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id             SERIAL PRIMARY KEY,
      full_name      TEXT NOT NULL,
      email          TEXT UNIQUE NOT NULL,
      password_hash  TEXT NOT NULL,
      role           TEXT NOT NULL,
      reset_token    TEXT,
      reset_expires  TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
  if (DEVELOPER_EMAIL && DEVELOPER_PASSWORD) {
    if (DEVELOPER_PASSWORD.length < 8) throw new Error("DEVELOPER_ADMIN_PASSWORD має містити щонайменше 8 символів")
    const hash = await bcrypt.hash(DEVELOPER_PASSWORD, 12)
    await pool.query(`INSERT INTO users(full_name,email,password_hash,role)
      VALUES($1,$2,$3,$4) ON CONFLICT(email) DO UPDATE SET role=$4,password_hash=EXCLUDED.password_hash WHERE users.role<>$4`,
      ["Розробник платформи", DEVELOPER_EMAIL, hash, DEVELOPER_ROLE])
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS auth_attempts (
      attempt_key TEXT PRIMARY KEY,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS auth_attempts_updated_idx ON auth_attempts(updated_at);
    DELETE FROM auth_attempts WHERE updated_at < now() - interval '1 day';
    DROP TABLE IF EXISTS auth_email_challenges;
  `)

  // Додаткові поля профілю (додаються безпечно, якщо їх ще немає)
  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS phone        TEXT,
      ADD COLUMN IF NOT EXISTS department   TEXT,
      ADD COLUMN IF NOT EXISTS group_name   TEXT,
      ADD COLUMN IF NOT EXISTS about        TEXT,
      ADD COLUMN IF NOT EXISTS study_level  TEXT,
      ADD COLUMN IF NOT EXISTS course        TEXT,
      ADD COLUMN IF NOT EXISTS achievements  TEXT,
      ADD COLUMN IF NOT EXISTS photo         TEXT,
      ADD COLUMN IF NOT EXISTS position      TEXT,
      ADD COLUMN IF NOT EXISTS subjects      JSONB DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS contacts      TEXT,
      ADD COLUMN IF NOT EXISTS linkedin_url  TEXT,
      ADD COLUMN IF NOT EXISTS github_url    TEXT,
      ADD COLUMN IF NOT EXISTS portfolio_url TEXT;
  `)
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
    CREATE INDEX IF NOT EXISTS users_created_at_idx ON users(created_at DESC);
    CREATE INDEX IF NOT EXISTS users_profile_updated_at_idx ON users(profile_updated_at DESC);
  `)
  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS user_status TEXT NOT NULL DEFAULT 'available',
      ADD COLUMN IF NOT EXISTS status_message TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS news (
      id SERIAL PRIMARY KEY,
      author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'Оголошення',
      status TEXT NOT NULL DEFAULT 'draft',
      is_pinned BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE news ADD COLUMN IF NOT EXISTS author_id INTEGER;
    ALTER TABLE news ADD COLUMN IF NOT EXISTS title TEXT;
    ALTER TABLE news ADD COLUMN IF NOT EXISTS content TEXT;
    ALTER TABLE news ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'Оголошення';
    ALTER TABLE news ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'draft';
    ALTER TABLE news ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN DEFAULT false;
    ALTER TABLE news ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
    ALTER TABLE news ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
    CREATE TABLE IF NOT EXISTS news_categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS news_category_links (
      news_id INTEGER NOT NULL REFERENCES news(id) ON DELETE CASCADE,
      category_id INTEGER NOT NULL REFERENCES news_categories(id) ON DELETE CASCADE,
      PRIMARY KEY (news_id, category_id)
    );
    INSERT INTO news_categories (name) VALUES
      ('Бакалаври'), ('Магістри'), ('Аспіранти'), ('Викладачі'),
      ('Акредитація'), ('Захисти аспірантів'), ('Наукові досягнення'),
      ('Олімпіади'), ('Erasmus'), ('Активності'), ('Оголошення'),
      ('Запрошені лекції'), ('Інше')
    ON CONFLICT (name) DO NOTHING;
    INSERT INTO news_categories (name)
      SELECT DISTINCT btrim(category) FROM news
      WHERE category IS NOT NULL AND btrim(category) <> ''
    ON CONFLICT (name) DO NOTHING;
    INSERT INTO news_category_links (news_id, category_id)
      SELECT n.id, c.id FROM news n JOIN news_categories c ON c.name = n.category
      WHERE n.category IS NOT NULL AND btrim(n.category) <> ''
    ON CONFLICT DO NOTHING;
    CREATE TABLE IF NOT EXISTS news_attachments (
      id SERIAL PRIMARY KEY,
      news_id INTEGER NOT NULL REFERENCES news(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      file_data TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE news_attachments ADD COLUMN IF NOT EXISTS file_name TEXT DEFAULT 'attachment';
    ALTER TABLE news_attachments ADD COLUMN IF NOT EXISTS mime_type TEXT DEFAULT 'application/octet-stream';
    ALTER TABLE news_attachments ADD COLUMN IF NOT EXISTS file_data TEXT DEFAULT '';
    ALTER TABLE news_attachments ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
    CREATE INDEX IF NOT EXISTS news_status_pinned_idx ON news(status, is_pinned, created_at DESC);
    CREATE TABLE IF NOT EXISTS news_reactions (news_id INTEGER NOT NULL REFERENCES news(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, reaction TEXT NOT NULL DEFAULT 'like', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(news_id,user_id));
    ALTER TABLE news_reactions ADD COLUMN IF NOT EXISTS reaction TEXT DEFAULT 'like';
    ALTER TABLE news_reactions ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'like';
    UPDATE news_reactions SET reaction = COALESCE(reaction, type, 'like'), type = COALESCE(type, reaction, 'like') WHERE reaction IS NULL OR type IS NULL;
    ALTER TABLE news_reactions ALTER COLUMN reaction SET DEFAULT 'like';
    ALTER TABLE news_reactions ALTER COLUMN type SET DEFAULT 'like';
    CREATE TABLE IF NOT EXISTS news_comments (id SERIAL PRIMARY KEY, news_id INTEGER NOT NULL REFERENCES news(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, content TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS saved_news (news_id INTEGER NOT NULL REFERENCES news(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(news_id,user_id));
    ALTER TABLE saved_news ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
    CREATE TABLE IF NOT EXISTS chats (
      id SERIAL PRIMARY KEY,
      user_one_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      user_two_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      chat_type TEXT NOT NULL DEFAULT 'direct',
      title TEXT,
      description TEXT NOT NULL DEFAULT '',
      avatar TEXT NOT NULL DEFAULT '',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(user_one_id, user_two_id),
      CHECK (chat_type IN ('direct', 'group'))
    );
    ALTER TABLE chats DROP CONSTRAINT IF EXISTS chats_user_one_id_user_two_id_check;
    ALTER TABLE chats ADD COLUMN IF NOT EXISTS user_one_id INTEGER;
    ALTER TABLE chats ADD COLUMN IF NOT EXISTS user_two_id INTEGER;
    ALTER TABLE chats ALTER COLUMN user_one_id DROP NOT NULL;
    ALTER TABLE chats ALTER COLUMN user_two_id DROP NOT NULL;
    ALTER TABLE chats ADD COLUMN IF NOT EXISTS chat_type TEXT DEFAULT 'direct';
    ALTER TABLE chats ADD COLUMN IF NOT EXISTS title TEXT;
    ALTER TABLE chats ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '';
    ALTER TABLE chats ADD COLUMN IF NOT EXISTS avatar TEXT DEFAULT '';
    ALTER TABLE chats ADD COLUMN IF NOT EXISTS created_by INTEGER;
    ALTER TABLE chats ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
    CREATE UNIQUE INDEX IF NOT EXISTS chats_users_unique_idx ON chats(user_one_id, user_two_id);
    CREATE TABLE IF NOT EXISTS chat_members (
      chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      is_admin BOOLEAN NOT NULL DEFAULT false,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(chat_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS chat_members_user_chat_idx ON chat_members(user_id,chat_id);
    CREATE TABLE IF NOT EXISTS achievements (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      photo TEXT NOT NULL DEFAULT '',
      achievement_type TEXT NOT NULL DEFAULT 'Досягнення',
      event_name TEXT NOT NULL DEFAULT '',
      organizer TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      achievement_date DATE,
      result TEXT NOT NULL DEFAULT '',
      link TEXT NOT NULL DEFAULT '',
      is_public BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE achievements ADD COLUMN IF NOT EXISTS title TEXT DEFAULT '';
    ALTER TABLE achievements ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '';
    ALTER TABLE achievements ADD COLUMN IF NOT EXISTS photo TEXT DEFAULT '';
    ALTER TABLE achievements ADD COLUMN IF NOT EXISTS achievement_type TEXT NOT NULL DEFAULT 'Досягнення';
    ALTER TABLE achievements ADD COLUMN IF NOT EXISTS event_name TEXT NOT NULL DEFAULT '';
    ALTER TABLE achievements ADD COLUMN IF NOT EXISTS organizer TEXT NOT NULL DEFAULT '';
    ALTER TABLE achievements ADD COLUMN IF NOT EXISTS location TEXT NOT NULL DEFAULT '';
    ALTER TABLE achievements ADD COLUMN IF NOT EXISTS achievement_date DATE;
    ALTER TABLE achievements ADD COLUMN IF NOT EXISTS result TEXT NOT NULL DEFAULT '';
    ALTER TABLE achievements ADD COLUMN IF NOT EXISTS link TEXT NOT NULL DEFAULT '';
    ALTER TABLE achievements ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT false;
    ALTER TABLE achievements ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
    CREATE INDEX IF NOT EXISTS achievements_public_idx ON achievements(is_public, created_at DESC);
    CREATE TABLE IF NOT EXISTS activity_categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS student_activities (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category_id INTEGER NOT NULL REFERENCES activity_categories(id) ON DELETE RESTRICT,
      title TEXT NOT NULL,
      organizer TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      activity_date DATE,
      description TEXT NOT NULL DEFAULT '',
      link TEXT NOT NULL DEFAULT '',
      is_public BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS student_activities_user_idx ON student_activities(user_id, activity_date DESC, created_at DESC);
    CREATE INDEX IF NOT EXISTS student_activities_public_idx ON student_activities(is_public, activity_date DESC, created_at DESC);
    INSERT INTO activity_categories (name) VALUES
      ('Erasmus'), ('Олімпіади'), ('Конкурси'), ('Стажування'),
      ('Сертифікати'), ('Проєкти'), ('Інше')
    ON CONFLICT (name) DO NOTHING;
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL,
      event_type TEXT NOT NULL DEFAULT 'Подія',
      format TEXT NOT NULL DEFAULT 'offline',
      location TEXT NOT NULL DEFAULT '',
      starts_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,
      registration_deadline TIMESTAMPTZ,
      capacity INTEGER,
      cover_image TEXT NOT NULL DEFAULT '',
      meeting_url TEXT NOT NULL DEFAULT '',
      contact TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'cancelled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (ends_at > starts_at),
      CHECK (capacity IS NULL OR capacity > 0)
    );
    CREATE INDEX IF NOT EXISTS events_schedule_idx ON events(status, starts_at);
    CREATE INDEX IF NOT EXISTS events_creator_idx ON events(created_by, updated_at DESC);
    CREATE TABLE IF NOT EXISTS event_registrations (
      id SERIAL PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'registered' CHECK (status IN ('registered', 'waitlisted', 'cancelled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(event_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS event_registrations_queue_idx ON event_registrations(event_id, status, created_at);
    CREATE TABLE IF NOT EXISTS polls (
      id SERIAL PRIMARY KEY,
      author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      poll_type TEXT NOT NULL DEFAULT 'single' CHECK (poll_type IN ('single','multiple')),
      max_choices INTEGER NOT NULL DEFAULT 1 CHECK (max_choices > 0),
      anonymous BOOLEAN NOT NULL DEFAULT false,
      results_visibility TEXT NOT NULL DEFAULT 'after_vote' CHECK (results_visibility IN ('always','after_vote','after_close')),
      target_groups TEXT[] NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','closed')),
      opens_at TIMESTAMPTZ,
      closes_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (closes_at IS NULL OR opens_at IS NULL OR closes_at > opens_at)
    );
    CREATE INDEX IF NOT EXISTS polls_status_idx ON polls(status, closes_at, created_at DESC);
    CREATE TABLE IF NOT EXISTS poll_options (
      id SERIAL PRIMARY KEY,
      poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      UNIQUE(poll_id, position)
    );
    CREATE TABLE IF NOT EXISTS poll_ballots (
      id BIGSERIAL PRIMARY KEY,
      poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS poll_voters (
      poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ballot_id BIGINT REFERENCES poll_ballots(id) ON DELETE SET NULL,
      voted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(poll_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS poll_selections (
      ballot_id BIGINT NOT NULL REFERENCES poll_ballots(id) ON DELETE CASCADE,
      option_id INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
      PRIMARY KEY(ballot_id, option_id)
    );
    CREATE INDEX IF NOT EXISTS poll_selections_option_idx ON poll_selections(option_id);
    CREATE TABLE IF NOT EXISTS chat_messages (
      id SERIAL PRIMARY KEY,
      chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      file_name TEXT,
      file_type TEXT,
      file_data TEXT,
      attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
      edited_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS chat_id INTEGER;
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS sender_id INTEGER;
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS content TEXT DEFAULT '';
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS file_name TEXT;
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS file_type TEXT;
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS file_data TEXT;
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS topic_id INTEGER;
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
    CREATE INDEX IF NOT EXISTS chat_messages_chat_idx ON chat_messages(chat_id, created_at);
    CREATE INDEX IF NOT EXISTS chat_messages_chat_id_idx ON chat_messages(chat_id,id DESC);
    CREATE INDEX IF NOT EXISTS chat_messages_scheduled_idx ON chat_messages(scheduled_at) WHERE scheduled_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS chat_messages_pinned_idx ON chat_messages(chat_id, created_at DESC) WHERE is_pinned=true;
    CREATE TABLE IF NOT EXISTS chat_topics (
      id SERIAL PRIMARY KEY,
      chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(chat_id,name)
    );
    INSERT INTO chat_topics(chat_id,name)
      SELECT c.id,'Загальне' FROM chats c WHERE c.chat_type='group'
      AND NOT EXISTS (SELECT 1 FROM chat_topics t WHERE t.chat_id=c.id);
    UPDATE chat_messages m SET topic_id=t.id FROM chat_topics t
      WHERE m.chat_id=t.chat_id AND t.name='Загальне' AND m.topic_id IS NULL;
    CREATE TABLE IF NOT EXISTS chat_reads (
      chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      last_read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(chat_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS chat_drafts (
      chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(chat_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS ideas (
      id SERIAL PRIMARY KEY, author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL, category TEXT NOT NULL, problem TEXT NOT NULL, solution TEXT NOT NULL,
      benefit TEXT NOT NULL DEFAULT '', audience TEXT NOT NULL DEFAULT 'Усім працівникам',
      visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','staff')),
      is_anonymous BOOLEAN NOT NULL DEFAULT false, status TEXT NOT NULL DEFAULT 'Нова',
      status_note TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS idea_votes (
      idea_id INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (idea_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS idea_comments (
      id SERIAL PRIMARY KEY, idea_id INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS idea_status_history (
      id SERIAL PRIMARY KEY, idea_id INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, from_status TEXT NOT NULL,
      to_status TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS ideas_status_updated_idx ON ideas(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS ideas_category_idx ON ideas(category, created_at DESC);
    CREATE INDEX IF NOT EXISTS idea_comments_idea_idx ON idea_comments(idea_id, created_at);
  `)
  console.log("Таблиці users і news готові")
}

function isAllowedEmail(email) {
  return typeof email === "string" && (email.toLowerCase().trim() === DEVELOPER_EMAIL || ALLOWED_DOMAINS.some((domain) => email.toLowerCase().trim().endsWith(domain)))
}

const AUTH_MAX_FAILURES = 5
const AUTH_LOCK_MINUTES = 10

function authAttemptKey(_req, email) {
  if (typeof email !== "string" || !email.trim()) return null
  return crypto.createHash("sha256").update(email.toLowerCase().trim()).digest("hex")
}

async function activeAuthLock(key) {
  if (!key) return null
  const result = await pool.query("SELECT locked_until FROM auth_attempts WHERE attempt_key=$1 AND locked_until > now()", [key])
  if (!result.rows.length) return null
  const seconds = Math.max(1, Math.ceil((new Date(result.rows[0].locked_until).getTime() - Date.now()) / 1000))
  return { locked: true, retryAfterSeconds: seconds, error: `Забагато невдалих спроб. Спробуйте ще раз через ${Math.ceil(seconds / 60)} хв.` }
}

async function recordAuthFailure(key) {
  if (!key) return 0
  const result = await pool.query(`
    INSERT INTO auth_attempts (attempt_key, failed_attempts, updated_at)
    VALUES ($1, 1, now())
    ON CONFLICT (attempt_key) DO UPDATE SET
      failed_attempts = CASE
        WHEN auth_attempts.updated_at < now() - interval '10 minutes'
          OR (auth_attempts.locked_until IS NOT NULL AND auth_attempts.locked_until <= now()) THEN 1
        ELSE auth_attempts.failed_attempts + 1
      END,
      locked_until = CASE
        WHEN auth_attempts.updated_at < now() - interval '10 minutes'
          OR (auth_attempts.locked_until IS NOT NULL AND auth_attempts.locked_until <= now()) THEN NULL
        ELSE auth_attempts.locked_until
      END,
      updated_at = now()
    RETURNING failed_attempts
  `, [key])
  const attempts = Number(result.rows[0].failed_attempts)
  if (attempts >= AUTH_MAX_FAILURES) {
    await pool.query(`UPDATE auth_attempts SET locked_until=COALESCE(locked_until, now() + ($2 * interval '1 minute')) WHERE attempt_key=$1`, [key, AUTH_LOCK_MINUTES])
  }
  return attempts
}

async function clearAuthFailures(key) {
  if (key) await pool.query("DELETE FROM auth_attempts WHERE attempt_key=$1", [key])
}

async function respondAuthFailure(req, res, email, status, message) {
  const attempts = await recordAuthFailure(authAttemptKey(req, email))
  if (attempts >= AUTH_MAX_FAILURES) {
    return res.status(429).json({
      error: `Забагато невдалих спроб. Доступ заблоковано на ${AUTH_LOCK_MINUTES} хвилин.`,
      locked: true,
      retryAfterSeconds: AUTH_LOCK_MINUTES * 60,
    })
  }
  return res.status(status).json({ error: message, attemptsLeft: Math.max(0, AUTH_MAX_FAILURES - attempts) })
}

async function rejectIfAuthLocked(req, res, email) {
  const lock = await activeAuthLock(authAttemptKey(req, email))
  if (lock) res.status(429).json(lock)
  return Boolean(lock)
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, full_name: user.full_name },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN },
  )
}

function setAuthCookie(res, token) {
  res.cookie("token", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: false, // preview працює по http
    maxAge: 7 * 24 * 60 * 60 * 1000,
  })
}

function publicUser(u) {
  const isStudent = u.role === "Студент"

  // Предмети зберігаються як JSONB → нормалізуємо у масив
  let subjects = []
  if (Array.isArray(u.subjects)) subjects = u.subjects
  else if (typeof u.subjects === "string" && u.subjects.trim()) {
    try {
      const parsed = JSON.parse(u.subjects)
      if (Array.isArray(parsed)) subjects = parsed
    } catch {
      subjects = []
    }
  }

  // Заповненість профілю залежить від ролі:
  //  • студент — по��рібні група і курс
  //  • викладач/інші — потрібні посада і кафедра
  const profileComplete = isStudent
    ? Boolean(u.group_name && u.group_name.trim() && u.study_level && u.study_level.trim() && u.course && String(u.course).trim() && u.phone && u.phone.trim() && u.about && u.about.trim())
    : Boolean(u.position && u.position.trim() && u.department && u.department.trim() && u.phone && u.phone.trim() && u.about && u.about.trim())

  // Сторінка профілю, що відповідає ролі
  const redirect = isStudent ? "/profileStudent" : "/profileTeacher"

  return {
    id: u.id,
    full_name: u.full_name,
    email: u.email,
    role: u.role,
    phone: u.phone || "",
    department: u.department || "",
    group_name: u.group_name || "",
    about: u.about || "",
    study_level: u.study_level || "",
    course: u.course || "",
    achievements: u.achievements || "",
    photo: u.photo || "",
    position: u.position || "",
    subjects,
    contacts: u.contacts || "",
    linkedin_url: u.linkedin_url || "",
    github_url: u.github_url || "",
    portfolio_url: u.portfolio_url || "",
    presence_status: effectivePresence(u.user_status, u.last_seen, u.last_active_at),
    status_message: u.status_message || "",
    last_seen: u.last_seen || null,
    profile_complete: profileComplete,
    redirect,
    created_at: u.created_at,
  }
}

// Мідлвеар авторизації (вбудований у цей файл)
function isPlatformAdmin(user) { return String(user?.role || "").trim() === DEVELOPER_ROLE }
function developerOnly(req,res,next) { if (!isPlatformAdmin(req.user)) return res.status(403).json({error:"Дія доступна лише розробнику платформи"}); next() }
async function authRequired(req, res, next) {
  const token = req.cookies?.token || (req.headers.authorization || "").replace("Bearer ", "")
  if (!token) return res.status(401).json({ error: "Не авторизовано" })
  try {
    req.user = jwt.verify(token, JWT_SECRET)
  } catch {
    return res.status(401).json({ error: "Недійсний або протермінований токен" })
  }
  try {
    // JWT є stateless, тому після видалення акаунта старий токен інакше ще діяв би до 7 днів.
    const account = await pool.query("SELECT id,role,email,full_name FROM users WHERE id = $1", [req.user.id])
    if (!account.rows.length) {
      res.clearCookie("token")
      return res.status(401).json({ error: "Обліковий запис більше не існує" })
    }
    Object.assign(req.user, account.rows[0])
    return next()
  } catch (err) {
    console.error("auth account check error:", err.message)
    return res.status(503).json({ error: "Не вдалося перевірити сесію. Спробуйте пізніше." })
  }
}

let inFlightRequests = 0
const maxConcurrentRequests = Math.max(20, Math.min(1000, Number.parseInt(process.env.MAX_CONCURRENT_REQUESTS || "50", 10) || 50))
const maxConcurrentMediaDownloads = Math.max(2, Math.min(50, Number.parseInt(process.env.MAX_CONCURRENT_MEDIA_DOWNLOADS || "8", 10) || 8))
let activeMediaDownloads = 0
app.use((req, res, next) => {
  if (inFlightRequests >= maxConcurrentRequests) {
    res.setHeader("Retry-After", "2")
    return res.status(503).json({ error: "Сервер зараз обробляє багато запитів. Спробуйте ще раз за кілька секунд." })
  }
  inFlightRequests += 1
  let released = false
  const release = () => {
    if (released) return
    released = true
    inFlightRequests = Math.max(0, inFlightRequests - 1)
  }
  res.once("finish", release)
  res.once("close", release)
  next()
})
app.use(express.json({ limit: "16mb" }))
app.use(cookieParser())
app.get("/dean-dashboard.html", authRequired, deanOnly, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dean-dashboard.html"))
})
app.use(express.static(path.join(__dirname, "public")))


app.post("/api/register", async (req, res) => {
  try {
    const { full_name, email, password, role } = req.body || {}
    const cleanName=typeof full_name==="string"?full_name.trim():""
    const normEmail = typeof email === "string" ? email.toLowerCase().trim() : ""
    if (await rejectIfAuthLocked(req, res, normEmail)) return
    if (!cleanName || cleanName.length>160 || !normEmail || !password || !role) return await respondAuthFailure(req,res,normEmail,400,"Заповніть усі поля коректно")
    if (!isAllowedEmail(normEmail)) return await respondAuthFailure(req,res,normEmail,400,`Дозволена реєстрація лише з поштою ${ALLOWED_DOMAINS_LABEL}`)
    if (!VALID_ROLES.filter(candidate=>candidate!==DEVELOPER_ROLE).includes(role)) return await respondAuthFailure(req,res,normEmail,400,"Невірна роль")
    if (String(password).length<6) return await respondAuthFailure(req,res,normEmail,400,"Пароль має містити щонайменше 6 символів")
    const exists=await pool.query("SELECT id FROM users WHERE email=$1",[normEmail])
    if(exists.rows.length)return await respondAuthFailure(req,res,normEmail,409,"Користувач з такою поштою вже існує")
    const passwordHash=await bcrypt.hash(password,10)
    const created=await pool.query(`INSERT INTO users(full_name,email,password_hash,role) VALUES($1,$2,$3,$4) RETURNING *`,[cleanName,normEmail,passwordHash,role])
    const user=created.rows[0],token=signToken(user)
    setAuthCookie(res,token)
    res.status(201).json({message:"Акаунт створено",token,user:publicUser(user)})
  } catch (err) {
    console.error("register error:", err.message)
    res.status(500).json({ error:"Не вдалося створити акаунт" })
  }
})

// Пароль перевіряється перед створенням сесії.
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body || {}
    const normEmail = typeof email === "string" ? email.toLowerCase().trim() : ""
    if (await rejectIfAuthLocked(req, res, normEmail)) return
    if (!normEmail || !password) return await respondAuthFailure(req,res,normEmail,400,"Введіть пошту та пароль")
    if (!isAllowedEmail(normEmail)) return await respondAuthFailure(req,res,normEmail,400,`Дозволений вхід лише з поштою ${ALLOWED_DOMAINS_LABEL}`)
    const result=await pool.query("SELECT * FROM users WHERE email=$1",[normEmail])
    if(!result.rows.length)return await respondAuthFailure(req,res,normEmail,401,"Невірна пошта або пароль")
    const user=result.rows[0]
    if(!(await bcrypt.compare(password,user.password_hash)))return await respondAuthFailure(req,res,normEmail,401,"Невірна пошта або пароль")
    await clearAuthFailures(authAttemptKey(req,normEmail))
    const token=signToken(user)
    setAuthCookie(res,token)
    res.json({message:"Вхід виконано",token,user:publicUser(user)})
  } catch (err) {
    console.error("login error:", err.message)
    res.status(500).json({error:"Не вдалося виконати вхід"})
  }
})

// Вихід
app.post("/api/logout", (req, res) => {
  res.clearCookie("token")
  res.json({ message: "Ви вийшли з системи" })
})

// Поточний користувач (перевірка JWT)
app.get("/api/me", authRequired, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM users WHERE id = $1", [req.user.id])
    if (result.rows.length === 0) return res.status(404).json({ error: "Користувача не знайдено" })
    const user = publicUser(result.rows[0])
    res.json({ user, redirect: user.redirect })
  } catch (err) {
    console.error("me error:", err.message)
    res.status(500).json({ error: "Помилка сервера" })
  }
})

// Остаточне видалення акаунта: повторна перевірка пароля, email і явної фрази-підтвердження.
app.delete("/api/account", authRequired, async (req, res) => {
  const password = typeof req.body?.password === "string" ? req.body.password : ""
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : ""
  const confirmation = typeof req.body?.confirmation === "string" ? req.body.confirmation.trim() : ""

  if (!password || !email || confirmation !== "ВИДАЛИТИ") {
    return res.status(400).json({ error: "Введіть пароль, email акаунта та слово «ВИДАЛИТИ» для підтвердження." })
  }

  let client
  try {
    client = await pool.connect()
    await client.query("BEGIN")
    const found = await client.query("SELECT id, email, password_hash FROM users WHERE id = $1 FOR UPDATE", [req.user.id])
    if (!found.rows.length) {
      await client.query("ROLLBACK")
      res.clearCookie("token")
      return res.status(404).json({ error: "Обліковий запис уже видалено." })
    }
    const account = found.rows[0]
    const emailMatches = account.email.toLowerCase() === email
    const passwordMatches = await bcrypt.compare(password, account.password_hash)
    if (!emailMatches || !passwordMatches) {
      await client.query("ROLLBACK")
      return res.status(403).json({ error: "Email або пароль не збігається. Акаунт не видалено." })
    }

    // Чистимо дочірні записи явно: на старих інсталяціях частина колонок могла бути додана міграцією без FK.
    await client.query("DELETE FROM news_attachments WHERE news_id IN (SELECT id FROM news WHERE author_id = $1)", [account.id])
    await client.query("DELETE FROM news_category_links WHERE news_id IN (SELECT id FROM news WHERE author_id = $1)", [account.id])
    await client.query("DELETE FROM news_reactions WHERE user_id = $1 OR news_id IN (SELECT id FROM news WHERE author_id = $1)", [account.id])
    await client.query("DELETE FROM news_comments WHERE user_id = $1 OR news_id IN (SELECT id FROM news WHERE author_id = $1)", [account.id])
    await client.query("DELETE FROM saved_news WHERE user_id = $1 OR news_id IN (SELECT id FROM news WHERE author_id = $1)", [account.id])
    await client.query("DELETE FROM news WHERE author_id = $1", [account.id])

    const directChats = "SELECT id FROM chats WHERE user_one_id = $1 OR user_two_id = $1"
    await client.query(`DELETE FROM chat_messages WHERE chat_id IN (${directChats})`, [account.id])
    await client.query(`DELETE FROM chat_reads WHERE chat_id IN (${directChats})`, [account.id])
    await client.query(`DELETE FROM chat_members WHERE chat_id IN (${directChats})`, [account.id])
    await client.query(`DELETE FROM chats WHERE id IN (${directChats})`, [account.id])
    await client.query("DELETE FROM chat_messages WHERE sender_id = $1", [account.id])
    await client.query("DELETE FROM chat_reads WHERE user_id = $1", [account.id])
    await client.query("DELETE FROM chat_members WHERE user_id = $1", [account.id])
    await client.query("DELETE FROM chats c WHERE c.chat_type = 'group' AND c.created_by = $1 AND NOT EXISTS (SELECT 1 FROM chat_members m WHERE m.chat_id = c.id)", [account.id])
    await client.query("UPDATE chats SET created_by = NULL WHERE created_by = $1", [account.id])
    await client.query("DELETE FROM achievements WHERE user_id = $1", [account.id])
    await client.query("DELETE FROM student_activities WHERE user_id = $1", [account.id])
    await client.query("DELETE FROM event_registrations WHERE user_id = $1", [account.id])
    await client.query("UPDATE events SET created_by = NULL WHERE created_by = $1", [account.id])

    // Решта полів акаунта та можливі дочірні записи видаляються FK ON DELETE CASCADE.
    await client.query("DELETE FROM users WHERE id = $1", [account.id])
    await client.query("COMMIT")
    res.clearCookie("token")
    return res.json({ message: "Акаунт і пов'язані з ним дані видалено." })
  } catch (err) {
    if (client) await client.query("ROLLBACK").catch(() => {})
    console.error("account deletion error:", err.message)
    return res.status(500).json({ error: "Не вдалося видалити акаунт. Дані залишилися без змін; спробуйте пізніше." })
  } finally {
    client?.release()
  }
})

app.get("/api/presence", authRequired, async (req, res) => {
  try {
    const result = await pool.query("SELECT user_status, status_message, last_seen, last_active_at FROM users WHERE id=$1", [req.user.id])
    if (!result.rows.length) return res.status(404).json({ error: "Користувача не знайдено" })
    const user = result.rows[0]
    res.json({ presence_status: effectivePresence(user.user_status, user.last_seen, user.last_active_at), status_message: user.status_message || "", last_seen: user.last_seen })
  } catch (err) {
    console.error("presence read error:", err.message)
    res.status(500).json({ error: "Не вдалося завантажити статус" })
  }
})

app.put("/api/presence", authRequired, async (req, res) => {
  const status = String(req.body?.user_status || "").trim()
  const message = String(req.body?.status_message || "").trim()
  if (!PRESENCE_STATUSES.includes(status)) return res.status(400).json({ error: "Оберіть статус зі списку" })
  if (message.length > 80) return res.status(400).json({ error: "Підпис до статусу має містити не більше 80 символів" })
  try {
    const result = await pool.query(`UPDATE users SET user_status=$1, status_message=$2, last_seen=now(), last_active_at=now()
      WHERE id=$3 RETURNING user_status, status_message, last_seen, last_active_at`, [status, message, req.user.id])
    if (!result.rows.length) return res.status(404).json({ error: "Користувача не знайдено" })
    const user = result.rows[0]
    res.json({ presence_status: effectivePresence(user.user_status, user.last_seen, user.last_active_at), status_message: user.status_message, last_seen: user.last_seen })
  } catch (err) {
    console.error("presence update error:", err.message)
    res.status(500).json({ error: "Не вдалося оновити статус" })
  }
})

app.post("/api/presence/ping", authRequired, async (req, res) => {
  try {
    const result = await pool.query(`UPDATE users SET last_seen=now(), last_active_at=CASE WHEN $1 THEN now() ELSE last_active_at END
      WHERE id=$2 RETURNING user_status, status_message, last_seen, last_active_at`, [req.body?.active === true, req.user.id])
    const user = result.rows[0]
    res.json({ ok: true, presence_status: effectivePresence(user.user_status, user.last_seen, user.last_active_at), status_message: user.status_message || "" })
  } catch (err) {
    console.error("presence ping error:", err.message)
    res.status(500).json({ error: "Не вдалося оновити присутність" })
  }
})

// Оновлення профілю — приймає будь-який набір полів (студент або викладач),
// оновлюються лише передані поля, решта лишається без змін.
app.put("/api/profile", authRequired, async (req, res) => {
  try {
    const body = req.body || {}

    // Поточний запис — щоб оновити тільки передані поля (merge)
    const current = await pool.query("SELECT * FROM users WHERE id = $1", [req.user.id])
    if (current.rows.length === 0) return res.status(404).json({ error: "Користувача не знайдено" })
    const u = current.rows[0]

    // Дозволені текстові поля профілю
    const textFields = [
      "full_name",
      "phone",
      "department",
      "group_name",
      "about",
      "study_level",
      "course",
      "achievements",
      "photo",
      "position",
      "contacts",
      "linkedin_url",
      "github_url",
      "portfolio_url",
    ]

    const nextValues = {}
    for (const key of textFields) {
      nextValues[key] = key in body ? (body[key] == null ? "" : String(body[key])) : u[key]
    }

    for (const key of ["linkedin_url", "github_url", "portfolio_url"]) {
      const value = String(nextValues[key] || "").trim()
      if (value.length > 500 || (value && !/^https?:\/\//i.test(value))) {
        return res.status(400).json({ error: "Посилання в профілі має починатися з http:// або https:// та містити не більше 500 символів" })
      }
      nextValues[key] = value
    }

    // ПІБ не має ставати порожнім
    const fullName = (nextValues.full_name || "").trim() || u.full_name

    // Предмети (масив) → JSONB
    const subjects = Array.isArray(body.subjects)
      ? JSON.stringify(body.subjects)
      : JSON.stringify(Array.isArray(u.subjects) ? u.subjects : [])

    const result = await pool.query(
      `UPDATE users SET
         full_name = $1,
         phone = $2,
         department = $3,
         group_name = $4,
         about = $5,
         study_level = $6,
         course = $7,
         achievements = $8,
         photo = $9,
         position = $10,
         contacts = $11,
         subjects = $12::jsonb,
         linkedin_url = $13,
         github_url = $14,
         portfolio_url = $15,
         profile_updated_at = now()
       WHERE id = $16
       RETURNING *`,
      [
        fullName,
        nextValues.phone,
        nextValues.department,
        nextValues.group_name,
        nextValues.about,
        nextValues.study_level,
        nextValues.course,
        nextValues.achievements,
        nextValues.photo,
        nextValues.position,
        nextValues.contacts,
        subjects,
        nextValues.linkedin_url,
        nextValues.github_url,
        nextValues.portfolio_url,
        req.user.id,
      ],
    )
    res.json({ message: "Профіль оновлено", user: publicUser(result.rows[0]) })
  } catch (err) {
    console.error("profile error:", err.message)
    res.status(500).json({ error: "Помилка сервера при оновленні проф��лю" })
  }
})

// Відновлення пароля — крок 1: запит токена
app.post("/api/forgot-password", async (req, res) => {
  try {
    const { email } = req.body || {}
    if (!email) return res.status(400).json({ error: "Введіть пошту" })
    if (!isAllowedEmail(email)) {
      return res.status(400).json({ error: `Дозволена лише пошта ${ALLOWED_DOMAINS_LABEL}` })
    }

    const normEmail = email.toLowerCase().trim()
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [normEmail])

    // Завжди повертаємо однакову відповідь, щоб не розкривати наявність акаунта
    if (result.rows.length === 0) {
      return res.json({ message: "Якщо акаунт існує, токен відновлення згенеровано" })
    }

    const token = crypto.randomBytes(24).toString("hex")
    const expires = new Date(Date.now() + 60 * 60 * 1000) // 1 година
    await pool.query("UPDATE users SET reset_token = $1, reset_expires = $2 WHERE email = $3", [
      token,
      expires,
      normEmail,
    ])

    // У реальній системі токен надсилається на пошту.
    // Для демо пове��таємо його у відповіді.
    res.json({
      message: "Токен відновлення згенеровано (у реальній системі надсилається на пошту)",
      reset_token: token,
    })
  } catch (err) {
    console.error("forgot error:", err.message)
    res.status(500).json({ error: "Помилка сервера" })
  }
})

// Відновлення пароля — крок 2: встановлення ��ового пароля
app.post("/api/reset-password", async (req, res) => {
  try {
    const { token, password } = req.body || {}
    if (!token || !password) return res.status(400).json({ error: "Вкажіть токен та новий пароль" })
    if (String(password).length < 6) {
      return res.status(400).json({ error: "Пароль має містити щонайменше 6 символів" })
    }

    const result = await pool.query(
      "SELECT * FROM users WHERE reset_token = $1 AND reset_expires > now()",
      [token],
    )
    if (result.rows.length === 0) {
      return res.status(400).json({ error: "Недійсний або протермінований токен" })
    }

    const hash = await bcrypt.hash(password, 10)
    await pool.query(
      "UPDATE users SET password_hash = $1, reset_token = NULL, reset_expires = NULL WHERE id = $2",
      [hash, result.rows[0].id],
    )
    res.json({ message: "Пароль успішно змінено. Тепер увійдіть з новим паролем." })
  } catch (err) {
    console.error("reset error:", err.message)
    res.status(500).json({ error: "Помилка сервера" })
  }
})

const NEWS_MAX_FILE = 5 * 1024 * 1024
const NEWS_AUTHOR_ROLES = [DEVELOPER_ROLE, "ДеканФІКТ", "Завідувач Кафедри", "Викладач"]
function deanOnly(req, res, next) {
  if (String(req.user.role || "").trim() !== "ДеканФІКТ" && !isPlatformAdmin(req.user)) return res.status(403).json({ error: "Дашборд доступний адміністраторам платформи та декану ФІКТ" })
  next()
}
// Факультетська адмінка: усі зміни користувачів доступні тільки ролі декана.
app.get("/api/dean/users", authRequired, deanOnly, async (req, res) => {
  try {
    const result = await pool.query(`SELECT id,full_name,email,role,phone,department,group_name,position,course,study_level,created_at,profile_updated_at FROM users ORDER BY role,full_name`)
    res.json({ users: result.rows })
  } catch (err) { console.error("dean users list error:", err.message); res.status(500).json({ error: "Не вдалося завантажити користувачів" }) }
})
app.post("/api/dean/users", authRequired, deanOnly, async (req, res) => {
  try {
    const b = req.body || {}, fullName = String(b.full_name || "").trim(), email = String(b.email || "").trim().toLowerCase(), role = String(b.role || "").trim(), password = String(b.password || "")
    if (!fullName || fullName.length > 160 || !isAllowedEmail(email) || !VALID_ROLES.includes(role) || (role === DEVELOPER_ROLE && !isPlatformAdmin(req.user)) || (password && password.length < 8)) return res.status(400).json({ error: `Перевірте ім’я, адресу з доменом ${ALLOWED_DOMAINS_LABEL}, роль і пароль (якщо задано — не менше 8 символів)` })
    const setupToken = password ? null : crypto.randomBytes(32).toString("hex")
    const hash = await bcrypt.hash(password || crypto.randomBytes(32).toString("base64url"), 10)
    const result = await pool.query(`INSERT INTO users(full_name,email,password_hash,role,department,group_name,position,phone,course,study_level,reset_token,reset_expires) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $11::text IS NULL THEN NULL ELSE now()+interval '7 days' END) RETURNING id,full_name,email,role,department,group_name,position,phone,course,study_level,created_at,profile_updated_at`, [fullName,email,hash,role,String(b.department||"").trim(),String(b.group_name||"").trim(),String(b.position||"").trim(),String(b.phone||"").trim(),String(b.course||"").trim(),String(b.study_level||"").trim(),setupToken])
    res.status(201).json({ user: result.rows[0], setupToken })
  } catch (err) { if (err.code === "23505") return res.status(409).json({ error: "Користувач із такою адресою вже існує" }); console.error("dean user create error:", err.message); res.status(500).json({ error: "Не вдалося створити користувача" }) }
})
app.put("/api/dean/users/:id", authRequired, deanOnly, async (req, res) => {
  try {
    const b=req.body||{}, fullName=String(b.full_name||"").trim(), email=String(b.email||"").trim().toLowerCase(), role=String(b.role||"").trim()
    if (!fullName || fullName.length>160 || !isAllowedEmail(email) || !VALID_ROLES.includes(role) || (role===DEVELOPER_ROLE && !isPlatformAdmin(req.user))) return res.status(400).json({error:`Перевірте ім’я, адресу з доменом ${ALLOWED_DOMAINS_LABEL} і роль`})
    if (b.password && String(b.password).length<8) return res.status(400).json({error:"Пароль має містити щонайменше 8 символів"})
    if (Number(req.params.id)===req.user.id && ((isPlatformAdmin(req.user) && role!==DEVELOPER_ROLE) || (!isPlatformAdmin(req.user) && role!=="ДеканФІКТ"))) return res.status(400).json({error:"Не можна змінити власну адміністративну роль"})
    const result=await pool.query(`UPDATE users SET full_name=$1,email=$2,role=$3,department=$4,group_name=$5,position=$6,phone=$7,course=$8,study_level=$9,profile_updated_at=now() WHERE id=$10 RETURNING id,full_name,email,role,department,group_name,position,phone,course,study_level,created_at,profile_updated_at`,[fullName,email,role,String(b.department||"").trim(),String(b.group_name||"").trim(),String(b.position||"").trim(),String(b.phone||"").trim(),String(b.course||"").trim(),String(b.study_level||"").trim(),req.params.id])
    if(!result.rows.length)return res.status(404).json({error:"Користувача не знайдено"})
    if (b.password) await pool.query("UPDATE users SET password_hash=$1,reset_token=NULL,reset_expires=NULL WHERE id=$2",[await bcrypt.hash(String(b.password),10),req.params.id])
    res.json({user:result.rows[0]})
  } catch(err){if(err.code==="23505")return res.status(409).json({error:"Користувач із такою адресою вже існує"}); console.error("dean user update error:",err.message);res.status(500).json({error:"Не вдалося зберегти користувача"})}
})
app.delete("/api/dean/users/:id", authRequired, deanOnly, async (req,res)=>{
  const id=Number(req.params.id)
  if(!Number.isInteger(id)||id===req.user.id)return res.status(400).json({error:"Неможливо видалити власний обліковий запис"})
  const client=await pool.connect()
  try {
    await client.query("BEGIN")
    const target=await client.query("SELECT id,role FROM users WHERE id=$1 FOR UPDATE",[id])
    if(!target.rows.length){await client.query("ROLLBACK");return res.status(404).json({error:"Користувача не знайдено"})}
    if(target.rows[0].role==="ДеканФІКТ") {const other=await client.query("SELECT 1 FROM users WHERE role='ДеканФІКТ' AND id<>$1 LIMIT 1",[id]); if(!other.rows.length){await client.query("ROLLBACK");return res.status(409).json({error:"Не можна видалити останній обліковий запис декана"})}}
    await client.query("DELETE FROM chat_reads WHERE user_id=$1",[id]); await client.query("DELETE FROM chat_members WHERE user_id=$1",[id]); await client.query("DELETE FROM chats WHERE chat_type='direct' AND (user_one_id=$1 OR user_two_id=$1)",[id]); await client.query("UPDATE chats SET created_by=NULL WHERE created_by=$1",[id]);
    await client.query("DELETE FROM news_attachments WHERE news_id IN (SELECT id FROM news WHERE author_id=$1)",[id]); await client.query("DELETE FROM news WHERE author_id=$1",[id]);
    await client.query("DELETE FROM achievements WHERE user_id=$1",[id]); await client.query("DELETE FROM student_activities WHERE user_id=$1",[id]); await client.query("DELETE FROM event_registrations WHERE user_id=$1",[id]); await client.query("UPDATE events SET created_by=NULL WHERE created_by=$1",[id]);
    await client.query("DELETE FROM users WHERE id=$1",[id]); await client.query("COMMIT"); res.json({message:"Користувача та пов’язані з ним персональні записи видалено"})
  }catch(err){await client.query("ROLLBACK").catch(()=>{});console.error("dean user delete error:",err.message);res.status(500).json({error:"Не вдалося видалити користувача"})}finally{client.release()}
})
function newsAuthorOnly(req, res, next) {
  if (!NEWS_AUTHOR_ROLES.includes(String(req.user.role || "").trim())) return res.status(403).json({ error: "Створювати новини можуть лише уповноважені працівники" })
  next()
}
function studentExtractOnly(req, res, next) {
  if (!NEWS_AUTHOR_ROLES.includes(String(req.user.role || "").trim())) return res.status(403).json({ error: "Витяг доступний лише викладачам та уповноваженим працівникам" })
  next()
}
function cleanNewsPayload(body) {
  const title = String(body.title || "").trim()
  const content = String(body.content || "").trim()
  const categories = Array.from(new Set((Array.isArray(body.categories) ? body.categories : [])
    .map((name) => String(name || "").trim().replace(/\s+/g, " "))
    .filter((name) => name.length > 0 && name.length <= 80))).slice(0, 12)
  const status = body.status === "published" ? "published" : "draft"
  return { title, content, categories: categories.length ? categories : ["Оголошення"], status, is_pinned: Boolean(body.is_pinned) }
}
async function setNewsCategories(client, newsId, names) {
  const normalized = Array.from(new Set(names.map((name) => String(name).trim()))).filter(Boolean)
  for (const name of normalized) {
    const category = await client.query(
      "INSERT INTO news_categories(name) VALUES($1) ON CONFLICT(name) DO UPDATE SET name=EXCLUDED.name RETURNING id,name",
      [name],
    )
    await client.query("INSERT INTO news_category_links(news_id,category_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [newsId, category.rows[0].id])
  }
}
app.get("/api/news/categories", async (req, res) => {
  try {
    const result = await pool.query(`SELECT c.id, c.name, COUNT(l.news_id)::int AS news_count
      FROM news_categories c LEFT JOIN news_category_links l ON l.category_id=c.id
      GROUP BY c.id ORDER BY c.name`)
    res.json({ categories: result.rows })
  } catch (err) { console.error("news categories error:", err.message); res.status(500).json({ error: "Не вдалося завантажити категорії" }) }
})
app.post("/api/news/categories", authRequired, newsAuthorOnly, async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim().replace(/\s+/g, " ")
    if (!name || name.length > 80 || name.includes(",")) return res.status(400).json({ error: "Назва категорії має містити від 1 до 80 символів і не містити кому" })
    const result = await pool.query("INSERT INTO news_categories(name) VALUES($1) ON CONFLICT(name) DO UPDATE SET name=EXCLUDED.name RETURNING id,name", [name])
    res.status(201).json({ category: result.rows[0] })
  } catch (err) { console.error("news category create error:", err.message); res.status(500).json({ error: "Не вдалося створити категорію" }) }
})
app.put("/api/news/categories/:id", authRequired, newsAuthorOnly, async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim().replace(/\\s+/g, " ")
    if (!name || name.length > 80 || name.includes(",")) return res.status(400).json({ error: "Назва категорії має містити від 1 до 80 символів і не містити кому" })
    const result = await pool.query("UPDATE news_categories SET name=$1 WHERE id=$2 RETURNING id,name", [name, req.params.id])
    if (!result.rows.length) return res.status(404).json({ error: "Категорію не знайдено" })
    await pool.query("UPDATE news SET category=$1 WHERE id IN (SELECT news_id FROM news_category_links WHERE category_id=$2)", [name, req.params.id])
    res.json({ category: result.rows[0] })
  } catch (err) { if (err.code === "23505") return res.status(409).json({ error: "Така категорія вже існує" }); console.error("news category update error:", err.message); res.status(500).json({ error: "Не вдалося перейменувати категорію" }) }
})
app.delete("/api/news/categories/:id", authRequired, newsAuthorOnly, async (req, res) => {
  try {
    const used = await pool.query("SELECT 1 FROM news_category_links WHERE category_id=$1 LIMIT 1", [req.params.id])
    if (used.rows.length) return res.status(409).json({ error: "Категорію не можна видалити, поки вона використовується новинами" })
    const result = await pool.query("DELETE FROM news_categories WHERE id=$1 RETURNING id", [req.params.id])
    if (!result.rows.length) return res.status(404).json({ error: "Категорію не знайдено" })
    res.json({ message: "Категорію видалено" })
  } catch (err) { console.error("news category delete error:", err.message); res.status(500).json({ error: "Не вдалося видалити категорію" }) }
})
app.get("/api/news", async (req, res) => {
  try {
    let viewerId = -1, viewerRole = ""
    if (req.cookies?.token) { try { const viewer = jwt.verify(req.cookies.token, JWT_SECRET); viewerId = viewer.id; viewerRole = viewer.role } catch {} }
    const result = await pool.query(`SELECT n.*, u.full_name AS author_name,
      COALESCE(json_agg(json_build_object('id', a.id, 'file_name', a.file_name, 'mime_type', a.mime_type)) FILTER (WHERE a.id IS NOT NULL), '[]') AS attachments,
      COALESCE((SELECT json_agg(json_build_object('id', c.id, 'name', c.name) ORDER BY c.name)
        FROM news_category_links l JOIN news_categories c ON c.id=l.category_id WHERE l.news_id=n.id), '[]') AS categories,
      (SELECT COUNT(*) FROM news_reactions r WHERE r.news_id=n.id) AS reactions_count,
      EXISTS(SELECT 1 FROM news_reactions r WHERE r.news_id=n.id AND r.user_id=$1) AS reacted
      FROM news n JOIN users u ON u.id = n.author_id LEFT JOIN news_attachments a ON a.news_id = n.id
      WHERE n.status = 'published' OR n.author_id = $1 OR $2 IN ('ДеканФІКТ','${DEVELOPER_ROLE}') GROUP BY n.id, u.full_name
      ORDER BY n.is_pinned DESC, n.created_at DESC`, [viewerId, viewerRole])
    res.json({ news: result.rows })
  } catch (err) { console.error("news list error:", err.message); res.status(500).json({ error: "Не вдалося завантажити новини" }) }
})
app.get("/news/export", authRequired, newsAuthorOnly, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "news-export.html"))
})
app.get("/students/export", authRequired, studentExtractOnly, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "student-extract.html"))
})
app.post("/api/news/:id/reaction", authRequired, async (req, res) => {
  try {
    const news = await pool.query("SELECT id FROM news WHERE id=$1 AND status='published'", [req.params.id])
    if (!news.rows.length) return res.status(404).json({ error: "Опубліковану новину не знайдено" })
    const exists = await pool.query("SELECT 1 FROM news_reactions WHERE news_id=$1 AND user_id=$2", [req.params.id, req.user.id])
    if (exists.rows.length) await pool.query("DELETE FROM news_reactions WHERE news_id=$1 AND user_id=$2", [req.params.id, req.user.id])
    else await pool.query("INSERT INTO news_reactions(news_id,user_id,reaction,type) VALUES($1,$2,'like','like')", [req.params.id, req.user.id])
    res.json({ reacted: !exists.rows.length })
  } catch (err) {
    console.error("reaction error:", err.message)
    res.status(500).json({ error: "Не вдалося зберегти реакцію" })
  }
})
app.post("/api/news/:id/save", authRequired, async (req, res) => {
  try {
    const published = await pool.query("SELECT id FROM news WHERE id=$1 AND status='published'", [req.params.id])
    if (!published.rows.length) return res.status(404).json({ error: "Опубліковану новину не знайдено" })
    const exists = await pool.query("SELECT 1 FROM saved_news WHERE news_id=$1 AND user_id=$2", [req.params.id, req.user.id])
    if (exists.rows.length) await pool.query("DELETE FROM saved_news WHERE news_id=$1 AND user_id=$2", [req.params.id, req.user.id])
    else await pool.query("INSERT INTO saved_news(news_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [req.params.id, req.user.id])
    res.json({ saved: !exists.rows.length })
  } catch (err) {
    console.error("save news error:", err.message)
    res.status(500).json({ error: "Не вдалося зберегти новину" })
  }
})
app.get("/api/news/:id/comments", async (req, res) => {
  const result = await pool.query("SELECT c.id,c.content,c.created_at,u.full_name AS author_name FROM news_comments c JOIN users u ON u.id=c.user_id WHERE c.news_id=$1 ORDER BY c.created_at ASC", [req.params.id])
  res.json({ comments: result.rows })
})
app.post("/api/news/:id/comments", authRequired, async (req, res) => {
  const content = String(req.body?.content || "").trim()
  if (!content || content.length > 1000) return res.status(400).json({ error: "Коментар має містити від 1 до 1000 символів" })
  const result = await pool.query("INSERT INTO news_comments(news_id,user_id,content) SELECT $1,$2,$3 WHERE EXISTS(SELECT 1 FROM news WHERE id=$1 AND status='published') RETURNING id,content,created_at", [req.params.id, req.user.id, content])
  if (!result.rows.length) return res.status(404).json({ error: "Опубліковану новину не знайдено" })
  res.status(201).json({ comment: { ...result.rows[0], author_name: req.user.full_name } })
})

app.post("/api/news", authRequired, newsAuthorOnly, async (req, res) => {
  try {
    const item = cleanNewsPayload(req.body || {})
    if (!item.title || !item.content) return res.status(400).json({ error: "Вкажіть заголовок і текст новини" })
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      const result = await client.query(`INSERT INTO news (author_id,title,content,category,status,is_pinned) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [req.user.id, item.title, item.content, item.categories[0], item.status, item.is_pinned])
      await setNewsCategories(client, result.rows[0].id, item.categories)
      await client.query("COMMIT")
      res.status(201).json({ news: { ...result.rows[0], categories: item.categories.map((name) => ({ name })) } })
    } catch (err) { await client.query("ROLLBACK"); throw err } finally { client.release() }
  } catch (err) { console.error("news create error:", err.message); res.status(500).json({ error: "Не вдалося створити новину" }) }
})
app.put("/api/news/:id", authRequired, newsAuthorOnly, async (req, res) => {
  try {
    const item = cleanNewsPayload(req.body || {})
    if (!item.title || !item.content) return res.status(400).json({ error: "Вкажіть заголовок і текст новини" })
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      const result = await client.query(`UPDATE news SET title=$1,content=$2,category=$3,status=$4,is_pinned=$5,updated_at=now() WHERE id=$6 AND (author_id=$7 OR $8 IN ('ДеканФІКТ','${DEVELOPER_ROLE}')) RETURNING *`, [item.title, item.content, item.categories[0], item.status, item.is_pinned, req.params.id, req.user.id, req.user.role])
      if (!result.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Новину не знайдено або це не ваша новина" }) }
      await client.query("DELETE FROM news_category_links WHERE news_id=$1", [result.rows[0].id])
      await setNewsCategories(client, result.rows[0].id, item.categories)
      await client.query("COMMIT")
      res.json({ news: { ...result.rows[0], categories: item.categories.map((name) => ({ name })) } })
    } catch (err) { await client.query("ROLLBACK"); throw err } finally { client.release() }
  } catch (err) { res.status(500).json({ error: "Не вдалося оновити новину" }) }
})
app.delete("/api/news/:id", authRequired, newsAuthorOnly, async (req, res) => {
  const result = await pool.query(`DELETE FROM news WHERE id=$1 AND (author_id=$2 OR $3 IN ('ДеканФІКТ','${DEVELOPER_ROLE}')) RETURNING id`, [req.params.id, req.user.id, req.user.role])
  if (!result.rows.length) return res.status(404).json({ error: "Новину не знайдено або це не ваша новина" })
  res.json({ message: "Новину видалено" })
})
app.post("/api/news/:id/attachments", authRequired, newsAuthorOnly, async (req, res) => {
  try {
    const { file_name, mime_type, file_data } = req.body || {}
    if (!file_name || !mime_type || !file_data || file_data.length > NEWS_MAX_FILE * 1.4) return res.status(400).json({ error: "Файл відсутній або перевищує 5 МБ" })
    const owns = await pool.query("SELECT id FROM news WHERE id=$1 AND (author_id=$2 OR $3=$4)", [req.params.id, req.user.id, req.user.role, DEVELOPER_ROLE])
    if (!owns.rows.length) return res.status(404).json({ error: "Новину не знайдено" })
    const result = await pool.query("INSERT INTO news_attachments (news_id,file_name,mime_type,file_data) VALUES ($1,$2,$3,$4) RETURNING id,file_name,mime_type", [req.params.id, file_name.slice(0, 200), mime_type, file_data])
    res.status(201).json({ attachment: result.rows[0] })
  } catch (err) { res.status(500).json({ error: "Не вдалося додати файл" }) }
})
app.get("/api/news/attachments/:id", authRequired, async (req, res) => {
  const result = await pool.query("SELECT * FROM news_attachments WHERE id=$1", [req.params.id])
  if (!result.rows.length) return res.status(404).end()
  const file = result.rows[0]; res.setHeader("Content-Type", file.mime_type); res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.file_name)}`); res.send(Buffer.from(file.file_data.split(",")[1] || file.file_data, "base64"))
})

const EVENT_MANAGER_ROLES = [DEVELOPER_ROLE, "ДеканФІКТ", "Завідувач Кафедри", "Викладач"]
function eventManagerOnly(req, res, next) {
  if (!EVENT_MANAGER_ROLES.includes(String(req.user.role || "").trim())) return res.status(403).json({ error: "Створювати події можуть лише викладачі та деканат" })
  next()
}
const POLL_MANAGER_ROLES = [DEVELOPER_ROLE, "ДеканФІКТ", "Завідувач Кафедри", "Викладач"]
function pollManagerOnly(req,res,next){if(!POLL_MANAGER_ROLES.includes(String(req.user.role||"").trim()))return res.status(403).json({error:"Створювати опитування можуть лише викладачі та деканат"});next()}
function cleanPollPayload(body={}){
  const title=String(body.title||"").trim(),description=String(body.description||"").trim()
  const options=Array.isArray(body.options)?body.options.map(x=>String(x||"").trim().replace(/\s+/g," ")).filter(Boolean):[]
  const pollType=body.poll_type==="multiple"?"multiple":"single"
  const maxChoices=pollType==="multiple"?Math.max(1,Math.min(options.length,Number.parseInt(body.max_choices,10)||options.length)):1
  const resultsVisibility=["always","after_vote","after_close"].includes(body.results_visibility)?body.results_visibility:"after_vote"
  const targetGroups=Array.isArray(body.target_groups)?Array.from(new Set(body.target_groups.map(x=>String(x||"").trim()).filter(x=>x&&x.length<=80))).slice(0,100):[]
  const opensAt=body.opens_at?new Date(body.opens_at):null,closesAt=body.closes_at?new Date(body.closes_at):null
  const status=["draft","published","closed"].includes(body.status)?body.status:"draft"
  const validDate=x=>!x||Number.isFinite(x.getTime())
  const valid=title.length>0&&title.length<=200&&description.length<=8000&&options.length>=2&&options.length<=20&&options.every(x=>x.length<=200)&&new Set(options.map(x=>x.toLocaleLowerCase("uk"))).size===options.length&&validDate(opensAt)&&validDate(closesAt)&&(!opensAt||!closesAt||closesAt>opensAt)&&Number.isInteger(maxChoices)&&maxChoices>=1&&maxChoices<=options.length
  return {title,description,options,pollType,maxChoices,resultsVisibility,targetGroups,opensAt,closesAt,status,anonymous:body.anonymous===true,valid}
}
function pollPublic(row,options,user){
  const manager=POLL_MANAGER_ROLES.includes(String(user.role||""))
  const voted=Boolean(row.voted),closed=row.status==="closed"||(row.closes_at&&new Date(row.closes_at)<=new Date())
  const started=!row.opens_at||new Date(row.opens_at)<=new Date()
  const eligible=user.role==="Студент"&&(!row.target_groups?.length||row.target_groups.includes(user.group_name||""))
  const resultsVisible=manager||row.results_visibility==="always"||(row.results_visibility==="after_vote"&&voted)||(row.results_visibility==="after_close"&&closed)
  return {id:row.id,title:row.title,description:row.description,poll_type:row.poll_type,max_choices:row.max_choices,anonymous:row.anonymous,results_visibility:row.results_visibility,target_groups:row.target_groups||[],status:row.status,opens_at:row.opens_at,closes_at:row.closes_at,created_at:row.created_at,updated_at:row.updated_at,author_name:row.author_name||"Колишній користувач",voted,eligible,can_manage:manager&&(row.author_id===user.id||user.role==="ДеканФІКТ"||isPlatformAdmin(user)),is_closed:Boolean(closed),is_scheduled:!started,can_vote:eligible&&!manager&&!voted&&row.status==="published"&&started&&!closed,results_visible:resultsVisible,total_votes:Number(row.total_votes||0),options:options.map(o=>({id:o.id,label:o.label,votes:resultsVisible?Number(o.votes):null,selected:Boolean(o.selected)}))}
}
app.get("/api/polls",authRequired,async(req,res)=>{
  try{
    const result=await pool.query(`SELECT p.*,u.full_name AS author_name,EXISTS(SELECT 1 FROM poll_voters v WHERE v.poll_id=p.id AND v.user_id=$1) AS voted,(SELECT COUNT(*)::int FROM poll_ballots b WHERE b.poll_id=p.id) AS total_votes
      FROM polls p LEFT JOIN users u ON u.id=p.author_id WHERE p.status<>'draft' OR p.author_id=$1 OR $2 IN ('ДеканФІКТ','${DEVELOPER_ROLE}') ORDER BY CASE WHEN p.status='published' AND (p.closes_at IS NULL OR p.closes_at>now()) THEN 0 ELSE 1 END,p.created_at DESC`,[req.user.id,req.user.role])
    const polls=[]
    for(const row of result.rows){const options=await pool.query(`SELECT o.id,o.label,(SELECT COUNT(*)::int FROM poll_selections s WHERE s.option_id=o.id) AS votes,EXISTS(SELECT 1 FROM poll_voters v JOIN poll_selections s ON s.ballot_id=v.ballot_id WHERE v.poll_id=o.poll_id AND v.user_id=$2 AND s.option_id=o.id) AS selected FROM poll_options o WHERE o.poll_id=$1 ORDER BY o.position,o.id`,[row.id,req.user.id]);polls.push(pollPublic(row,options.rows,req.user))}
    res.json({polls})
  }catch(err){console.error("poll list error:",err.message);res.status(500).json({error:"Не вдалося завантажити опитування"})}
})
app.post("/api/polls",authRequired,pollManagerOnly,async(req,res)=>{
  const p=cleanPollPayload(req.body||{});if(!p.valid)return res.status(400).json({error:"Перевірте назву, 2–20 унікальних варіантів і дати опитування"})
  const client=await pool.connect();try{await client.query("BEGIN");const q=await client.query(`INSERT INTO polls(author_id,title,description,poll_type,max_choices,anonymous,results_visibility,target_groups,status,opens_at,closes_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,[req.user.id,p.title,p.description,p.pollType,p.maxChoices,p.anonymous,p.resultsVisibility,p.targetGroups,p.status,p.opensAt,p.closesAt]);for(let i=0;i<p.options.length;i++)await client.query("INSERT INTO poll_options(poll_id,label,position) VALUES($1,$2,$3)",[q.rows[0].id,p.options[i],i]);await client.query("COMMIT");res.status(201).json({id:q.rows[0].id,message:"Опитування створено"})}catch(err){await client.query("ROLLBACK").catch(()=>{});console.error("poll create error:",err.message);res.status(500).json({error:"Не вдалося створити опитування"})}finally{client.release()}
})
app.put("/api/polls/:id",authRequired,pollManagerOnly,async(req,res)=>{
  const p=cleanPollPayload(req.body||{});if(!p.valid)return res.status(400).json({error:"Перевірте назву, 2–20 унікальних варіантів і дати опитування"})
  const client=await pool.connect();try{await client.query("BEGIN");const old=await client.query("SELECT id,author_id,(SELECT COUNT(*) FROM poll_ballots WHERE poll_id=polls.id)::int AS votes FROM polls WHERE id=$1 FOR UPDATE",[req.params.id]);if(!old.rows.length){await client.query("ROLLBACK");return res.status(404).json({error:"Опитування не знайдено"})}if(old.rows[0].author_id!==req.user.id&&req.user.role!=="ДеканФІКТ"){await client.query("ROLLBACK");return res.status(403).json({error:"Редагувати опитування може його автор або декан"})}if(old.rows[0].votes){await client.query("ROLLBACK");return res.status(409).json({error:"Після першого голосу опитування не можна редагувати. Закрийте його або створіть нове."})}await client.query(`UPDATE polls SET title=$1,description=$2,poll_type=$3,max_choices=$4,anonymous=$5,results_visibility=$6,target_groups=$7,status=$8,opens_at=$9,closes_at=$10,updated_at=now() WHERE id=$11`,[p.title,p.description,p.pollType,p.maxChoices,p.anonymous,p.resultsVisibility,p.targetGroups,p.status,p.opensAt,p.closesAt,req.params.id]);await client.query("DELETE FROM poll_options WHERE poll_id=$1",[req.params.id]);for(let i=0;i<p.options.length;i++)await client.query("INSERT INTO poll_options(poll_id,label,position) VALUES($1,$2,$3)",[req.params.id,p.options[i],i]);await client.query("COMMIT");res.json({message:"Опитування оновлено"})}catch(err){await client.query("ROLLBACK").catch(()=>{});console.error("poll update error:",err.message);res.status(500).json({error:"Не вдалося оновити опитування"})}finally{client.release()}
})
app.post("/api/polls/:id/vote",authRequired,async(req,res)=>{
  if(req.user.role!=="Студент")return res.status(403).json({error:"Голосувати можуть лише студенти"})
  const ids=Array.isArray(req.body?.option_ids)?Array.from(new Set(req.body.option_ids.map(Number))):[];if(!ids.length||ids.some(x=>!Number.isInteger(x)))return res.status(400).json({error:"Оберіть варіант відповіді"})
  const client=await pool.connect();try{await client.query("BEGIN");const q=await client.query("SELECT * FROM polls WHERE id=$1 FOR UPDATE",[req.params.id]);if(!q.rows.length){await client.query("ROLLBACK");return res.status(404).json({error:"Опитування не знайдено"})}const p=q.rows[0];const now=new Date();if(p.status!=="published"||(p.opens_at&&new Date(p.opens_at)>now)||(p.closes_at&&new Date(p.closes_at)<=now)){await client.query("ROLLBACK");return res.status(409).json({error:"Голосування зараз закрите"})}if(p.target_groups?.length){const group=await client.query("SELECT group_name FROM users WHERE id=$1",[req.user.id]);if(!p.target_groups.includes(group.rows[0]?.group_name||"")){await client.query("ROLLBACK");return res.status(403).json({error:"Це опитування доступне лише вибраним групам"})}}if((p.poll_type==="single"&&ids.length!==1)||ids.length>p.max_choices){await client.query("ROLLBACK");return res.status(400).json({error:`Для цього опитування можна обрати ${p.poll_type==="single"?"один варіант":`до ${p.max_choices} варіантів`}`})}const valid=await client.query("SELECT id FROM poll_options WHERE poll_id=$1 AND id=ANY($2::int[])",[p.id,ids]);if(valid.rows.length!==ids.length){await client.query("ROLLBACK");return res.status(400).json({error:"Один із варіантів відповіді некоректний"})}const ballot=await client.query("INSERT INTO poll_ballots(poll_id) VALUES($1) RETURNING id",[p.id]);for(const id of ids)await client.query("INSERT INTO poll_selections(ballot_id,option_id) VALUES($1,$2)",[ballot.rows[0].id,id]);await client.query("INSERT INTO poll_voters(poll_id,user_id,ballot_id) VALUES($1,$2,$3)",[p.id,req.user.id,p.anonymous?null:ballot.rows[0].id]);await client.query("COMMIT");res.status(201).json({message:"Ваш голос зараховано"})}catch(err){await client.query("ROLLBACK").catch(()=>{});if(err.code==="23505")return res.status(409).json({error:"Ви вже голосували в цьому опитуванні"});console.error("poll vote error:",err.message);res.status(500).json({error:"Не вдалося зберегти голос"})}finally{client.release()}
})
app.post("/api/polls/:id/close",authRequired,pollManagerOnly,async(req,res)=>{try{const q=await pool.query("UPDATE polls SET status='closed',updated_at=now() WHERE id=$1 AND (author_id=$2 OR $3='ДеканФІКТ') RETURNING id",[req.params.id,req.user.id,req.user.role]);if(!q.rows.length)return res.status(404).json({error:"Опитування не знайдено або немає доступу"});res.json({message:"Голосування закрито"})}catch(err){console.error("poll close error:",err.message);res.status(500).json({error:"Не вдалося закрити опитування"})}})
app.delete("/api/polls/:id",authRequired,pollManagerOnly,async(req,res)=>{try{const q=await pool.query("DELETE FROM polls WHERE id=$1 AND (author_id=$2 OR $3='ДеканФІКТ') RETURNING id",[req.params.id,req.user.id,req.user.role]);if(!q.rows.length)return res.status(404).json({error:"Опитування не знайдено або немає доступу"});res.json({message:"Опитування видалено"})}catch(err){console.error("poll delete error:",err.message);res.status(500).json({error:"Не вдалося видалити опитування"})}})
function cleanEventPayload(body = {}) {
  const title = String(body.title || "").trim()
  const summary = String(body.summary || "").trim()
  const description = String(body.description || "").trim()
  const eventType = String(body.event_type || "Подія").trim()
  const format = ["offline", "online", "hybrid"].includes(body.format) ? body.format : "offline"
  const location = String(body.location || "").trim()
  const startsAt = new Date(body.starts_at)
  const endsAt = new Date(body.ends_at)
  const deadline = body.registration_deadline ? new Date(body.registration_deadline) : startsAt
  const capacity = body.capacity === "" || body.capacity === null || body.capacity === undefined ? null : Number(body.capacity)
  const coverImage = body.cover_image === null ? null : String(body.cover_image || "").trim()
  const meetingUrl = String(body.meeting_url || "").trim()
  const contact = String(body.contact || "").trim()
  const status = ["draft", "published", "cancelled"].includes(body.status) ? body.status : "draft"
  const safeUrl = (value) => !value || /^https?:\/\//i.test(value)
  const isLocalImage = (value) => typeof value === "string" && value.length <= 7 * 1024 * 1024 && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
  const validCover = coverImage === null || (coverImage.length <= 1000 && safeUrl(coverImage)) || isLocalImage(coverImage)
  const valid = title.length > 0 && title.length <= 160 && summary.length <= 280 && description.length > 0 && description.length <= 10000 &&
    eventType.length > 0 && eventType.length <= 80 && location.length <= 200 && Number.isFinite(startsAt.getTime()) && Number.isFinite(endsAt.getTime()) &&
    endsAt > startsAt && Number.isFinite(deadline.getTime()) && deadline <= startsAt && (capacity === null || (Number.isInteger(capacity) && capacity > 0 && capacity <= 100000)) &&
    validCover && meetingUrl.length <= 1000 && contact.length <= 300 && safeUrl(meetingUrl)
  return { title, summary, description, event_type: eventType, format, location, starts_at: startsAt, ends_at: endsAt, registration_deadline: deadline, capacity, cover_image: coverImage, meeting_url: meetingUrl, contact, status, valid }
}
function publicEvent(event) {
  const isLocalCover = String(event.cover_image || "").startsWith("data:image/")
  return { ...event, cover_image: isLocalCover ? "" : (event.cover_image || ""), has_local_cover: isLocalCover }
}
app.get("/api/events", authRequired, async (req, res) => {
  try {
    const result = await pool.query(`SELECT e.id,e.created_by,e.title,e.summary,e.description,e.event_type,e.format,e.location,
      e.starts_at,e.ends_at,e.registration_deadline,e.capacity,
      CASE WHEN e.cover_image LIKE 'data:image/%' THEN '' ELSE e.cover_image END AS cover_image,
      (e.cover_image LIKE 'data:image/%') AS has_local_cover,
      e.meeting_url,e.contact,e.status,e.created_at,e.updated_at,u.full_name AS creator_name,
      COUNT(r.id) FILTER (WHERE r.status = 'registered')::int AS registered_count,
      COUNT(r.id) FILTER (WHERE r.status = 'waitlisted')::int AS waitlist_count,
      (SELECT mine.status FROM event_registrations mine WHERE mine.event_id=e.id AND mine.user_id=$1) AS my_status
      FROM events e LEFT JOIN users u ON u.id=e.created_by
      LEFT JOIN event_registrations r ON r.event_id=e.id
      WHERE e.status='published' OR e.created_by=$1 OR ($2 IN ('ДеканФІКТ','${DEVELOPER_ROLE}') AND e.status<>'published') OR EXISTS(
        SELECT 1 FROM event_registrations mine WHERE mine.event_id=e.id AND mine.user_id=$1 AND mine.status IN ('registered','waitlisted'))
      GROUP BY e.id,u.full_name
      ORDER BY CASE WHEN e.status='published' THEN 0 ELSE 1 END, e.starts_at ASC`, [req.user.id, req.user.role])
    res.json({ events: result.rows })
  } catch (err) { console.error("events list error:", err.message); res.status(500).json({ error: "Не вдалося завантажити події" }) }
})
app.post("/api/events", authRequired, eventManagerOnly, async (req, res) => {
  const event = cleanEventPayload(req.body)
  if (!event.valid) return res.status(400).json({ error: "Перевірте назву, опис, посилання, місткість і дати події. Завершення має бути після початку, а дедлайн реєстрації — не пізніше початку." })
  if (event.status === "published" && event.starts_at <= new Date()) return res.status(400).json({ error: "Нову опубліковану подію потрібно запланувати на майбутнє." })
  try {
    const result = await pool.query(`INSERT INTO events (created_by,title,summary,description,event_type,format,location,starts_at,ends_at,registration_deadline,capacity,cover_image,meeting_url,contact,status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`, [req.user.id,event.title,event.summary,event.description,event.event_type,event.format,event.location,event.starts_at,event.ends_at,event.registration_deadline,event.capacity,event.cover_image ?? "",event.meeting_url,event.contact,event.status])
    res.status(201).json({ event: { ...publicEvent(result.rows[0]), creator_name: req.user.full_name, registered_count: 0, waitlist_count: 0, my_status: null } })
  } catch (err) { console.error("event create error:", err.message); res.status(500).json({ error: "Не вдалося створити подію" }) }
})
app.put("/api/events/:id", authRequired, eventManagerOnly, async (req, res) => {
  const event = cleanEventPayload(req.body)
  if (!event.valid) return res.status(400).json({ error: "Перевірте заповнені поля та дати події." })
  if (event.status === "published" && event.starts_at <= new Date()) return res.status(400).json({ error: "Щоб відкрити реєстрацію, заплануйте подію на майбутнє." })
  let client
  try {
    client = await pool.connect()
    await client.query("BEGIN")
    const existing = await client.query("SELECT id,created_by FROM events WHERE id=$1 FOR UPDATE", [req.params.id])
    if (!existing.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Подію не знайдено" }) }
    if (existing.rows[0].created_by !== req.user.id && req.user.role !== "ДеканФІКТ" && !isPlatformAdmin(req.user)) { await client.query("ROLLBACK"); return res.status(403).json({ error: "Редагувати цю подію може її автор або адміністратор" }) }
    const count = await client.query("SELECT COUNT(*)::int AS total FROM event_registrations WHERE event_id=$1 AND status='registered'", [req.params.id])
    if (event.capacity !== null && event.capacity < count.rows[0].total) { await client.query("ROLLBACK"); return res.status(409).json({ error: `Уже зареєстровано ${count.rows[0].total} учасників. Збільште місткість або зачекайте на скасування участі.` }) }
    const result = await client.query(`UPDATE events SET title=$1,summary=$2,description=$3,event_type=$4,format=$5,location=$6,starts_at=$7,ends_at=$8,registration_deadline=$9,capacity=$10,cover_image=COALESCE($11,cover_image),meeting_url=$12,contact=$13,status=$14,updated_at=now()
      WHERE id=$15 RETURNING *`, [event.title,event.summary,event.description,event.event_type,event.format,event.location,event.starts_at,event.ends_at,event.registration_deadline,event.capacity,event.cover_image,event.meeting_url,event.contact,event.status,req.params.id])
    const openSeats = event.capacity === null ? null : Math.max(0, event.capacity - count.rows[0].total)
    if (event.status === "published" && openSeats !== 0) {
      await client.query(`UPDATE event_registrations SET status='registered',updated_at=now()
        WHERE id IN (SELECT id FROM event_registrations WHERE event_id=$1 AND status='waitlisted' ORDER BY created_at,id LIMIT $2)`, [req.params.id, openSeats])
    }
    await client.query("COMMIT")
    const row = result.rows[0]
    res.json({ event: { ...publicEvent(row), creator_name: req.user.id === row.created_by ? req.user.full_name : "", registered_count: count.rows[0].total, my_status: null } })
  } catch (err) { if (client) await client.query("ROLLBACK").catch(() => {}); console.error("event update error:", err.message); res.status(500).json({ error: "Не вдалося зберегти зміни події" }) } finally { client?.release() }
})
app.get("/api/events/:id/cover", authRequired, async (req, res) => {
  try {
    const result = await pool.query(`SELECT e.cover_image FROM events e
      WHERE e.id=$1 AND (e.status='published' OR e.created_by=$2 OR $3 IN ('ДеканФІКТ','${DEVELOPER_ROLE}') OR EXISTS(
        SELECT 1 FROM event_registrations r WHERE r.event_id=e.id AND r.user_id=$2 AND r.status IN ('registered','waitlisted')))` , [req.params.id,req.user.id,req.user.role])
    if (!result.rows.length) return res.status(404).end()
    const match = String(result.rows[0].cover_image || "").match(/^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/)
    if (!match) return res.status(404).end()
    res.setHeader("Content-Type", `image/${match[1]}`)
    res.setHeader("Cache-Control", "private, max-age=3600")
    return res.send(Buffer.from(match[2], "base64"))
  } catch (err) { console.error("event cover error:", err.message); return res.status(500).end() }
})
app.delete("/api/events/:id", authRequired, eventManagerOnly, async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM events WHERE id=$1 AND (created_by=$2 OR $3 IN ('ДеканФІКТ','${DEVELOPER_ROLE}')) RETURNING id`, [req.params.id, req.user.id, req.user.role])
    if (!result.rows.length) return res.status(404).json({ error: "Подію не знайдено або ви не маєте права її видалити" })
    res.json({ message: "Подію та її реєстрації видалено" })
  } catch (err) { console.error("event delete error:", err.message); res.status(500).json({ error: "Не вдалося видалити подію" }) }
})
app.post("/api/events/:id/cancel", authRequired, eventManagerOnly, async (req, res) => {
  try {
    const result = await pool.query(`UPDATE events SET status='cancelled',updated_at=now()
      WHERE id=$1 AND (created_by=$2 OR $3 IN ('ДеканФІКТ','${DEVELOPER_ROLE}')) AND status='published' RETURNING id`, [req.params.id,req.user.id,req.user.role])
    if (!result.rows.length) return res.status(404).json({ error: "Опубліковану подію не знайдено або ви не маєте права її скасувати" })
    res.json({ message: "Подію скасовано. Зареєстровані учасники побачать це в календарі." })
  } catch (err) { console.error("event cancellation error:", err.message); res.status(500).json({ error: "Не вдалося скасувати подію" }) }
})
app.post("/api/events/:id/register", authRequired, async (req, res) => {
  let client
  try {
    client = await pool.connect()
    await client.query("BEGIN")
    const result = await client.query("SELECT id,title,status,starts_at,registration_deadline,capacity FROM events WHERE id=$1 FOR UPDATE", [req.params.id])
    if (!result.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Подію не знайдено" }) }
    const event = result.rows[0]
    const previous = await client.query("SELECT status FROM event_registrations WHERE event_id=$1 AND user_id=$2 FOR UPDATE", [event.id, req.user.id])
    if (previous.rows.length && previous.rows[0].status !== "cancelled") {
      if (new Date(event.starts_at) <= new Date()) { await client.query("ROLLBACK"); return res.status(409).json({ error: "Реєстрацію не можна змінити після початку події" }) }
      const wasRegistered = previous.rows[0].status === "registered"
      await client.query("UPDATE event_registrations SET status='cancelled',updated_at=now() WHERE event_id=$1 AND user_id=$2", [event.id,req.user.id])
      if (wasRegistered && event.capacity !== null && event.status === "published" && new Date(event.starts_at) > new Date()) {
        const next = await client.query("SELECT id FROM event_registrations WHERE event_id=$1 AND status='waitlisted' ORDER BY created_at,id LIMIT 1 FOR UPDATE", [event.id])
        if (next.rows.length) await client.query("UPDATE event_registrations SET status='registered',updated_at=now() WHERE id=$1", [next.rows[0].id])
      }
      await client.query("COMMIT")
      return res.json({ status: "cancelled", message: "Реєстрацію скасовано" })
    }
    if (event.status !== "published") { await client.query("ROLLBACK"); return res.status(404).json({ error: "Відкриту для реєстрації подію не знайдено" }) }
    if (new Date(event.starts_at) <= new Date() || new Date(event.registration_deadline) <= new Date()) { await client.query("ROLLBACK"); return res.status(409).json({ error: "Реєстрацію на цю подію вже закрито" }) }
    const counts = await client.query("SELECT COUNT(*) FILTER (WHERE status='registered')::int AS registered FROM event_registrations WHERE event_id=$1", [event.id])
    const status = event.capacity !== null && counts.rows[0].registered >= event.capacity ? "waitlisted" : "registered"
    await client.query(`INSERT INTO event_registrations(event_id,user_id,status) VALUES($1,$2,$3)
      ON CONFLICT(event_id,user_id) DO UPDATE SET status=EXCLUDED.status,created_at=now(),updated_at=now()`, [event.id,req.user.id,status])
    await client.query("COMMIT")
    res.status(201).json({ status, message: status === "waitlisted" ? "Місць поки немає. Ви у списку очікування й автоматично отримаєте місце, якщо воно звільниться." : "Ви успішно зареєструвалися на подію" })
  } catch (err) { if (client) await client.query("ROLLBACK").catch(() => {}); console.error("event registration error:", err.message); res.status(500).json({ error: "Не вдалося оновити реєстрацію" }) } finally { client?.release() }
})
app.get("/api/events/:id/participants", authRequired, async (req, res) => {
  try {
    const event = await pool.query("SELECT created_by FROM events WHERE id=$1", [req.params.id])
    if (!event.rows.length) return res.status(404).json({ error: "Подію не знайдено" })
    if (event.rows[0].created_by !== req.user.id && req.user.role !== "ДеканФІКТ" && !isPlatformAdmin(req.user)) return res.status(403).json({ error: "Список учасників доступний організатору події та адміністратору" })
    const result = await pool.query(`SELECT u.id,u.full_name,u.email,u.role,r.status,r.created_at
      FROM event_registrations r JOIN users u ON u.id=r.user_id
      WHERE r.event_id=$1 AND r.status IN ('registered','waitlisted')
      ORDER BY CASE r.status WHEN 'registered' THEN 0 ELSE 1 END,r.created_at`, [req.params.id])
    res.json({ participants: result.rows })
  } catch (err) { console.error("event participants error:", err.message); res.status(500).json({ error: "Не вдалося завантажити учасників" }) }
})

app.get("/api/dean-dashboard", authRequired, deanOnly, async (req, res) => {
  try {
    const [overview, activity, groups, departments] = await Promise.all([
      pool.query(`SELECT
        COUNT(*) FILTER (WHERE role = 'Студент')::int AS students,
        COUNT(*) FILTER (WHERE role IN ('Викладач', 'Завідувач Кафедри', 'ДеканФІКТ'))::int AS teachers,
        (SELECT COUNT(*)::int FROM news WHERE status = 'published') AS news,
        (SELECT COUNT(*)::int FROM student_activities) AS events,
        (SELECT COUNT(*)::int FROM news_attachments) AS materials
        FROM users`),
      pool.query(`WITH actions AS (
          SELECT sender_id AS user_id, created_at FROM chat_messages
          UNION ALL SELECT author_id, created_at FROM news
          UNION ALL SELECT user_id, created_at FROM achievements
          UNION ALL SELECT user_id, created_at FROM student_activities
        )
        SELECT
          COUNT(*) FILTER (WHERE created_at >= date_trunc('day', now()))::int AS day_actions,
          COUNT(DISTINCT user_id) FILTER (WHERE created_at >= date_trunc('day', now()))::int AS day_users,
          COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS week_actions,
          COUNT(DISTINCT user_id) FILTER (WHERE created_at >= now() - interval '7 days')::int AS week_users
        FROM actions`),
      pool.query(`SELECT COALESCE(NULLIF(btrim(group_name), ''), 'Не вказано') AS name, COUNT(*)::int AS students
        FROM users WHERE role = 'Студент'
        GROUP BY 1 ORDER BY students DESC, name ASC`),
      pool.query(`SELECT COALESCE(NULLIF(btrim(department), ''), 'Не вказано') AS name,
          COUNT(*) FILTER (WHERE role = 'Студент')::int AS students,
          COUNT(*) FILTER (WHERE role IN ('Викладач', 'Завідувач Кафедри', 'ДеканФІКТ'))::int AS teachers
        FROM users
        GROUP BY 1 ORDER BY (COUNT(*) FILTER (WHERE role IN ('Викладач', 'Завідувач Кафедри', 'ДеканФІКТ'))) DESC, name ASC`),
    ])
    res.json({ overview: overview.rows[0], activity: activity.rows[0], groups: groups.rows, departments: departments.rows })
  } catch (err) {
    console.error("dean dashboard error:", err.message)
    res.status(500).json({ error: "Не вдалося завантажити статистику факультету" })
  }
})

const PROFILE_REVIEW_ROLES = ["Розробник", "Завідувач Кафедри"]
function profileFieldsMissing(user) {
  const required = user.role === "Студент"
    ? [["group_name", "Група"], ["study_level", "Рівень навчання"], ["course", "Курс"], ["phone", "Телефон"], ["about", "Про себе"]]
    : [["position", "Посада"], ["department", "Кафедра"], ["phone", "Телефон"], ["about", "Про себе"]]
  return required.filter(([key]) => !String(user[key] || "").trim()).map(([, label]) => label)
}
const profileMailer = PROFILE_MAIL_FROM && PROFILE_MAIL_PASSWORD ? nodemailer.createTransport({
  host: process.env.PROFILE_MAIL_HOST || "smtp.gmail.com",
  port: Number(process.env.PROFILE_MAIL_PORT || 465),
  secure: String(process.env.PROFILE_MAIL_SECURE || "true") === "true",
  auth: { user: PROFILE_MAIL_FROM, pass: PROFILE_MAIL_PASSWORD },
}) : null

app.get("/api/profiles-review", authRequired, async (req, res) => {
  if (!PROFILE_REVIEW_ROLES.includes(String(req.user.role || "").trim())) return res.status(403).json({ error: "Перегляд профілів доступний завідувачу кафедри та розробнику платформи" })
  try {
    const result = await pool.query(`SELECT id,full_name,email,role,department,position,group_name,study_level,course,phone,about,profile_updated_at FROM users ORDER BY full_name`)
    const profiles = result.rows.map(user => ({ ...user, missing_fields: profileFieldsMissing(user) }))
    const departmentResult = String(req.user.role || "").trim() === "Розробник"
      ? { rows: [{ department: "" }] }
      : await pool.query("SELECT COALESCE(department,'') AS department FROM users WHERE id=$1", [req.user.id])
    const department = String(departmentResult.rows[0]?.department || "").trim()
    const studentsResult = await pool.query(`SELECT u.id,u.full_name,u.group_name,u.course,
        COALESCE(activities.activity_count,0)::int AS activity_count
      FROM users u
      LEFT JOIN LATERAL (SELECT COUNT(*)::int AS activity_count FROM student_activities WHERE user_id=u.id) activities ON true
      WHERE u.role='Студент' AND ($1::boolean OR COALESCE(NULLIF(btrim(u.department),''),'')=$2)
      ORDER BY u.group_name,u.full_name`, [String(req.user.role || "").trim() === "Розробник", department])
    res.json({ profiles, students: studentsResult.rows, summary: { total: profiles.length, complete: profiles.filter(p => !p.missing_fields.length).length, incomplete: profiles.filter(p => p.missing_fields.length).length } })
  } catch (err) { console.error("profile review list error:", err.message); res.status(500).json({ error: "Не вдалося завантажити профілі" }) }
})

app.post("/api/profiles-review/:id/remind", authRequired, async (req, res) => {
  if (!PROFILE_REVIEW_ROLES.includes(String(req.user.role || "").trim())) return res.status(403).json({ error: "Надсилати нагадування може завідувач кафедри або розробник платформи" })
  if (!profileMailer) return res.status(503).json({ error: "Пошту не налаштовано. Перевірте PROFILE_MAIL_FROM та PROFILE_MAIL_APP_PASSWORD у .env" })
  try {
    const result = await pool.query("SELECT id,full_name,email,role,department,position,group_name,study_level,course,phone,about FROM users WHERE id=$1", [req.params.id])
    if (!result.rows.length) return res.status(404).json({ error: "Користувача не знайдено" })
    const user = result.rows[0], missing = profileFieldsMissing(user)
    if (!missing.length) return res.status(409).json({ error: "Профіль уже заповнений повністю" })
    const list = missing.map(label => `<li>${label.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]))}</li>`).join("")
    const safeName = String(user.full_name || "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]))
    const profilePath = user.role === "Студент" ? "/profileStudent" : "/profileTeacher"
    const publicAppUrl = String(process.env.PUBLIC_APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "")
    const profileUrl = `${publicAppUrl}${profilePath}`
    await profileMailer.sendMail({
      from: { name: "PolyConnect ZTU · Житомирська політехніка", address: PROFILE_MAIL_FROM },
      replyTo: PROFILE_MAIL_FROM,
      to: user.email,
      subject: "PolyConnect ZTU — інформація для заповнення профілю",
      text: `ЖИТОМИРСЬКА ПОЛІТЕХНІКА\nPolyConnect ZTU · Особистий кабінет\n\nШановний(а) ${user.full_name}!\n\nПід час перевірки профілів виявлено, що у вашому профілі бракує таких відомостей:\n${missing.map((field, index) => `${index + 1}. ${field}`).join("\n")}\n\nБудь ласка, доповніть профіль у PolyConnect ZTU за посиланням:\n${profileUrl}\n\nПісля входу відкриється сторінка вашого профілю. Якщо ви вже внесли ці дані, додаткових дій не потрібно.\n\nЗ повагою,\nКоманда PolyConnect ZTU\nЖитомирська політехніка\n\nЦе автоматичне повідомлення, надіслане у зв’язку з обслуговуванням вашого облікового запису.`,
      html: `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>Інформація для заповнення профілю</title></head><body style="margin:0;padding:0;background-color:#f1f4f9;font-family:Arial,Helvetica,sans-serif;color:#24324f;-webkit-text-size-adjust:100%"><div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">Інформація про поля профілю, які потрібно доповнити в PolyConnect ZTU.</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f1f4f9"><tr><td align="center" style="padding:32px 14px"><table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;border:1px solid #dce3ef;border-radius:16px;background-color:#ffffff;overflow:hidden"><tr><td style="padding:23px 30px;background-color:#172b63;border-bottom:4px solid #ccaa48"><div style="font-size:11px;line-height:16px;font-weight:bold;letter-spacing:1.6px;color:#dce6ff">ЖИТОМИРСЬКА ПОЛІТЕХНІКА</div><div style="padding-top:5px;font-size:20px;line-height:27px;font-weight:bold;color:#ffffff">PolyConnect ZTU</div><div style="padding-top:3px;font-size:12px;line-height:18px;color:#dce6ff">Портал інженерії програмного забезпечення</div></td></tr><tr><td style="padding:32px 30px 12px"><div style="font-size:12px;line-height:18px;font-weight:bold;letter-spacing:1px;color:#526aa8;text-transform:uppercase">Інформація щодо профілю</div><h1 style="margin:8px 0 18px;font-size:25px;line-height:32px;color:#182b5d">Потрібно доповнити профіль</h1><p style="margin:0 0 14px;font-size:15px;line-height:25px">Шановний(а) ${safeName}!</p><p style="margin:0 0 20px;font-size:15px;line-height:25px;color:#485773">Під час перевірки профілів PolyConnect ZTU виявлено, що у вашому обліковому записі бракує наведених нижче відомостей.</p><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border:1px solid #e2e8f2;border-radius:10px;background-color:#f8faff"><tr><td style="padding:17px 20px"><div style="margin-bottom:10px;font-size:13px;line-height:19px;font-weight:bold;color:#273b72">Будь ласка, перевірте та заповніть:</div><ul style="margin:0;padding-left:20px;color:#364663">${list.replace(/<li>/g, '<li style="padding:3px 0;font-size:14px;line-height:21px">')}</ul></td></tr></table><table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:25px 0 20px"><tr><td align="center" style="border-radius:8px;background-color:#24469a"><a href="${profileUrl}" style="display:inline-block;padding:13px 22px;border:1px solid #24469a;border-radius:8px;color:#ffffff;font-size:14px;line-height:20px;font-weight:bold;text-decoration:none">Перейти до мого профілю</a></td></tr></table><p style="margin:0 0 18px;font-size:13px;line-height:21px;color:#64718a">Після входу відкриється сторінка вашого профілю. Якщо ви вже заповнили ці поля, додаткових дій не потрібно.</p><div style="height:1px;background-color:#e6eaf1"></div><p style="margin:18px 0 4px;font-size:14px;line-height:22px;color:#35435e">З повагою,<br><strong>Команда PolyConnect ZTU</strong><br>Житомирська політехніка</p></td></tr><tr><td style="padding:15px 30px;background-color:#f8faff;border-top:1px solid #e6eaf1"><p style="margin:0;font-size:11px;line-height:18px;color:#7a869b">Це автоматичне службове повідомлення щодо вашого облікового запису PolyConnect ZTU.</p><p style="margin:6px 0 0;font-size:11px;line-height:18px;color:#7a869b">Якщо кнопка не відкривається, скопіюйте це посилання у браузер:<br><a href="${profileUrl}" style="color:#24469a;word-break:break-all">${profileUrl}</a></p></td></tr></table></td></tr></table></body></html>`,
    })
    res.json({ message: `Нагадування надіслано на ${user.email}` })
  } catch (err) { console.error("profile reminder error:", err.message); res.status(502).json({ error: "Не вдалося надіслати лист. Перевірте налаштування пошти та спробуйте ще раз" }) }
})

const MAIL_CENTER_ROLES = [DEVELOPER_ROLE, "ДеканФІКТ", "Завідувач Кафедри", "Викладач"]
const mailSendAttempts = new Map()
function mailCenterOnly(req, res, next) {
  if (!MAIL_CENTER_ROLES.includes(String(req.user?.role || "").trim())) return res.status(403).json({ error: "Центр пошти доступний викладачам, завідувачам кафедр і деканату" })
  next()
}
function mailEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char])
}
app.get("/api/mail/audience", authRequired, mailCenterOnly, async (_req, res) => {
  try {
    const result = await pool.query(`SELECT id,full_name,email,role,group_name FROM users
      WHERE role IN ('Студент','Викладач','ДеканФІКТ','Завідувач Кафедри')
      ORDER BY CASE role WHEN 'Студент' THEN 1 WHEN 'Викладач' THEN 2 WHEN 'Завідувач Кафедри' THEN 3 ELSE 4 END, group_name NULLS LAST, full_name`)
    res.json({ users: result.rows })
  } catch (err) { console.error("mail audience error:", err.message); res.status(500).json({ error: "Не вдалося завантажити список адресатів" }) }
})
app.post("/api/mail/send", authRequired, mailCenterOnly, async (req, res) => {
  if (!profileMailer) return res.status(503).json({ error: "Пошту не налаштовано. Перевірте PROFILE_MAIL_FROM та PROFILE_MAIL_APP_PASSWORD у середовищі сервера." })
  const lastSent = mailSendAttempts.get(req.user.id) || 0
  if (Date.now() - lastSent < 10_000) return res.status(429).json({ error: "Зачекайте кілька секунд перед наступним листом." })
  try {
    const body = req.body || {}
    const subject = String(body.subject || "").trim(), message = String(body.message || "").trim()
    const roles = Array.isArray(body.roles) ? [...new Set(body.roles.map(String))] : []
    const groups = Array.isArray(body.groups) ? [...new Set(body.groups.map((group) => String(group).trim()).filter(Boolean))] : []
    const ids = (value) => Array.isArray(value) ? [...new Set(value.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))] : []
    const recipientIds = ids(body.recipientIds), ccIds = ids(body.ccIds), bccIds = ids(body.bccIds)
    const safeRoles = ["Студент", "Викладач", "ДеканФІКТ", "Завідувач Кафедри"]
    if (!subject || subject.length > 180 || !message || message.length > 20_000) return res.status(400).json({ error: "Додайте тему (до 180 символів) і повідомлення (до 20 000 символів)." })
    if (roles.some((role) => !safeRoles.includes(role))) return res.status(400).json({ error: "Обрано невідому роль адресата." })
    if (groups.length > 100 || recipientIds.length + ccIds.length + bccIds.length > 300) return res.status(400).json({ error: "Забагато груп або адресатів у одному листі." })
    const attachments = Array.isArray(body.attachments) ? body.attachments : []
    let attachmentsSize = 0
    const mailAttachments = []
    for (const file of attachments) {
      const filename = String(file?.filename || "").replace(/[\\/\r\n\0]/g, "").trim()
      const content = String(file?.content || "")
      const contentType = String(file?.contentType || "application/octet-stream").slice(0, 120)
      if (!filename || filename.length > 180 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content) || content.length > 8 * 1024 * 1024 * 1.38) return res.status(400).json({ error: "Перевірте назву та формат вкладень." })
      attachmentsSize += Buffer.byteLength(content, "base64")
      mailAttachments.push({ filename, content: Buffer.from(content, "base64"), contentType })
    }
    if (attachmentsSize > 8 * 1024 * 1024) return res.status(400).json({ error: "Загальний розмір вкладень має бути до 8 МБ." })

    const audience = await pool.query(`SELECT id,full_name,email,role,group_name FROM users
      WHERE role = ANY($1::text[]) OR (role='Студент' AND group_name = ANY($2::text[])) OR (id = ANY($3::int[]) AND role IN ('Студент','Викладач','ДеканФІКТ','Завідувач Кафедри'))
      ORDER BY full_name`, [roles, groups, recipientIds])
    const recipientMap = new Map(audience.rows.filter((user) => user.id !== req.user.id).map((user) => [user.id, user]))
    const ccResult = ccIds.length ? await pool.query("SELECT id,full_name,email FROM users WHERE id=ANY($1::int[]) AND role IN ('Студент','Викладач','ДеканФІКТ','Завідувач Кафедри')", [ccIds]) : { rows: [] }
    const bccResult = bccIds.length ? await pool.query("SELECT id,full_name,email FROM users WHERE id=ANY($1::int[]) AND role IN ('Студент','Викладач','ДеканФІКТ','Завідувач Кафедри')", [bccIds]) : { rows: [] }
    const cc = ccResult.rows.filter((person) => person.id !== req.user.id && !recipientMap.has(person.id))
    const bcc = bccResult.rows.filter((person) => person.id !== req.user.id && !recipientMap.has(person.id) && !cc.some((copy) => copy.id === person.id))
    const recipients = [...recipientMap.values()]
    if (!recipients.length && !cc.length && !bcc.length) return res.status(400).json({ error: "Оберіть хоча б одного адресата, групу або роль." })
    if (recipients.length + cc.length + bcc.length > 250) return res.status(400).json({ error: "Максимум 250 адресатів у одному листі." })
    const sender = await pool.query("SELECT full_name,email,role FROM users WHERE id=$1", [req.user.id])
    const senderInfo = sender.rows[0] || { full_name: "Команда PolyConnect ZTU", role: "" }
    const priority = Boolean(body.urgent)
    const safeSubject = `${priority ? "[ТЕРМІНОВО] " : ""}${subject}`
    const signature = `\n\n—\n${senderInfo.full_name} · ${senderInfo.role}\nPolyConnect ZTU · Житомирська політехніка`
    const htmlMessage = mailEscape(message).replace(/\n/g, "<br>")
    const html = `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="color-scheme" content="light"></head><body style="margin:0;padding:28px 12px;background:#f3f5f9;font-family:Arial,Helvetica,sans-serif;color:#26334e"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center"><table role="presentation" width="620" cellspacing="0" cellpadding="0" style="max-width:620px;width:100%;border:1px solid #e1e6ee;border-radius:15px;background:#fff"><tr><td style="padding:22px 28px;background:#1d3262;border-bottom:3px solid #c6a650;border-radius:15px 15px 0 0;color:#fff"><div style="font-size:10px;letter-spacing:1.5px;color:#d3def5">ЖИТОМИРСЬКА ПОЛІТЕХНІКА</div><div style="margin-top:6px;font-size:20px;font-weight:bold">PolyConnect ZTU</div><div style="margin-top:4px;font-size:12px;color:#d3def5">${priority ? "Термінове повідомлення" : "Повідомлення університетської спільноти"}</div></td></tr><tr><td style="padding:27px 28px"><h1 style="margin:0 0 18px;font-size:22px;line-height:1.3;color:#1d3262">${mailEscape(subject)}</h1><div style="font-size:15px;line-height:1.75;white-space:normal">${htmlMessage}</div><div style="margin-top:25px;padding-top:15px;border-top:1px solid #e8ebf1;font-size:13px;line-height:1.7;color:#54617a">${mailEscape(senderInfo.full_name)} · ${mailEscape(senderInfo.role)}<br>PolyConnect ZTU · Житомирська політехніка</div></td></tr></table></td></tr></table></body></html>`
    await profileMailer.sendMail({
      from: { name: "PolyConnect ZTU · Житомирська політехніка", address: PROFILE_MAIL_FROM }, replyTo: senderInfo.email || PROFILE_MAIL_FROM,
      to: { name: "PolyConnect ZTU", address: PROFILE_MAIL_FROM },
      bcc: [...recipients.map((person) => ({ name: person.full_name, address: person.email })), ...bcc.map((person) => ({ name: person.full_name, address: person.email }))],
      cc: cc.map((person) => ({ name: person.full_name, address: person.email })), subject: safeSubject, text: `${message}${signature}`, html,
      priority: priority ? "high" : "normal", headers: priority ? { "X-Priority": "1", Importance: "high" } : undefined, attachments: mailAttachments,
    })
    mailSendAttempts.set(req.user.id, Date.now())
    res.json({ message: "Лист надіслано", sent: recipients.length + cc.length + bcc.length })
  } catch (err) { console.error("mail send error:", err.message); res.status(502).json({ error: "Не вдалося надіслати лист. Перевірте поштовий сервер і повторіть спробу." }) }
})

app.get("/api/chat-users", authRequired, async (req, res) => {
  try {
    const result = await pool.query(`SELECT u.id, u.full_name, u.role, u.email, u.group_name, ${PRESENCE_SQL} AS presence_status, u.status_message
      FROM users u WHERE u.id <> $1 ORDER BY u.role, u.group_name NULLS LAST, u.full_name`, [req.user.id])
    res.json({ users: result.rows })
  } catch (err) { console.error("chat users error:", err.message); res.status(500).json({ error: "Не вдалося завантажити користувачів" }) }
})

// Розробник платформи має оглядовий доступ до приватних даних і повне керування ними.
app.get("/api/developer/students", authRequired, developerOnly, async (_req, res) => {
  try {
    const result = await pool.query(`SELECT u.id,u.full_name,u.email,u.group_name,u.study_level,u.course,u.phone,u.department,u.created_at,
      COALESCE(json_agg(json_build_object('id',a.id,'title',a.title,'category_name',c.name,'organizer',a.organizer,'location',a.location,'activity_date',a.activity_date,'description',a.description,'link',a.link,'is_public',a.is_public) ORDER BY a.activity_date DESC NULLS LAST) FILTER (WHERE a.id IS NOT NULL),'[]') AS activities
      FROM users u LEFT JOIN student_activities a ON a.user_id=u.id LEFT JOIN activity_categories c ON c.id=a.category_id
      WHERE u.role='Студент' GROUP BY u.id ORDER BY u.group_name,u.full_name`)
    res.json({students:result.rows})
  } catch(err) { console.error("developer students error:",err.message); res.status(500).json({error:"Не вдалося завантажити профілі студентів"}) }
})
app.get("/api/developer/overview", authRequired, developerOnly, async (_req,res)=>{
  try{const result=await pool.query(`SELECT (SELECT COUNT(*)::int FROM users) AS users,(SELECT COUNT(*)::int FROM users WHERE role='Студент') AS students,(SELECT COUNT(*)::int FROM news) AS news,(SELECT COUNT(*)::int FROM events) AS events,(SELECT COUNT(*)::int FROM achievements) AS achievements,(SELECT COUNT(*)::int FROM chats) AS chats,(SELECT COUNT(*)::int FROM chats WHERE chat_type='group') AS groups,(SELECT COUNT(*)::int FROM chat_messages) AS messages`);res.json({overview:result.rows[0]})}
  catch(err){console.error("developer overview error:",err.message);res.status(500).json({error:"Не вдалося завантажити огляд платформи"})}
})
app.get("/api/developer/achievements", authRequired, developerOnly, async (_req,res)=>{
  try { const result=await pool.query(`SELECT a.*,u.full_name,u.email,u.role FROM achievements a JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC`);res.json({achievements:result.rows}) }
  catch(err){console.error("developer achievements error:",err.message);res.status(500).json({error:"Не вдалося завантажити досягнення"})}
})
app.get("/api/developer/chats", authRequired, developerOnly, async (_req,res)=>{
  try { const result=await pool.query(`SELECT c.id,c.chat_type,c.title,c.description,c.created_at,c.created_by,creator.full_name AS creator_name,
      (SELECT COUNT(*)::int FROM chat_members m WHERE m.chat_id=c.id) AS member_count,
      (SELECT COUNT(*)::int FROM chat_messages m WHERE m.chat_id=c.id) AS message_count,
      (SELECT MAX(m.created_at) FROM chat_messages m WHERE m.chat_id=c.id) AS last_message_at,
      CASE WHEN c.chat_type='direct' THEN concat_ws(' · ',u1.full_name,u2.full_name) ELSE NULL END AS participants,
      COALESCE((SELECT json_agg(json_build_object('id',u.id,'full_name',u.full_name,'email',u.email,'role',u.role,'is_admin',m.is_admin) ORDER BY u.full_name)
        FROM chat_members m JOIN users u ON u.id=m.user_id WHERE m.chat_id=c.id),'[]') AS members
      FROM chats c LEFT JOIN users creator ON creator.id=c.created_by LEFT JOIN users u1 ON u1.id=c.user_one_id LEFT JOIN users u2 ON u2.id=c.user_two_id
      ORDER BY COALESCE((SELECT MAX(m.created_at) FROM chat_messages m WHERE m.chat_id=c.id),c.created_at) DESC`);res.json({chats:result.rows}) }
  catch(err){console.error("developer chats error:",err.message);res.status(500).json({error:"Не вдалося завантажити чати"})}
})
app.get("/api/developer/chats/:id", authRequired, developerOnly, async (req,res)=>{
  try { const [chat,messages]=await Promise.all([
    pool.query(`SELECT c.id,c.chat_type,c.title,c.description,c.avatar,c.created_at,c.created_by,creator.full_name AS creator_name,
      COALESCE((SELECT json_agg(json_build_object('id',u.id,'full_name',u.full_name,'email',u.email,'role',u.role,'is_admin',m.is_admin) ORDER BY u.full_name) FROM chat_members m JOIN users u ON u.id=m.user_id WHERE m.chat_id=c.id),'[]') AS members,
      CASE WHEN c.chat_type='direct' THEN json_build_array((SELECT json_build_object('id',u.id,'full_name',u.full_name,'email',u.email,'role',u.role) FROM users u WHERE u.id=c.user_one_id),(SELECT json_build_object('id',u.id,'full_name',u.full_name,'email',u.email,'role',u.role) FROM users u WHERE u.id=c.user_two_id)) ELSE '[]'::json END AS direct_participants
      FROM chats c LEFT JOIN users creator ON creator.id=c.created_by WHERE c.id=$1`,[req.params.id]),
    pool.query(`SELECT m.id,m.content,m.sender_id,u.full_name AS sender_name,u.email AS sender_email,m.file_name,m.file_type,m.attachments,m.created_at,m.edited_at FROM chat_messages m LEFT JOIN users u ON u.id=m.sender_id WHERE m.chat_id=$1 ORDER BY m.created_at DESC LIMIT 500`,[req.params.id])
  ]);if(!chat.rows.length)return res.status(404).json({error:"Чат не знайдено"});res.json({chat:chat.rows[0],messages:messages.rows}) }
  catch(err){console.error("developer chat detail error:",err.message);res.status(500).json({error:"Не вдалося завантажити деталі чату"})}
})
app.delete("/api/developer/chats/:id", authRequired, developerOnly, async(req,res)=>{try{const result=await pool.query("DELETE FROM chats WHERE id=$1 RETURNING id",[req.params.id]);if(!result.rows.length)return res.status(404).json({error:"Чат не знайдено"});res.json({message:"Чат видалено"})}catch(err){console.error("developer chat delete error:",err.message);res.status(500).json({error:"Не вдалося видалити чат"})}})
app.put("/api/developer/achievements/:id", authRequired, developerOnly, async(req,res)=>{
  const item=achievementPayload(req.body||{})
  if(!item.title||item.title.length>160||!ACHIEVEMENT_TYPES.has(item.achievementType)||item.description.length>2000||item.achievementType.length>60||item.eventName.length>180||item.organizer.length>180||item.location.length>180||item.result.length>300||item.link.length>500)return res.status(400).json({error:"Перевірте поля досягнення"})
  if(item.link&&!/^https?:\/\//i.test(item.link))return res.status(400).json({error:"Посилання має починатися з http:// або https://"})
  if(item.achievementDate){const date=new Date(`${item.achievementDate}T00:00:00.000Z`);if(!/^\d{4}-\d{2}-\d{2}$/.test(item.achievementDate)||Number.isNaN(date.getTime())||date.toISOString().slice(0,10)!==item.achievementDate)return res.status(400).json({error:"Некоректна дата досягнення"})}
  try{const result=await pool.query(`UPDATE achievements SET title=$1,description=$2,photo=$3,achievement_type=$4,event_name=$5,organizer=$6,location=$7,achievement_date=$8,result=$9,link=$10,is_public=$11 WHERE id=$12 RETURNING *, (SELECT full_name FROM users WHERE id=achievements.user_id) AS full_name, (SELECT role FROM users WHERE id=achievements.user_id) AS role`,[item.title,item.description,item.photo,item.achievementType,item.eventName,item.organizer,item.location,item.achievementDate||null,item.result,item.link,item.isPublic,req.params.id]);if(!result.rows.length)return res.status(404).json({error:"Досягнення не знайдено"});res.json({achievement:publicAchievement(result.rows[0])})}
  catch(err){console.error("developer achievement update error:",err.message);res.status(500).json({error:"Не вдалося оновити досягнення"})}
})
app.delete("/api/developer/achievements/:id", authRequired, developerOnly, async(req,res)=>{try{const result=await pool.query("DELETE FROM achievements WHERE id=$1 RETURNING id",[req.params.id]);if(!result.rows.length)return res.status(404).json({error:"Досягнення не знайдено"});res.json({message:"Досягнення видалено"})}catch(err){res.status(500).json({error:"Не вдалося видалити досягнення"})}})
app.delete("/api/developer/activities/:id", authRequired, developerOnly, async(req,res)=>{try{const result=await pool.query("DELETE FROM student_activities WHERE id=$1 RETURNING id",[req.params.id]);if(!result.rows.length)return res.status(404).json({error:"Активність не знайдена"});res.json({message:"Активність видалено"})}catch(err){res.status(500).json({error:"Не вдалося видалити активність"})}})

app.get("/api/chats", authRequired, async (req, res) => {
  try {
    const result = await pool.query(`SELECT c.id, c.created_at, c.chat_type, c.title, c.description, c.avatar,
    COALESCE(c.title, u.full_name) AS full_name, u.id AS user_id, u.role,
    COALESCE((SELECT cm.is_admin FROM chat_members cm WHERE cm.chat_id=c.id AND cm.user_id=$1),false) AS is_group_admin,
    ${PRESENCE_SQL} AS presence_status, u.status_message,
    (SELECT content FROM chat_messages m WHERE m.chat_id = c.id AND (m.scheduled_at IS NULL OR m.scheduled_at<=now()) ORDER BY COALESCE(m.scheduled_at,m.created_at) DESC LIMIT 1) AS last_message,
    (SELECT COALESCE(scheduled_at,created_at) FROM chat_messages m WHERE m.chat_id = c.id AND (m.scheduled_at IS NULL OR m.scheduled_at<=now()) ORDER BY COALESCE(m.scheduled_at,m.created_at) DESC LIMIT 1) AS last_message_at,
    (SELECT COUNT(*)::int FROM chat_messages m LEFT JOIN chat_reads r ON r.chat_id = c.id AND r.user_id = $1 WHERE m.chat_id = c.id AND (m.scheduled_at IS NULL OR m.scheduled_at<=now()) AND m.sender_id <> $1 AND (r.last_read_at IS NULL OR COALESCE(m.scheduled_at,m.created_at) > r.last_read_at)) AS unread_count
     FROM chats c LEFT JOIN users u ON c.chat_type = 'direct' AND u.id = CASE WHEN c.user_one_id = $1 THEN c.user_two_id ELSE c.user_one_id END
     WHERE ${isPlatformAdmin(req.user) ? "true" : "((c.chat_type = 'direct' AND (c.user_one_id = $1 OR c.user_two_id = $1)) OR (c.chat_type = 'group' AND EXISTS (SELECT 1 FROM chat_members cm WHERE cm.chat_id = c.id AND cm.user_id = $1)))"}
    ORDER BY COALESCE(
      (SELECT MAX(COALESCE(m.scheduled_at,m.created_at)) FROM chat_messages m WHERE m.chat_id = c.id AND (m.scheduled_at IS NULL OR m.scheduled_at<=now())),
      c.created_at
    ) DESC`, [req.user.id])
    res.json({ chats: result.rows })
  } catch (err) { console.error("chats list error:", err.message); res.status(500).json({ error: "Не вдалося завантажити чати" }) }
})

app.post("/api/chats", authRequired, async (req, res) => {
  try {
    const otherId = Number(req.body?.user_id)
    if (!Number.isInteger(otherId) || otherId === req.user.id) return res.status(400).json({ error: "Оберіть іншого користувача" })
    const first = Math.min(req.user.id, otherId), second = Math.max(req.user.id, otherId)
    const result = await pool.query(`INSERT INTO chats (user_one_id,user_two_id) VALUES ($1,$2)
      ON CONFLICT (user_one_id,user_two_id) DO UPDATE SET user_one_id=EXCLUDED.user_one_id RETURNING id`, [first, second])
    res.status(201).json({ chat_id: result.rows[0].id })
  } catch (err) { console.error("chat create error:", err.message); res.status(500).json({ error: "Не вдалося створити чат" }) }
})

app.get("/api/chats/:id/draft", authRequired, async (req, res) => {
  try {
    const isAdmin = isPlatformAdmin(req.user)
    const access = await pool.query(`SELECT id FROM chats WHERE id=$1 AND (${isAdmin ? "true" : "((chat_type='direct' AND (user_one_id=$2 OR user_two_id=$2)) OR (chat_type='group' AND EXISTS (SELECT 1 FROM chat_members WHERE chat_id=chats.id AND user_id=$2)))"})`, isAdmin ? [req.params.id] : [req.params.id, req.user.id])
    if (!access.rows.length) return res.status(404).json({ error: "Чат не знайдено" })
    const result = await pool.query("SELECT content,updated_at FROM chat_drafts WHERE chat_id=$1 AND user_id=$2", [req.params.id, req.user.id])
    res.json({ draft: result.rows[0] || { content: "" } })
  } catch (err) {
    console.error("chat draft read error:", err.message)
    res.status(500).json({ error: "Не вдалося завантажити чернетку" })
  }
})

app.put("/api/chats/:id/draft", authRequired, async (req, res) => {
  try {
    const content = String(req.body?.content || "")
    if (content.length > 2000) return res.status(400).json({ error: "Чернетка має містити до 2000 символів" })
    const isAdmin = isPlatformAdmin(req.user)
    const result = await pool.query(`INSERT INTO chat_drafts(chat_id,user_id,content)
      SELECT $1,$2,$3 WHERE EXISTS (SELECT 1 FROM chats WHERE id=$1 AND (${isAdmin ? "true" : "((chat_type='direct' AND (user_one_id=$2 OR user_two_id=$2)) OR (chat_type='group' AND EXISTS (SELECT 1 FROM chat_members WHERE chat_id=chats.id AND user_id=$2)))"}))
      ON CONFLICT(chat_id,user_id) DO UPDATE SET content=EXCLUDED.content,updated_at=now() RETURNING content,updated_at`, [req.params.id, req.user.id, content])
    if (!result.rows.length) return res.status(404).json({ error: "Чат не знайдено" })
    res.json({ draft: result.rows[0] })
  } catch (err) {
    console.error("chat draft save error:", err.message)
    res.status(500).json({ error: "Не вдалося зберегти чернетку" })
  }
})

app.delete("/api/chats/:id/draft", authRequired, async (req, res) => {
  try {
    await pool.query("DELETE FROM chat_drafts WHERE chat_id=$1 AND user_id=$2", [req.params.id, req.user.id])
    res.json({ message: "Чернетку видалено" })
  } catch (err) {
    console.error("chat draft clear error:", err.message)
    res.status(500).json({ error: "Не вдалося очистити чернетку" })
  }
})

app.post("/api/groups", authRequired, async (req, res) => {
  try {
    const title = String(req.body?.title || "").trim()
    const description = String(req.body?.description || "").trim()
    const avatar = String(req.body?.avatar || "")
    const memberIds = Array.from(new Set([req.user.id, ...(Array.isArray(req.body?.member_ids) ? req.body.member_ids : [])].map(Number).filter(Number.isInteger)))
    if (!title || title.length > 120) return res.status(400).json({ error: "Назва групи має містити від 1 до 120 символів" })
    if (description.length > 1000) return res.status(400).json({ error: "Опис групи не може бути довшим за 1000 символів" })
    if (avatar.length > 7 * 1024 * 1024) return res.status(400).json({ error: "Аватар групи завеликий" })
    const users = await pool.query("SELECT id FROM users WHERE id = ANY($1::int[])", [memberIds])
    if (users.rows.length !== memberIds.length) return res.status(400).json({ error: "Одного з учасників не знайдено" })
    const created = await pool.query(
      `INSERT INTO chats (chat_type,title,description,avatar,created_by) VALUES ('group',$1,$2,$3,$4) RETURNING id`,
      [title, description, avatar, req.user.id],
    )
    const chatId = created.rows[0].id
    await pool.query(
      `INSERT INTO chat_members (chat_id,user_id,is_admin) SELECT $1, unnest($2::int[]), false`,
      [chatId, memberIds],
    )
    await pool.query("UPDATE chat_members SET is_admin=true WHERE chat_id=$1 AND user_id=$2", [chatId, req.user.id])
    await pool.query("INSERT INTO chat_topics(chat_id,name,created_by) VALUES($1,'Загальне',$2) ON CONFLICT(chat_id,name) DO NOTHING", [chatId, req.user.id])
    res.status(201).json({ chat_id: chatId })
  } catch (err) {
    console.error("group create error:", err.message)
    res.status(500).json({ error: "Не вдалося створити групу" })
  }
})

app.get("/api/groups/:id", authRequired, async (req, res) => {
  try {
    const isAdmin = isPlatformAdmin(req.user)
    const group = await pool.query(
      `SELECT c.id,c.title,c.description,c.avatar,c.created_at,c.created_by,
        u.full_name AS creator_name,
        COALESCE(json_agg(json_build_object('id',m_user.id,'full_name',m_user.full_name,'role',m_user.role,'is_admin',cm.is_admin,'presence_status',CASE WHEN m_user.user_status='offline' OR m_user.last_seen IS NULL OR m_user.last_seen < now() - interval '2 minutes' THEN 'offline' WHEN m_user.user_status='available' AND (m_user.last_active_at IS NULL OR m_user.last_active_at < now() - interval '5 minutes') THEN 'away' ELSE m_user.user_status END,'status_message',m_user.status_message) ORDER BY m_user.full_name) FILTER (WHERE m_user.id IS NOT NULL), '[]') AS members
       FROM chats c LEFT JOIN users u ON u.id=c.created_by LEFT JOIN chat_members cm ON cm.chat_id=c.id LEFT JOIN users m_user ON m_user.id=cm.user_id
       WHERE c.id=$1 AND c.chat_type='group' AND (${isAdmin ? "true" : "EXISTS (SELECT 1 FROM chat_members own WHERE own.chat_id=c.id AND own.user_id=$2)"})
       GROUP BY c.id,u.full_name`,
      isAdmin ? [req.params.id] : [req.params.id, req.user.id],
    )
    if (!group.rows.length) return res.status(404).json({ error: "Групу не знайдено" })
    res.json({ group: group.rows[0] })
  } catch (err) {
    console.error("group details error:", err.message)
    res.status(500).json({ error: "Не вдалося завантажити інформацію про групу" })
  }
})

app.get("/api/groups/:id/topics", authRequired, async (req, res) => {
  try {
    const isAdmin = isPlatformAdmin(req.user)
    const access = await pool.query(`SELECT id FROM chats WHERE id=$1 AND chat_type='group' AND (${isAdmin ? "true" : "EXISTS (SELECT 1 FROM chat_members WHERE chat_id=chats.id AND user_id=$2)"})`, isAdmin ? [req.params.id] : [req.params.id, req.user.id])
    if (!access.rows.length) return res.status(404).json({ error: "Групу не знайдено" })
    const result = await pool.query("SELECT id,name FROM chat_topics WHERE chat_id=$1 ORDER BY CASE WHEN name='Загальне' THEN 0 ELSE 1 END,name", [req.params.id])
    const membership = isAdmin ? null : await pool.query("SELECT is_admin FROM chat_members WHERE chat_id=$1 AND user_id=$2", [req.params.id, req.user.id])
    res.json({ topics: result.rows, can_manage: isAdmin || Boolean(membership?.rows[0]?.is_admin) })
  } catch (err) {
    console.error("group topics list error:", err.message)
    res.status(500).json({ error: "Не вдалося завантажити теми групи" })
  }
})

app.post("/api/groups/:id/topics", authRequired, async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim().slice(0, 50)
    if (!name) return res.status(400).json({ error: "Вкажіть назву теми" })
    const isAdmin = isPlatformAdmin(req.user)
    const access = await pool.query(`SELECT id FROM chats WHERE id=$1 AND chat_type='group' AND (${isAdmin ? "true" : "EXISTS (SELECT 1 FROM chat_members WHERE chat_id=chats.id AND user_id=$2 AND is_admin=true)"})`, isAdmin ? [req.params.id] : [req.params.id, req.user.id])
    if (!access.rows.length) return res.status(403).json({ error: "Створювати теми може адміністратор групи" })
    const result = await pool.query("INSERT INTO chat_topics(chat_id,name,created_by) VALUES($1,$2,$3) ON CONFLICT(chat_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id,name", [req.params.id, name, req.user.id])
    res.status(201).json({ topic: result.rows[0] })
  } catch (err) {
    console.error("group topic create error:", err.message)
    res.status(500).json({ error: "Не вдалося створити тему" })
  }
})

app.get("/api/chats/:id/messages", authRequired, async (req, res) => {
  try {
    const isAdmin = isPlatformAdmin(req.user)
    const chat = await pool.query(
      `SELECT id FROM chats WHERE id=$1 AND (${isAdmin ? "true" : "((chat_type='direct' AND (user_one_id=$2 OR user_two_id=$2)) OR (chat_type='group' AND EXISTS (SELECT 1 FROM chat_members WHERE chat_id=chats.id AND user_id=$2)))"})`,
      isAdmin ? [req.params.id] : [req.params.id, req.user.id],
    )
    if (!chat.rows.length) return res.status(404).json({ error: "Чат не знайдено" })
    const requestedTopicId = req.query.topic_id ? Number.parseInt(req.query.topic_id, 10) : null
    if (requestedTopicId !== null && !Number.isInteger(requestedTopicId)) return res.status(400).json({ error: "Некоректна тема" })
    const requestedBeforeId = req.query.before_id ? Number.parseInt(req.query.before_id, 10) : null
    if (requestedBeforeId !== null && (!Number.isSafeInteger(requestedBeforeId) || requestedBeforeId < 1)) return res.status(400).json({ error: "Некоректний курсор повідомлень" })
    const limit = Math.max(1, Math.min(100, Number.parseInt(req.query.limit || "60", 10) || 60))
    const readState = await pool.query("SELECT last_read_at FROM chat_reads WHERE chat_id=$1 AND user_id=$2", [req.params.id, req.user.id])
    const lastReadAt = readState.rows[0]?.last_read_at || null
    const result = await pool.query(`SELECT m.id,m.content,m.sender_id,m.file_name,m.file_type,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('name',a.item->>'name','type',a.item->>'type','index',a.ordinality-1) ORDER BY a.ordinality)
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.attachments)='array' THEN m.attachments ELSE '[]'::jsonb END)
            WITH ORDINALITY AS a(item,ordinality)), '[]'::jsonb) AS attachments,
        m.created_at,m.edited_at,m.is_pinned,m.scheduled_at,m.topic_id,u.full_name
      FROM chat_messages m JOIN users u ON u.id=m.sender_id
      WHERE m.chat_id=$1 AND (m.scheduled_at IS NULL OR m.scheduled_at<=now()) AND ($2::int IS NULL OR m.topic_id=$2) AND ($3::bigint IS NULL OR m.id<$3)
      ORDER BY m.id DESC LIMIT $4`, [req.params.id, requestedTopicId, requestedBeforeId, limit + 1])
    const hasMore = result.rows.length > limit
    if (hasMore) result.rows.pop()
    result.rows.reverse()
    const unreadMessageIds = result.rows
      .filter((message) => message.sender_id !== req.user.id && (!lastReadAt || new Date(message.scheduled_at || message.created_at) > new Date(lastReadAt)))
      .map((message) => message.id)
    const messages = result.rows
    if (req.query.silent !== "1") await pool.query(`INSERT INTO chat_reads(chat_id,user_id,last_read_at) VALUES($1,$2,now()) ON CONFLICT(chat_id,user_id) DO UPDATE SET last_read_at=now()`, [req.params.id, req.user.id])
    res.json({ messages, unread_message_ids: unreadMessageIds, has_more: hasMore })
  } catch (err) { console.error("messages list error:", err.message); res.status(500).json({ error: "Не вдалося завантажити повідомлення" }) }
})

app.post("/api/chats/:id/messages", authRequired, async (req, res) => {
  try {
    const content = String(req.body?.content || "").trim()
    const scheduledAt = req.body?.scheduled_at ? new Date(req.body.scheduled_at) : null
    let topicId = req.body?.topic_id ? Number.parseInt(req.body.topic_id, 10) : null
    const rawAttachments = Array.isArray(req.body?.attachments) ? req.body.attachments : (req.body?.attachment ? [req.body.attachment] : [])
    const attachments = rawAttachments.filter((item) => item && typeof item.data === "string" && item.data.startsWith("data:")).map((item) => ({
      name: String(item.name || "Вкладення").slice(0, 255),
      type: String(item.type || "application/octet-stream").slice(0, 150),
      data: item.data,
    }))
    if (!content && !attachments.length) return res.status(400).json({ error: "Додайте текст або файл" })
    if (content.length > 2000) return res.status(400).json({ error: "Повідомлення має містити до 2000 символів" })
    if (scheduledAt && (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() < Date.now() + 60_000 || scheduledAt.getTime() > Date.now() + 365 * 24 * 60 * 60 * 1000)) return res.status(400).json({ error: "Оберіть час щонайменше через хвилину і не далі ніж за рік" })
    if (topicId !== null && !Number.isInteger(topicId)) return res.status(400).json({ error: "Некоректна тема" })
    const attachmentBytes = attachments.reduce((total, item) => {
      const encoded = item.data.split(",")[1] || ""
      return total + Math.max(0, Math.floor(encoded.length * 3 / 4) - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0))
    }, 0)
    if (attachmentBytes > 10 * 1024 * 1024) return res.status(413).json({ error: "Загальний розмір вкладень у повідомленні має бути до 10 МБ" })
    if (topicId !== null) {
      const topic = await pool.query("SELECT id FROM chat_topics WHERE id=$1 AND chat_id=$2", [topicId, req.params.id])
      if (!topic.rows.length) return res.status(400).json({ error: "Тема не належить цьому чату" })
    } else {
      const defaultTopic = await pool.query("SELECT t.id FROM chat_topics t JOIN chats c ON c.id=t.chat_id WHERE c.id=$1 AND c.chat_type='group' AND t.name='Загальне'", [req.params.id])
      topicId = defaultTopic.rows[0]?.id || null
    }
    const firstAttachment = attachments[0] || null
    const result = await pool.query(`INSERT INTO chat_messages(chat_id,sender_id,content,file_name,file_type,file_data,attachments,scheduled_at,topic_id)
      SELECT $1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9 WHERE EXISTS (SELECT 1 FROM chats WHERE id=$1 AND (${isPlatformAdmin(req.user) ? "true" : "((chat_type='direct' AND (user_one_id=$2 OR user_two_id=$2)) OR (chat_type='group' AND EXISTS (SELECT 1 FROM chat_members WHERE chat_id=chats.id AND user_id=$2)))"})) RETURNING id,content,sender_id,file_name,file_type,created_at,edited_at,is_pinned,scheduled_at,topic_id`, [req.params.id, req.user.id, content, firstAttachment?.name || null, firstAttachment?.type || null, firstAttachment?.data || null, JSON.stringify(attachments), scheduledAt, topicId])
    if (!result.rows.length) return res.status(404).json({ error: "Чат не знайдено" })
    res.status(201).json({ message: { ...result.rows[0], full_name: req.user.full_name, attachments: attachments.map((file, index) => ({ name: file.name, type: file.type, index })) } })
  } catch (err) { console.error("message create error:", err.message); res.status(500).json({ error: "Не вдалося надіслати повідомлення" }) }
})

app.put("/api/chats/:chatId/messages/:messageId/pin", authRequired, async (req, res) => {
  try {
    const chatId = req.params.chatId
    const isAdmin = isPlatformAdmin(req.user)
    const access = await pool.query(`SELECT id,chat_type FROM chats WHERE id=$1 AND (${isAdmin ? "true" : "((chat_type='direct' AND (user_one_id=$2 OR user_two_id=$2)) OR (chat_type='group' AND EXISTS (SELECT 1 FROM chat_members WHERE chat_id=chats.id AND user_id=$2)))"})`, isAdmin ? [chatId] : [chatId, req.user.id])
    if (!access.rows.length) return res.status(404).json({ error: "Чат не знайдено" })
    if (access.rows[0].chat_type === "group" && !isAdmin) {
      const membership = await pool.query("SELECT is_admin FROM chat_members WHERE chat_id=$1 AND user_id=$2", [chatId, req.user.id])
      if (!membership.rows[0]?.is_admin) return res.status(403).json({ error: "Закріплювати повідомлення може адміністратор групи" })
    }
    const result = await pool.query("UPDATE chat_messages SET is_pinned=$1 WHERE id=$2 AND chat_id=$3 RETURNING id,is_pinned", [req.body?.is_pinned === true, req.params.messageId, chatId])
    if (!result.rows.length) return res.status(404).json({ error: "Повідомлення не знайдено" })
    res.json({ message: result.rows[0] })
  } catch (err) {
    console.error("message pin error:", err.message)
    res.status(500).json({ error: "Не вдалося закріпити повідомлення" })
  }
})


app.get("/api/chats/:chatId/messages/:messageId/file", authRequired, async (req, res) => {
  try {
    if (activeMediaDownloads >= maxConcurrentMediaDownloads) {
      res.setHeader("Retry-After", "2")
      return res.status(503).json({ error: "Забагато одночасних завантажень. Спробуйте ще раз за кілька секунд." })
    }
    activeMediaDownloads += 1
    let mediaSlotReleased = false
    const releaseMediaSlot = () => {
      if (mediaSlotReleased) return
      mediaSlotReleased = true
      activeMediaDownloads = Math.max(0, activeMediaDownloads - 1)
    }
    res.once("finish", releaseMediaSlot)
    res.once("close", releaseMediaSlot)
    const isAdmin = isPlatformAdmin(req.user)
    const result = await pool.query(
      `SELECT m.file_name,m.file_type,m.file_data,m.attachments FROM chat_messages m JOIN chats c ON c.id=m.chat_id
       WHERE m.id=$1 AND m.chat_id=$2 AND (${isAdmin ? "true" : "((c.chat_type='direct' AND (c.user_one_id=$3 OR c.user_two_id=$3)) OR (c.chat_type='group' AND EXISTS (SELECT 1 FROM chat_members WHERE chat_id=c.id AND user_id=$3)))"})`,
      isAdmin ? [req.params.messageId, req.params.chatId] : [req.params.messageId, req.params.chatId, req.user.id],
    )
    if (!result.rows.length) return res.status(404).end()
    const index = Math.max(0, Number.parseInt(req.query.index || "0", 10) || 0)
    let storedAttachments = result.rows[0].attachments
    if (typeof storedAttachments === "string") {
      try { storedAttachments = JSON.parse(storedAttachments) } catch { storedAttachments = [] }
    }
    const files = Array.isArray(storedAttachments) && storedAttachments.length
      ? storedAttachments.map((item) => ({ name: item.name || item.file_name, type: item.type || item.file_type, data: item.data || item.file_data }))
      : [{ name: result.rows[0].file_name, type: result.rows[0].file_type, data: result.rows[0].file_data }]
    const file = files[index]
    if (!file?.data) return res.status(404).end()
    const base64 = file.data.split(",")[1] || file.data
    const content = Buffer.from(base64, "base64")
    res.setHeader("Content-Type", (file.type || "application/octet-stream").split(";")[0])
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.name || "attachment")}`)
    res.setHeader("Accept-Ranges", "bytes")
    res.setHeader("Cache-Control", "private, max-age=3600")
    const range = req.headers.range
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range)
      if (!match || (!match[1] && !match[2])) {
        res.setHeader("Content-Range", `bytes */${content.length}`)
        return res.status(416).end()
      }
      const start = match[1] ? Number(match[1]) : Math.max(0, content.length - Number(match[2]))
      const requestedEnd = match[2] && match[1] ? Number(match[2]) : content.length - 1
      const end = Math.min(requestedEnd, content.length - 1)
      if (start > end || start >= content.length) {
        res.setHeader("Content-Range", `bytes */${content.length}`)
        return res.status(416).end()
      }
      res.status(206)
      res.setHeader("Content-Range", `bytes ${start}-${end}/${content.length}`)
      res.setHeader("Content-Length", end - start + 1)
      return res.end(content.subarray(start, end + 1))
    }
    res.setHeader("Content-Length", content.length)
    res.end(content)
  } catch (err) {
    console.error("message file error:", err.message)
    res.status(500).json({ error: "Не вдалося відкрити файл" })
  }
})
app.put("/api/chats/:chatId/messages/:messageId", authRequired, async (req, res) => {
  try {
    const content = String(req.body?.content || "").trim()
    if (!content || content.length > 2000) return res.status(400).json({ error: "Повідомлення має містити від 1 до 2000 символів" })
    const result = await pool.query(
      `UPDATE chat_messages SET content=$1, edited_at=now()
       WHERE id=$2 AND chat_id=$3 AND (sender_id=$4 OR $5=$6)
       RETURNING id,content,sender_id,created_at,edited_at`,
      [content, req.params.messageId, req.params.chatId, req.user.id, req.user.role, DEVELOPER_ROLE],
    )
    if (!result.rows.length) return res.status(404).json({ error: "Повідомлення не знайдено або воно вам не належить" })
    res.json({ message: { ...result.rows[0], full_name: req.user.full_name } })
  } catch (err) {
    console.error("message update error:", err.message)
    res.status(500).json({ error: "Не вдалося змінити повідомлення" })
  }
})

app.delete("/api/chats/:chatId/messages/:messageId", authRequired, async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM chat_messages WHERE id=$1 AND chat_id=$2 AND (sender_id=$3 OR $4=$5) RETURNING id",
      [req.params.messageId, req.params.chatId, req.user.id, req.user.role, DEVELOPER_ROLE],
    )
    if (!result.rows.length) return res.status(404).json({ error: "Повідомлення не знайдено або воно вам не належить" })
    res.json({ message: "Повідомлення видалено" })
  } catch (err) {
    console.error("message delete error:", err.message)
    res.status(500).json({ error: "Не вдалося видалити повідомлення" })
  }
})


const ACHIEVEMENT_MAX_FILE = 4 * 1024 * 1024
const ACHIEVEMENT_ROLES = [DEVELOPER_ROLE, "ДеканФІКТ", "Завідувач Кафедри", "Викладач", "Студент"]

function studentOnly(req, res, next) {
  if (String(req.user.role || "").trim() !== "Студент") return res.status(403).json({ error: "Ця дія доступна лише студентам" })
  next()
}
function cleanActivityPayload(body) {
  const title = String(body?.title || "").trim()
  const organizer = String(body?.organizer || "").trim()
  const location = String(body?.location || "").trim()
  const description = String(body?.description || "").trim()
  const link = String(body?.link || "").trim()
  const categoryName = String(body?.category_name || "").trim().replace(/\s+/g, " ")
  const activityDate = String(body?.activity_date || "").trim()
  return { title, organizer, location, description, link, categoryName, activityDate, isPublic: body?.is_public !== false }
}
async function getOrCreateActivityCategory(client, name) {
  const result = await client.query("INSERT INTO activity_categories(name) VALUES($1) ON CONFLICT(name) DO UPDATE SET name=EXCLUDED.name RETURNING id,name", [name])
  return result.rows[0]
}
app.get("/api/activity-categories", authRequired, async (req, res) => {
  try {
    const result = await pool.query("SELECT id,name FROM activity_categories ORDER BY name")
    res.json({ categories: result.rows })
  } catch (err) { console.error("activity categories error:", err.message); res.status(500).json({ error: "Не вдалося завантажити категорії активностей" }) }
})
app.post("/api/activity-categories", authRequired, studentOnly, async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim().replace(/\s+/g, " ")
    if (!name || name.length > 80 || name.includes(",")) return res.status(400).json({ error: "Назва виду активності має містити від 1 до 80 символів" })
    const result = await pool.query("INSERT INTO activity_categories(name) VALUES($1) ON CONFLICT(name) DO UPDATE SET name=EXCLUDED.name RETURNING id,name", [name])
    res.status(201).json({ category: result.rows[0] })
  } catch (err) { console.error("activity category create error:", err.message); res.status(500).json({ error: "Не вдалося створити вид активності" }) }
})
app.get("/api/student-activities/mine", authRequired, studentOnly, async (req, res) => {
  try {
    const result = await pool.query(`SELECT a.*, c.name AS category_name FROM student_activities a
      JOIN activity_categories c ON c.id=a.category_id WHERE a.user_id=$1
      ORDER BY a.activity_date DESC NULLS LAST, a.created_at DESC`, [req.user.id])
    res.json({ activities: result.rows })
  } catch (err) { console.error("my activities error:", err.message); res.status(500).json({ error: "Не вдалося завантажити активності" }) }
})
app.post("/api/student-activities", authRequired, studentOnly, async (req, res) => {
  const item = cleanActivityPayload(req.body)
  if (!item.title || !item.categoryName) return res.status(400).json({ error: "Вкажіть назву та вид активності" })
  if (item.title.length > 180 || item.categoryName.length > 80 || item.organizer.length > 180 || item.location.length > 180 || item.description.length > 2000 || item.link.length > 500) return res.status(400).json({ error: "Одне з полів надто довге" })
  if (item.link && !/^https?:\/\//i.test(item.link)) return res.status(400).json({ error: "Посилання має починатися з http:// або https://" })
  if (item.activityDate && !/^\d{4}-\d{2}-\d{2}$/.test(item.activityDate)) return res.status(400).json({ error: "Некоректна дата активності" })
  try {
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      const category = await getOrCreateActivityCategory(client, item.categoryName)
      const result = await client.query(`INSERT INTO student_activities(user_id,category_id,title,organizer,location,activity_date,description,link,is_public)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [req.user.id, category.id, item.title, item.organizer, item.location, item.activityDate || null, item.description, item.link, item.isPublic])
      await client.query("COMMIT")
      res.status(201).json({ activity: { ...result.rows[0], category_name: category.name } })
    } catch (err) { await client.query("ROLLBACK"); throw err } finally { client.release() }
  } catch (err) { console.error("activity create error:", err.message); res.status(500).json({ error: "Не вдалося зберегти активність" }) }
})
app.delete("/api/student-activities/:id", authRequired, studentOnly, async (req, res) => {
  try {
    const result = await pool.query("DELETE FROM student_activities WHERE id=$1 AND user_id=$2 RETURNING id", [req.params.id, req.user.id])
    if (!result.rows.length) return res.status(404).json({ error: "Активність не знайдено" })
    res.json({ message: "Активність видалено" })
  } catch (err) { console.error("activity delete error:", err.message); res.status(500).json({ error: "Не вдалося видалити активність" }) }
})
app.get("/api/students", authRequired, async (req, res) => {
  try {
    const result = await pool.query(`SELECT u.id,u.full_name,u.group_name,u.study_level,u.course,u.photo, ${PRESENCE_SQL} AS presence_status,u.status_message,
      COALESCE(json_agg(json_build_object('id',a.id,'title',a.title,'category_name',c.name,'organizer',a.organizer,'location',a.location,'activity_date',a.activity_date,'description',a.description,'link',a.link)
        ORDER BY a.activity_date DESC NULLS LAST, a.created_at DESC) FILTER (WHERE a.id IS NOT NULL), '[]') AS activities
      FROM users u LEFT JOIN student_activities a ON a.user_id=u.id AND a.is_public=true LEFT JOIN activity_categories c ON c.id=a.category_id
      WHERE u.role='Студент' GROUP BY u.id ORDER BY u.full_name`)
    res.json({ students: result.rows })
  } catch (err) { console.error("students list error:", err.message); res.status(500).json({ error: "Не вдалося завантажити студентів" }) }
})

function achievementPayload(body) {
  const title = String(body?.title || "").trim()
  const description = String(body?.description || "").trim()
  const photo = String(body?.photo || "")
  const achievementType = String(body?.achievement_type || "Досягнення").trim()
  const eventName = String(body?.event_name || "").trim()
  const organizer = String(body?.organizer || "").trim()
  const location = String(body?.location || "").trim()
  const achievementDate = String(body?.achievement_date || "").trim()
  const result = String(body?.result || "").trim()
  const link = String(body?.link || "").trim()
  const isPublic = body?.is_public === true
  return { title, description, photo, achievementType, eventName, organizer, location, achievementDate, result, link, isPublic }
}

const ACHIEVEMENT_TYPES = new Set(["Перемога", "Призове місце", "Участь", "Нагорода / відзнака", "Сертифікат", "Проєкт", "Публікація", "Інше", "Досягнення"])

function publicAchievement(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description || "",
    photo: row.photo || "",
    achievement_type: row.achievement_type || "Досягнення",
    event_name: row.event_name || "",
    organizer: row.organizer || "",
    location: row.location || "",
    achievement_date: row.achievement_date || "",
    result: row.result || "",
    link: row.link || "",
    is_public: Boolean(row.is_public),
    created_at: row.created_at,
    user_id: row.user_id,
    full_name: row.full_name,
    role: row.role,
  }
}

function googleSheetCsvUrl(input) {
  let url
  try { url = new URL(String(input || "")) } catch { throw new Error("Вставте коректне посилання на Google Таблицю") }
  if (url.protocol !== "https:" || url.hostname !== "docs.google.com" || url.username || url.password) throw new Error("Підтримуються лише посилання docs.google.com/spreadsheets")
  const published = url.pathname.match(/^\/spreadsheets\/(?:u\/\d+\/)?d\/e\/([A-Za-z0-9_-]+)\/(?:pub(?:html)?|pub\/(?:html|csv))\/?$/)
  const regular = url.pathname.match(/^\/spreadsheets\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)(?:\/[^/]*)?\/?$/)
  const hashGid = url.hash.match(/(?:^#|&)gid=(\d+)/)?.[1]
  const gid = url.searchParams.get("gid") || hashGid || "0"
  if (!/^\d{1,12}$/.test(gid)) throw new Error("Не вдалося визначити номер аркуша (gid) у посиланні")
  if (published) return `https://docs.google.com/spreadsheets/d/e/${published[1]}/pub?output=csv&gid=${gid}`
  if (regular && /\/pub(?:html)?\/?$/.test(url.pathname)) return `https://docs.google.com/spreadsheets/d/${regular[1]}/pub?output=csv&gid=${gid}`
  if (regular) return `https://docs.google.com/spreadsheets/d/${regular[1]}/export?format=csv&gid=${gid}`
  throw new Error("Посилання має вести на Google Таблицю, а не на окрему клітинку чи папку")
}

function parseAchievementCsv(csv) {
  const text = String(csv || "").replace(/^\uFEFF/, "")
  const firstLine = text.split(/\r?\n/, 1)[0]
  const delimiter = [",", ";", "\t"].map(char => ({ char, count: firstLine.split(char).length - 1 })).sort((a, b) => b.count - a.count)[0].char
  const rows = []; let row = []; let cell = ""; let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i += 1 }
      else if (char === '"') quoted = false
      else cell += char
    } else if (char === '"') quoted = true
    else if (char === delimiter) { row.push(cell.trim()); cell = "" }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1
      row.push(cell.trim()); cell = ""
      if (row.some(value => value !== "")) rows.push(row)
      row = []
    } else cell += char
  }
  row.push(cell.trim()); if (row.some(value => value !== "")) rows.push(row)
  if (rows.length < 2) throw new Error("У таблиці немає рядків із досягненнями або заголовків стовпців")
  const normalize = value => String(value || "").toLocaleLowerCase("uk").replace(/[’'`]/g, "").replace(/[^\p{L}\p{N}]/gu, "")
  const aliases = {
    title: ["title", "achievementname", "назва", "досягнення", "назвадосягнення", "назвадостижения"],
    achievement_type: ["achievementtype", "type", "тип", "типдосягнення", "формат"],
    event_name: ["eventname", "event", "подія", "назваподії", "конкурс", "захід"],
    achievement_date: ["achievementdate", "date", "дата", "датадосягнення"],
    organizer: ["organizer", "організатор", "організаторподії"],
    location: ["location", "місце", "місцепроведення", "форматпроведення"],
    result: ["result", "результат", "роль"],
    description: ["description", "опис", "деталі", "внесок"],
    link: ["link", "url", "посилання", "підтвердження", "посиланнянапідтвердження"],
  }
  const headers = rows[0].map(normalize)
  const indexes = Object.fromEntries(Object.entries(aliases).map(([key, names]) => [key, headers.findIndex(header => names.includes(header))]))
  if (indexes.title < 0) throw new Error("Не знайшов стовпець з назвою досягнення. Додайте заголовок «Назва» або «Title» у першому рядку")
  const parseDate = value => {
    const input = String(value || "").trim()
    if (!input) return ""
    let match = input.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/)
    if (match) {
      let day = Number(match[1]); let month = Number(match[2])
      if (day <= 12 && month > 12) [day, month] = [month, day]
      return `${match[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
    }
    match = input.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
    if (match) return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`
    const date = new Date(input)
    return Number.isNaN(date.getTime()) ? input : date.toISOString().slice(0, 10)
  }
  const mapped = rows.slice(1).slice(0, 100).map((values, index) => {
    const item = Object.fromEntries(Object.entries(indexes).map(([key, column]) => [key, column < 0 ? "" : String(values[column] || "").trim()]))
    item.achievement_date = parseDate(item.achievement_date)
    item.achievement_type = ACHIEVEMENT_TYPES.has(item.achievement_type) ? item.achievement_type : "Досягнення"
    item.row_number = index + 2
    const parsedDate = item.achievement_date && new Date(`${item.achievement_date}T00:00:00.000Z`)
    const validDate = !item.achievement_date || (/^\d{4}-\d{2}-\d{2}$/.test(item.achievement_date) && !Number.isNaN(parsedDate.getTime()) && parsedDate.toISOString().slice(0, 10) === item.achievement_date)
    item.error = !item.title ? "Не вказано назву" : item.title.length > 160 ? "Назва довша за 160 символів" : item.description.length > 2000 ? "Опис довший за 2000 символів" : item.event_name.length > 180 || item.organizer.length > 180 || item.location.length > 180 ? "Поле перевищує дозволену довжину" : item.result.length > 300 ? "Результат довший за 300 символів" : item.link.length > 500 ? "Посилання довше за 500 символів" : item.link && !/^https?:\/\//i.test(item.link) ? "Посилання має починатися з http:// або https://" : !validDate ? "Перевірте формат дати" : ""
    return item
  })
  return { rows: mapped, truncated: rows.length - 1 > 100, totalRows: rows.length - 1 }
}

async function fetchGoogleSheetCsv(input) {
  const csvUrl = googleSheetCsvUrl(input)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)
  try {
    const response = await fetch(csvUrl, { signal: controller.signal, redirect: "follow", headers: { Accept: "text/csv,text/plain;q=0.9,*/*;q=0.1" } })
    if (!response.ok) throw new Error([401, 403, 404].includes(response.status) ? "Google не дозволив анонімний перегляд цієї таблиці. Увімкніть «Усі, хто має посилання — читач» або опублікуйте аркуш; приватний доступ потребує Google OAuth." : `Google Таблиці повернули помилку ${response.status}`)
    const finalUrl = new URL(response.url)
    if (finalUrl.protocol !== "https:" || !(finalUrl.hostname === "docs.google.com" || finalUrl.hostname.endsWith(".googleusercontent.com"))) throw new Error("Google перенаправив запит на непідтримуваний ресурс")
    const reader = response.body?.getReader()
    if (!reader) throw new Error("Не вдалося прочитати дані таблиці")
    const chunks = []; let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error("Таблиця завелика: ліміт імпорту — 2 МБ") }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size); let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    const csv = new TextDecoder("utf-8", { fatal: false }).decode(bytes)
    if (/^<(?:!doctype\s+html|html)/i.test(csv.trimStart())) throw new Error("Google повернув сторінку доступу замість CSV. Перевірте доступ до таблиці за посиланням.")
    return csv
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Google Таблиці не відповіли за 15 секунд")
    throw error
  } finally { clearTimeout(timeout) }
}

app.post("/api/achievements/google-sheet/preview", authRequired, studentOnly, async (req, res) => {
  try {
    const csv = await fetchGoogleSheetCsv(req.body?.url)
    res.json(parseAchievementCsv(csv))
  } catch (error) { res.status(400).json({ error: error.message || "Не вдалося прочитати таблицю" }) }
})

app.post("/api/achievements/google-sheet/import", authRequired, studentOnly, async (req, res) => {
  const rows = req.body?.rows
  if (!Array.isArray(rows) || !rows.length || rows.length > 100) return res.status(400).json({ error: "Оберіть від 1 до 100 рядків для імпорту" })
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    let imported = 0; let skipped = 0
    for (const row of rows) {
      const item = achievementPayload(row)
      if (!item.title || item.title.length > 160 || !ACHIEVEMENT_TYPES.has(item.achievementType) || item.description.length > 2000 || item.eventName.length > 180 || item.organizer.length > 180 || item.location.length > 180 || item.result.length > 300 || item.link.length > 500 || (item.link && !/^https?:\/\//i.test(item.link))) throw new Error("Один із вибраних рядків має некоректні або задовгі дані")
      if (item.achievementDate) {
        const date = new Date(`${item.achievementDate}T00:00:00.000Z`)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(item.achievementDate) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== item.achievementDate) throw new Error(`Некоректна дата у «${item.title}»`)
      }
      const existing = await client.query(`SELECT id FROM achievements WHERE user_id=$1 AND lower(title)=lower($2)
        AND lower(event_name)=lower($3) AND achievement_date IS NOT DISTINCT FROM $4::date LIMIT 1`, [req.user.id, item.title, item.eventName, item.achievementDate || null])
      if (existing.rows.length) { skipped += 1; continue }
      await client.query(`INSERT INTO achievements(user_id,title,description,photo,achievement_type,event_name,organizer,location,achievement_date,result,link,is_public)
        VALUES($1,$2,$3,'',$4,$5,$6,$7,$8,$9,$10,false)`, [req.user.id, item.title, item.description, item.achievementType, item.eventName, item.organizer, item.location, item.achievementDate || null, item.result, item.link])
      imported += 1
    }
    await client.query("COMMIT")
    res.status(201).json({ imported, skipped, message: `Імпортовано: ${imported}. Пропущено повторів: ${skipped}. Імпортовані записи збережено приватно.` })
  } catch (error) {
    await client.query("ROLLBACK")
    res.status(400).json({ error: error.message || "Не вдалося імпортувати досягнення" })
  } finally { client.release() }
})

app.get("/api/achievements", authRequired, async (req, res) => {
  try {
    const role = String(req.query.role || "").trim()
    const params = []
    let roleFilter = ""
    if (role === "Деканат") {
      roleFilter = " AND u.role IN ('ДеканФІКТ', 'Завідувач Кафедри')"
    } else if (role === "Викладачі") {
      roleFilter = " AND u.role = 'Викладач'"
    } else if (role === "Студенти") {
      roleFilter = " AND u.role = 'Студент'"
    } else if (role && ACHIEVEMENT_ROLES.includes(role)) {
      params.push(role)
      roleFilter = ` AND u.role = $${params.length}`
    }
    const result = await pool.query(
      `SELECT a.*, u.full_name, u.role
       FROM achievements a JOIN users u ON u.id = a.user_id
       WHERE a.is_public = true${roleFilter}
       ORDER BY a.created_at DESC`,
      params,
    )
    res.json({ achievements: result.rows.map(publicAchievement) })
  } catch (err) {
    console.error("achievements list error:", err.message)
    res.status(500).json({ error: "Не вдалося завантажити досягнення" })
  }
})

app.get("/api/achievements/mine", authRequired, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.*, u.full_name, u.role FROM achievements a JOIN users u ON u.id = a.user_id
       WHERE a.user_id = $1 ORDER BY a.created_at DESC`,
      [req.user.id],
    )
    res.json({ achievements: result.rows.map(publicAchievement) })
  } catch (err) {
    console.error("own achievements error:", err.message)
    res.status(500).json({ error: "Не вдалося завантажити ваші досягнення" })
  }
})

app.post("/api/achievements", authRequired, async (req, res) => {
  try {
    const item = achievementPayload(req.body || {})
    if (!item.title || item.title.length > 160) return res.status(400).json({ error: "Назва досягнення має містити від 1 до 160 символів" })
    if (!ACHIEVEMENT_TYPES.has(item.achievementType)) return res.status(400).json({ error: "Оберіть тип досягнення зі списку" })
    if (item.description.length > 2000) return res.status(400).json({ error: "Опис не може бути довшим за 2000 символів" })
    if (item.achievementType.length > 60 || item.eventName.length > 180 || item.organizer.length > 180 || item.location.length > 180 || item.result.length > 300 || item.link.length > 500) return res.status(400).json({ error: "Одне з полів досягнення надто довге" })
    if (item.link && !/^https?:\/\//i.test(item.link)) return res.status(400).json({ error: "Посилання має починатися з http:// або https://" })
    if (item.achievementDate) {
      const date = new Date(`${item.achievementDate}T00:00:00.000Z`)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(item.achievementDate) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== item.achievementDate) return res.status(400).json({ error: "Некоректна дата досягнення" })
    }
    if (item.photo.length > ACHIEVEMENT_MAX_FILE * 1.4) return res.status(400).json({ error: "Фото досягнення не може перевищувати 4 МБ" })
    const result = await pool.query(
      `INSERT INTO achievements (user_id, title, description, photo, achievement_type, event_name, organizer, location, achievement_date, result, link, is_public)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [req.user.id, item.title, item.description, item.photo, item.achievementType, item.eventName, item.organizer, item.location, item.achievementDate || null, item.result, item.link, item.isPublic],
    )
    res.status(201).json({ achievement: publicAchievement({ ...result.rows[0], full_name: req.user.full_name, role: req.user.role }) })
  } catch (err) {
    console.error("achievement create error:", err.message)
    res.status(500).json({ error: "Не вдалося зберегти досягнення" })
  }
})

app.delete("/api/achievements/:id", authRequired, async (req, res) => {
  const result = await pool.query("DELETE FROM achievements WHERE id = $1 AND user_id = $2 RETURNING id", [req.params.id, req.user.id])
  if (!result.rows.length) return res.status(404).json({ error: "Досягнення не знайдено" })
  res.json({ message: "Досягнення видалено" })
})

const IDEA_STATUSES = ["Нова", "На розгляді", "Заплановано", "У роботі", "Реалізовано", "Відхилено"]
const IDEA_CATEGORIES = ["Навчання", "Інфраструктура", "Цифрові сервіси", "Події та спільнота", "Добробут студентів", "Інше"]
const IDEA_STAFF = [DEVELOPER_ROLE, "ДеканФІКТ", "Завідувач Кафедри", "Викладач"]
function ideaIsStaff(user) { return IDEA_STAFF.includes(String(user?.role || "").trim()) }
async function findVisibleIdea(id, user) {
  const { rows } = await pool.query(`SELECT i.*, CASE WHEN i.is_anonymous AND i.author_id <> $2 THEN 'Анонімно' ELSE u.full_name END AS author_name,
    u.role AS author_role FROM ideas i JOIN users u ON u.id=i.author_id
    WHERE i.id=$1 AND (i.visibility='public' OR i.author_id=$2 OR $3::boolean)`, [id, user.id, ideaIsStaff(user)])
  return rows[0]
}
app.get("/api/ideas", authRequired, async (req, res) => {
  try {
    const params = [req.user.id, ideaIsStaff(req.user)]
    const clauses = ["(i.visibility='public' OR i.author_id=$1 OR $2::boolean)"]
    const add = (sql, value) => { params.push(value); clauses.push(sql.replace("?", `$${params.length}`)) }
    const q = String(req.query.q || "").trim().slice(0, 120)
    if (q) { params.push(q); const n=params.length; clauses.push(`(i.title ILIKE '%' || $${n} || '%' OR i.problem ILIKE '%' || $${n} || '%' OR i.solution ILIKE '%' || $${n} || '%')`) }
    if (req.query.category && IDEA_CATEGORIES.includes(req.query.category)) add("i.category = ?", req.query.category)
    if (req.query.status && IDEA_STATUSES.includes(req.query.status)) add("i.status = ?", req.query.status)
    if (req.query.audience) add("i.audience = ?", String(req.query.audience).slice(0, 50))
    if (req.query.mine === "true") clauses.push("i.author_id=$1")
    const sort = req.query.sort === "popular" ? "votes DESC, i.updated_at DESC" : "i.updated_at DESC"
    const { rows } = await pool.query(`SELECT i.id,i.author_id,i.title,i.category,i.problem,i.solution,i.benefit,i.audience,i.visibility,i.is_anonymous,i.status,i.status_note,i.created_at,i.updated_at,
      CASE WHEN i.is_anonymous AND i.author_id <> $1 THEN 'Анонімно' ELSE u.full_name END AS author_name, u.role AS author_role,
      (SELECT count(*)::int FROM idea_votes v WHERE v.idea_id=i.id) AS vote_count,
      (SELECT count(*)::int FROM idea_comments c WHERE c.idea_id=i.id) AS comment_count,
      EXISTS(SELECT 1 FROM idea_votes v WHERE v.idea_id=i.id AND v.user_id=$1) AS has_voted,
      (SELECT count(*)::int FROM idea_votes v WHERE v.idea_id=i.id) AS votes
      FROM ideas i JOIN users u ON u.id=i.author_id WHERE ${clauses.join(" AND ")} ORDER BY ${sort} LIMIT 200`, params)
    const summary = await pool.query(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE status='На розгляді')::int AS reviewing,
      count(*) FILTER (WHERE status IN ('Заплановано','У роботі'))::int AS active,
      count(*) FILTER (WHERE status='Реалізовано')::int AS completed
      FROM ideas WHERE visibility='public' OR author_id=$1 OR $2::boolean`, [req.user.id, ideaIsStaff(req.user)])
    res.json({ ideas: rows, summary: summary.rows[0], categories: IDEA_CATEGORIES, statuses: IDEA_STATUSES, staff: ideaIsStaff(req.user) })
  } catch (err) { console.error("ideas list error:", err.message); res.status(500).json({ error: "Не вдалося завантажити ідеї" }) }
})
app.post("/api/ideas", authRequired, async (req, res) => {
  const b = req.body || {}, title = String(b.title || "").trim(), category = String(b.category || "").trim()
  const problem = String(b.problem || "").trim(), solution = String(b.solution || "").trim(), benefit = String(b.benefit || "").trim()
  const audience = String(b.audience || "Усім працівникам").trim(), visibility = b.visibility === "staff" ? "staff" : "public"
  if (!title || title.length > 140 || !IDEA_CATEGORIES.includes(category) || !problem || problem.length > 2000 || !solution || solution.length > 2000 || benefit.length > 800 || !["Викладачам", "Завідувачу кафедри", "Деканату", "Усім працівникам"].includes(audience)) return res.status(400).json({ error: "Перевірте назву, категорію, опис проблеми, рішення та адресата" })
  if (visibility === "staff" && req.user.role !== "Студент") return res.status(400).json({ error: "Приватні звернення для працівників призначені студентам" })
  try {
    const { rows } = await pool.query(`INSERT INTO ideas(author_id,title,category,problem,solution,benefit,audience,visibility,is_anonymous)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [req.user.id,title,category,problem,solution,benefit,audience,visibility,Boolean(b.is_anonymous)])
    res.status(201).json({ id: rows[0].id, message: "Ідею надіслано на розгляд" })
  } catch (err) { console.error("idea create error:", err.message); res.status(500).json({ error: "Не вдалося зберегти ідею" }) }
})
app.get("/api/ideas/:id", authRequired, async (req, res) => {
  try {
    const idea = await findVisibleIdea(req.params.id, req.user)
    if (!idea) return res.status(404).json({ error: "Ідею не знайдено" })
    const [comments, history] = await Promise.all([
      pool.query(`SELECT c.id,c.content,c.created_at,CASE WHEN i.is_anonymous AND c.user_id=i.author_id AND c.user_id<>$2 THEN 'Анонімно' ELSE u.full_name END AS author_name,u.role FROM idea_comments c JOIN users u ON u.id=c.user_id JOIN ideas i ON i.id=c.idea_id WHERE c.idea_id=$1 ORDER BY c.created_at`, [idea.id,req.user.id]),
      pool.query(`SELECT h.from_status,h.to_status,h.note,h.created_at,u.full_name AS actor_name FROM idea_status_history h JOIN users u ON u.id=h.user_id WHERE h.idea_id=$1 ORDER BY h.created_at DESC`, [idea.id]),
    ])
    const vote = await pool.query("SELECT count(*)::int AS votes, EXISTS(SELECT 1 FROM idea_votes WHERE idea_id=$1 AND user_id=$2) AS has_voted FROM idea_votes WHERE idea_id=$1", [idea.id,req.user.id])
    res.json({ idea, comments: comments.rows, history: history.rows, votes: vote.rows[0], staff: ideaIsStaff(req.user), can_edit: idea.author_id === req.user.id && idea.status === "Нова" })
  } catch (err) { console.error("idea detail error:", err.message); res.status(500).json({ error: "Не вдалося відкрити ідею" }) }
})
app.put("/api/ideas/:id", authRequired, async (req, res) => {
  const b=req.body||{}, title=String(b.title||"").trim(), problem=String(b.problem||"").trim(), solution=String(b.solution||"").trim(), benefit=String(b.benefit||"").trim(), category=String(b.category||"").trim()
  if (!title || title.length>140 || !IDEA_CATEGORIES.includes(category) || !problem || problem.length>2000 || !solution || solution.length>2000 || benefit.length>800) return res.status(400).json({error:"Перевірте поля ідеї"})
  const result=await pool.query(`UPDATE ideas SET title=$1,category=$2,problem=$3,solution=$4,benefit=$5,updated_at=now() WHERE id=$6 AND author_id=$7 AND status='Нова' RETURNING id`,[title,category,problem,solution,benefit,req.params.id,req.user.id])
  if(!result.rows.length) return res.status(403).json({error:"Редагувати можна лише власну нову ідею"})
  res.json({message:"Ідею оновлено"})
})
app.delete("/api/ideas/:id", authRequired, async (req,res)=>{
  const result=await pool.query("DELETE FROM ideas WHERE id=$1 AND ((author_id=$2 AND status='Нова') OR $3::boolean) RETURNING id",[req.params.id,req.user.id,req.user.role===DEVELOPER_ROLE])
  if(!result.rows.length)return res.status(403).json({error:"Видалити можна лише власну нову ідею"})
  res.json({message:"Ідею видалено"})
})
app.post("/api/ideas/:id/vote", authRequired, async (req,res)=>{
  const idea=await findVisibleIdea(req.params.id,req.user)
  if(!idea)return res.status(404).json({error:"Ідею не знайдено"})
  if(idea.author_id===req.user.id)return res.status(400).json({error:"Не можна голосувати за власну ідею"})
  const deleted=await pool.query("DELETE FROM idea_votes WHERE idea_id=$1 AND user_id=$2 RETURNING idea_id",[idea.id,req.user.id])
  if(!deleted.rows.length)await pool.query("INSERT INTO idea_votes(idea_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[idea.id,req.user.id])
  const count=await pool.query("SELECT count(*)::int AS votes, EXISTS(SELECT 1 FROM idea_votes WHERE idea_id=$1 AND user_id=$2) AS has_voted FROM idea_votes WHERE idea_id=$1",[idea.id,req.user.id])
  res.json(count.rows[0])
})
app.post("/api/ideas/:id/comments", authRequired, async(req,res)=>{
  const idea=await findVisibleIdea(req.params.id,req.user), content=String(req.body?.content||"").trim()
  if(!idea)return res.status(404).json({error:"Ідею не знайдено"})
  if(!content||content.length>1000)return res.status(400).json({error:"Коментар має містити від 1 до 1000 символів"})
  await pool.query("INSERT INTO idea_comments(idea_id,user_id,content) VALUES($1,$2,$3)",[idea.id,req.user.id,content])
  await pool.query("UPDATE ideas SET updated_at=now() WHERE id=$1",[idea.id])
  res.status(201).json({message:"Коментар додано"})
})
app.patch("/api/ideas/:id/status", authRequired, async(req,res)=>{
  if(!ideaIsStaff(req.user))return res.status(403).json({error:"Змінювати статус можуть працівники та керівництво"})
  const status=String(req.body?.status||""), note=String(req.body?.note||"").trim()
  if(!IDEA_STATUSES.includes(status)||note.length>1000)return res.status(400).json({error:"Оберіть коректний статус; примітка — до 1000 символів"})
  const client=await pool.connect()
  try {
    await client.query("BEGIN")
    const old=await client.query("SELECT status FROM ideas WHERE id=$1 FOR UPDATE",[req.params.id])
    if(!old.rows.length){await client.query("ROLLBACK");return res.status(404).json({error:"Ідею не знайдено"})}
    await client.query("UPDATE ideas SET status=$1,status_note=$2,updated_at=now() WHERE id=$3",[status,note,req.params.id])
    await client.query("INSERT INTO idea_status_history(idea_id,user_id,from_status,to_status,note) VALUES($1,$2,$3,$4,$5)",[req.params.id,req.user.id,old.rows[0].status,status,note])
    await client.query("COMMIT")
    res.json({message:"Статус ідеї оновлено"})
  } catch(err){await client.query("ROLLBACK");console.error("idea status error:",err.message);res.status(500).json({error:"Не вдалося оновити статус"})} finally{client.release()}
})
// Кореневий маршрут → сторінка авторизації
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "auth.html"))
})

// ��оловна сторінка
app.get("/home", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "home.html"))
})
app.get("/polls", authRequired, (req,res)=>res.sendFile(path.join(__dirname,"public","polls.html")))
app.get("/ideas", authRequired, (req,res)=>res.sendFile(path.join(__dirname,"public","ideas.html")))

app.get("/dean-dashboard", authRequired, deanOnly, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dean-dashboard.html"))
})

app.get("/admin", authRequired, developerOnly, (req,res)=>res.sendFile(path.join(__dirname,"public","dean-dashboard.html")))
app.get("/mail-center", authRequired, mailCenterOnly, (req, res) => res.sendFile(path.join(__dirname, "public", "mail-center.html")))
app.get("/profiles-review", authRequired, (req,res)=>{
  if (!PROFILE_REVIEW_ROLES.includes(String(req.user.role || "").trim())) return res.redirect("/home")
  res.sendFile(path.join(__dirname,"public","profiles-review.html"))
})

app.get("/news", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "news.html"))
})

app.get("/events", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "events.html"))
})

app.get("/students", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "students.html"))
})

app.get("/chats", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "chats.html"))
})

app.get("/faculty", (req, res) => {
  res.redirect(301, "/home")
})

app.get("/achievements", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "achievements.html"))
})

// Сторінки профілю
app.get("/profileStudent", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "profileStudent.html"))
})

app.get("/profileTeacher", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "profileTeacher.html"))
})

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Сервер запущено на http://localhost:${PORT}`)
    })
  })
  .catch((err) => {
    console.error("Помилка ініціалізації БД:", err.message)
    process.exit(1)
  })
