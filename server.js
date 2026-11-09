import express from "express";
import rateLimit from "express-rate-limit";

const app = express();
app.set("trust proxy", 1); // нужно на хостингах (Render и т.п.), чтобы лимит считался по реальному IP
app.use(express.json());
app.use(express.static("public"));

// Лимит для одного посетителя: 15 сообщений в минуту.
// При превышении сайт получает 429 и количество секунд до разблокировки.
app.use(
  "/api/",
  rateLimit({
    windowMs: 60_000,
    limit: 15,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      const retryAfter = Math.max(1, Math.ceil((req.rateLimit.resetTime - Date.now()) / 1000));
      res.status(429).json({ error: "rate_limit", retryAfter });
    },
  })
);

// Настройки берутся из переменных окружения (по умолчанию Gemini)
const URL =
  process.env.API_URL ||
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const API_KEY = process.env.API_KEY || process.env.GEMINI_API_KEY;
const MODELS = (process.env.MODELS || "gemini-3.8-flash").split(",");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Возвращает { reply } или { limit: секунды }, если закончился лимит у провайдера
async function ask(messages) {
  let lastLimit = 0;
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      console.log(`Запрос к ${model}, попытка ${attempt + 1}`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 40000);
      let r, data;
      try {
        r = await fetch(URL, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${API_KEY}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: "Тебя зовут Zevron AI. Ты дружелюбный AI-помощник. Отвечай на языке пользователя." },
              ...messages,
            ],
          }),
        });
        data = await r.json();
      } catch (e) {
        console.log("Ошибка запроса:", e.name, e.message, e.cause?.code || "");
        clearTimeout(timer);
        await sleep(1500);
        continue;
      }
      clearTimeout(timer);

      if (r.ok) return { reply: data.choices?.[0]?.message?.content ?? "Пустой ответ от модели." };

      console.log("API error:", model, r.status, JSON.stringify(data));

      if (r.status === 429) {
        // лимит провайдера: запоминаем, сколько ждать, и пробуем следующую модель
        lastLimit = Math.ceil(Number(r.headers.get("retry-after"))) || 60;
        break;
      }
      if (r.status !== 503) {
        const err = Array.isArray(data) ? data[0]?.error : data.error;
        return { reply: "Ошибка API: " + (err?.message || r.status) };
      }
      await sleep(1500 * (attempt + 1)); // 503: перегрузка, ждём и повторяем
    }
  }
  if (lastLimit) return { limit: lastLimit };
  return { reply: "Не удалось получить ответ (перегрузка или нет связи). Попробуй через минуту." };
}

app.post("/api/chat", async (req, res) => {
  const messages = (req.body.messages || []).slice(-20);
  try {
    const out = await ask(messages);
    if (out.limit) return res.status(429).json({ error: "rate_limit", retryAfter: out.limit });
    res.json({ reply: out.reply });
  } catch (e) {
    console.log("Сбой сервера:", e);
    res.json({ reply: "Сбой сервера. Смотри текст ошибки в консоли." });
  }
});

app.listen(process.env.PORT || 3000, () =>
  console.log("Сервер запущен: http://localhost:3000")
);