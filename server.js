require("dotenv").config();

// Some cloud hosts (Railway included) have flaky outbound IPv6 routing while
// IPv4 works fine. Force Node to try IPv4 first to avoid connection resets
// on outbound HTTPS requests (e.g. to api.openai.com).
require("dns").setDefaultResultOrder("ipv4first");

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const express = require("express");
const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");

const { transcribeAudio, extractTasks } = require("./ai");
const { createTask } = require("./notion");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
// Comma-separated list of Telegram user IDs allowed to use the bot (e.g. you + your boss).
const ALLOWED_USER_IDS = new Set(
  (process.env.TELEGRAM_ALLOWED_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);
const PORT = process.env.PORT || 3000;

if (!TELEGRAM_BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN in environment. Exiting.");
  process.exit(1);
}

const MIME_TO_EXT = {
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
};

function extFromMime(mime) {
  if (!mime) return "ogg";
  return MIME_TO_EXT[mime.split(";")[0].trim().toLowerCase()] || "ogg";
}

function formatTaskList(tasks) {
  return tasks
    .map((t, i) => {
      const due = t.due_date ? ` (due ${t.due_date})` : "";
      return `${i + 1}. ${t.title}${due}`;
    })
    .join("\n");
}

async function processBrainDump({ transcript, sourceLabel }) {
  const tasks = await extractTasks(transcript);

  if (tasks.length === 0) {
    return (
      "I read that but didn't find any clear action items in it. " +
      "Here's the transcript in case I missed something:\n\n" +
      transcript.slice(0, 1500)
    );
  }

  for (const task of tasks) {
    await createTask(task, sourceLabel);
  }

  return `✅ Created ${tasks.length} task${tasks.length === 1 ? "" : "s"} in Notion:\n\n${formatTaskList(tasks)}`;
}

// No { polling: true } here — Render's free tier is a request-driven web
// service, not an always-on process, so instead of continuously polling
// Telegram for new messages, Telegram pushes messages to us via a webhook
// (see the /webhook route below). This also wakes a sleeping free instance.
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);

function isAuthorized(msg) {
  return ALLOWED_USER_IDS.has(String(msg.from.id));
}

function senderName(msg) {
  return msg.from.first_name || msg.from.username || `user ${msg.from.id}`;
}

bot.on("message", async (msg) => {
  try {
    // --- Setup mode: no allowed users configured yet ---
    if (ALLOWED_USER_IDS.size === 0) {
      await bot.sendMessage(
        msg.chat.id,
        `Your Telegram user ID is: ${msg.from.id}\n\n` +
          "Add this (and anyone else who should be able to use the bot, comma-separated) as " +
          "TELEGRAM_ALLOWED_USER_IDS in the bot's environment variables and restart it — " +
          "then I'll start turning voice memos into Notion tasks."
      );
      return;
    }

    // --- Ignore anyone who isn't the configured user ---
    if (!isAuthorized(msg)) {
      console.warn(`Ignored message from unauthorized user: ${msg.from.id} (${msg.from.username || "no username"})`);
      return;
    }

    // --- /start and friends ---
    if (msg.text && msg.text.startsWith("/")) {
      if (msg.text.startsWith("/start") || msg.text.startsWith("/help")) {
        await bot.sendMessage(
          msg.chat.id,
          "Send me a voice memo (or just type a brain dump) and I'll turn it into tasks in Notion."
        );
      }
      return;
    }

    // --- Voice notes and audio files ---
    const audio = msg.voice || msg.audio;
    if (audio) {
      await bot.sendChatAction(msg.chat.id, "typing");

      const fileLink = await bot.getFileLink(audio.file_id);
      const response = await axios.get(fileLink, { responseType: "arraybuffer" });
      const ext = extFromMime(audio.mime_type);
      const tmpPath = path.join(os.tmpdir(), `braindump-${crypto.randomUUID()}.${ext}`);
      fs.writeFileSync(tmpPath, Buffer.from(response.data));

      let transcript;
      try {
        transcript = await transcribeAudio(tmpPath);
      } finally {
        fs.unlink(tmpPath, () => {});
      }

      const summary = await processBrainDump({
        transcript,
        sourceLabel: `Telegram voice memo from ${senderName(msg)} — ${new Date().toISOString()}`,
      });
      await bot.sendMessage(msg.chat.id, summary);
      return;
    }

    // --- Plain text brain dump ---
    if (msg.text && msg.text.trim().length > 0) {
      await bot.sendChatAction(msg.chat.id, "typing");
      const summary = await processBrainDump({
        transcript: msg.text.trim(),
        sourceLabel: `Telegram text message from ${senderName(msg)} — ${new Date().toISOString()}`,
      });
      await bot.sendMessage(msg.chat.id, summary);
      return;
    }

    await bot.sendMessage(
      msg.chat.id,
      "Send me a voice memo (or just type a brain dump) and I'll turn it into tasks in Notion."
    );
  } catch (err) {
    console.error("Error handling Telegram message:", err);
    try {
      await bot.sendMessage(msg.chat.id, "Something went wrong while processing that — sorry! Please try again in a bit.");
    } catch (_) {
      /* ignore secondary failure */
    }
  }
});

const app = express();
app.use(express.json());
app.get("/health", (req, res) => res.status(200).send("ok"));

// The bot token doubles as a secret path segment, so only Telegram (which
// knows the token) can hit this route with real updates.
const WEBHOOK_PATH = `/webhook/${TELEGRAM_BOT_TOKEN}`;
app.post(WEBHOOK_PATH, (req, res) => {
  try {
    bot.processUpdate(req.body);
  } catch (err) {
    console.error("Error processing Telegram update:", err);
  }
  res.sendStatus(200);
});

app.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);

  // Render sets this automatically for web services. If it's missing (e.g.
  // running locally), we skip webhook registration.
  const publicUrl = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL;
  if (!publicUrl) {
    console.warn(
      "No RENDER_EXTERNAL_URL or PUBLIC_URL set — skipping Telegram webhook registration."
    );
    return;
  }

  try {
    await bot.setWebHook(`${publicUrl}${WEBHOOK_PATH}`);
    console.log(`Telegram webhook registered at ${publicUrl}${WEBHOOK_PATH}`);
  } catch (err) {
    console.error("Failed to register Telegram webhook:", err);
  }
});
