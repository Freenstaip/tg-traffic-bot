const TEXT_START = "Hi! 👋\n\nTap the button below to visit the website, create your account, and start playing! 👇\n\n✅ Fast Registration\n✅ Instant Withdrawals\n✅ Daily Bonuses\n✅ Free Bonus\n\nGood luck and big wins! 🍀";
const TEXT_PUSH = "Напоминаем: перейдите на сайт и завершите действие 👇";

let schemaReadyPromise = null;

function cleanBaseUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}

function generateToken(length = 10) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let token = "";

  for (let i = 0; i < length; i++) {
    token += chars[bytes[i] % chars.length];
  }

  return token;
}

async function ensureSchema(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      token TEXT UNIQUE,
      started_at TEXT
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS clicks (
      user_id INTEGER PRIMARY KEY,
      clicked_at TEXT
    )
  `).run();

  // Для старой базы, где таблица users уже была создана без token.
  try {
    await env.DB.prepare("ALTER TABLE users ADD COLUMN token TEXT").run();
  } catch (e) {
    // Колонка уже есть — это нормально.
  }
}

async function ensureSchemaOnce(env) {
  if (!schemaReadyPromise) {
    schemaReadyPromise = ensureSchema(env);
  }

  return schemaReadyPromise;
}

async function tg(env, method, payload) {
  return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function sendTextOrPhoto(env, chatId, text, replyMarkup) {
  if (env.START_IMAGE) {
    return tg(env, "sendPhoto", {
      chat_id: chatId,
      photo: env.START_IMAGE,
      caption: text,
      reply_markup: replyMarkup,
    });
  }

  return tg(env, "sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: replyMarkup,
  });
}

function siteButton(env, token) {
  return {
    inline_keyboard: [[
      {
        text: "START ✅",
        url: `${cleanBaseUrl(env.WORKER_URL)}/go/${token}`
      }
    ]]
  };
}

function adminKeyboard() {
  return {
    inline_keyboard: [[
      { text: "Дожим", callback_data: "push" }
    ]]
  };
}

async function getOrCreateToken(env, userId) {
  const existing = await env.DB.prepare(
    "SELECT token FROM users WHERE user_id = ?"
  ).bind(userId).first();

  if (existing?.token) {
    return existing.token;
  }

  let token = generateToken();

  for (let i = 0; i < 5; i++) {
    const duplicate = await env.DB.prepare(
      "SELECT user_id FROM users WHERE token = ?"
    ).bind(token).first();

    if (!duplicate) break;
    token = generateToken();
  }

  await env.DB.prepare(
    "UPDATE users SET token = ? WHERE user_id = ?"
  ).bind(token, userId).run();

  return token;
}

async function saveUser(env, user) {
  await env.DB.prepare(`
    INSERT INTO users (user_id, username, first_name, token, started_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name
  `).bind(
    user.id,
    user.username || "",
    user.first_name || "",
    generateToken()
  ).run();

  return getOrCreateToken(env, user.id);
}

async function handleStart(env, message) {
  const user = message.from;
  const token = await saveUser(env, user);

  await sendTextOrPhoto(
    env,
    message.chat.id,
    TEXT_START,
    siteButton(env, token)
  );
}

async function handleAdmin(env, message) {
  if (String(message.from.id) !== String(env.ADMIN_ID)) return;

  const usersCount = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM users"
  ).first();

  const clicksCount = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM clicks"
  ).first();

  const users = await env.DB.prepare(`
    SELECT user_id, username, first_name
    FROM users
    ORDER BY started_at DESC
    LIMIT 40
  `).all();

  const usersText = users.results.map(u => {
    if (u.username) return `@${u.username}`;
    return `${u.first_name || "Без имени"} (${u.user_id})`;
  }).join("\n");

  await tg(env, "sendMessage", {
    chat_id: message.chat.id,
    text:
      `Админка\n\n` +
      `Запустили бота: ${usersCount.count}\n` +
      `Перешли на сайт: ${clicksCount.count}\n\n` +
      `Пользователи:\n${usersText || "Пока нет пользователей"}`,
    reply_markup: adminKeyboard(),
  });
}

async function handlePush(env, callbackQuery) {
  if (String(callbackQuery.from.id) !== String(env.ADMIN_ID)) return;

  const users = await env.DB.prepare(
    "SELECT user_id, token FROM users"
  ).all();

  let sent = 0;

  for (const user of users.results) {
    try {
      const token = user.token || await getOrCreateToken(env, user.user_id);

      await sendTextOrPhoto(
        env,
        user.user_id,
        TEXT_PUSH,
        siteButton(env, token)
      );

      sent++;
    } catch (e) {}
  }

  await tg(env, "answerCallbackQuery", {
    callback_query_id: callbackQuery.id,
    text: "Рассылка запущена",
  });

  await tg(env, "sendMessage", {
    chat_id: callbackQuery.message.chat.id,
    text: `Дожим отправлен: ${sent} пользователям.`,
  });
}

async function handleTelegram(request, env) {
  const update = await request.json();

  if (update.message?.text === "/start") {
    await handleStart(env, update.message);
  }

  if (update.message?.text === "/admin") {
    await handleAdmin(env, update.message);
  }

  if (update.callback_query?.data === "push") {
    await handlePush(env, update.callback_query);
  }

  return new Response("OK");
}

async function handleRedirect(request, env) {
  const url = new URL(request.url);
  const token = url.pathname.split("/go/")[1];

  if (!token) {
    return Response.redirect(env.SITE_URL, 302);
  }

  const user = await env.DB.prepare(
    "SELECT user_id FROM users WHERE token = ?"
  ).bind(token).first();

  if (!user) {
    return new Response("Invalid link", { status: 404 });
  }

  await env.DB.prepare(`
    INSERT INTO clicks (user_id, clicked_at)
    VALUES (?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET clicked_at = datetime('now')
  `).bind(user.user_id).run();

  return Response.redirect(env.SITE_URL, 302);
}

export default {
  async fetch(request, env) {
    await ensureSchemaOnce(env);

    const url = new URL(request.url);

    if (url.pathname.startsWith("/go/")) {
      return handleRedirect(request, env);
    }

    if (url.pathname === "/telegram") {
      return handleTelegram(request, env);
    }

    return new Response("Bot is running");
  }
};
