const TEXT_START = "Привет! Нажмите кнопку ниже, чтобы перейти на сайт.";
const TEXT_PUSH = "Напоминаем: перейдите на сайт и завершите действие 👇";

async function tg(env, method, payload) {
  return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function siteButton(env, userId) {
  return {
    inline_keyboard: [[
      {
        text: "Перейти на сайт",
        url: `${env.WORKER_URL}/go/${userId}`
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

async function saveUser(env, user) {
  await env.DB.prepare(`
    INSERT INTO users (user_id, username, first_name, started_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name
  `).bind(
    user.id,
    user.username || "",
    user.first_name || ""
  ).run();
}

async function handleStart(env, message) {
  const user = message.from;
  await saveUser(env, user);

  await tg(env, "sendMessage", {
    chat_id: message.chat.id,
    text: TEXT_START,
    reply_markup: siteButton(env, user.id),
  });
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
    "SELECT user_id FROM users"
  ).all();

  let sent = 0;

  for (const user of users.results) {
    try {
      await tg(env, "sendMessage", {
        chat_id: user.user_id,
        text: TEXT_PUSH,
        reply_markup: siteButton(env, user.user_id),
      });
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
  const userId = url.pathname.split("/go/")[1];

  if (userId) {
    await env.DB.prepare(`
      INSERT INTO clicks (user_id, clicked_at)
      VALUES (?, datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET clicked_at = datetime('now')
    `).bind(userId).run();
  }

  return Response.redirect(env.SITE_URL, 302);
}

export default {
  async fetch(request, env) {
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
