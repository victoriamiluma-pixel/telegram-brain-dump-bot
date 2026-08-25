# Telegram Brain-Dump → Notion Tasks Bot

You and your boss both send voice memos on Telegram. The bot transcribes each
one, pulls out the distinct action items with AI, creates each as a task in
Notion (noting who it came from), and replies confirming what it created.
Typed messages work the same way.

Telegram's bot platform is free, official, and takes about two minutes to
register — no sandbox, no business verification, no per-message cost. This
version runs on Render, which needs no credit card and receives messages via
a webhook (Telegram pushes messages to it) rather than continuously polling.

Follow this guide top to bottom. First-time setup takes about 20–30 minutes.

---

## Good news: the Notion database is already created

I set up a **"Brain Dump Tasks"** database in your connected Notion workspace
with these columns: `Task name` (title), `Status` (Not started / In progress
/ Done / Archived), `Due` (date), `Notes`, and `Source`. You don't need to
create anything in Notion — just point the bot at it (Part 1 below).

---

## How it works (in plain terms)

1. Your boss sends a Telegram voice memo to your bot.
2. The bot downloads the audio and transcribes it with Groq's hosted Whisper model.
3. An AI model reads the transcript and pulls out a clean list of tasks.
4. Each task becomes a new page in the "Brain Dump Tasks" Notion database, with a note on whether it came from you or your boss.
5. The bot replies on Telegram listing the tasks it just created.

Only the Telegram accounts you authorize (you + your boss) can use the bot — anyone else messaging it gets ignored.

---

## Part 1 — Connect the bot to Notion

This is a separate credential from the Notion connector you use inside
Claude — it's a machine credential the bot server uses to talk to Notion
directly via API.

1. Go to **https://www.notion.so/my-integrations** and click **New integration**.
2. Name it "Brain Dump Bot", pick your workspace, and create it.
3. Copy the **Internal Integration Secret** (starts with `secret_` or `ntn_`) — this is your `NOTION_API_KEY`.
4. Open the **Brain Dump Tasks** database in Notion, click **⋯** in the top-right corner → **Connections** → select the "Brain Dump Bot" integration. Without this step the API calls will fail with a permission error.
5. Your `NOTION_DATABASE_ID` is already filled in for you in `.env.example`: `53a2f215cbb04a7e9a2a9a9e4ab255b3`

---

## Part 2 — Get a Groq API key

Groq hosts Whisper (for transcription) and Llama (for pulling out tasks) and
gives free access to both — no credit card needed, and its free-tier limits
(2,000 transcriptions/day, about 8 hours of audio/day) are far more than a
couple of people brain-dumping voice memos will ever use.

1. Go to **https://console.groq.com/keys** and sign in (or create a free account).
2. Click **Create API Key**, name it, and copy it — this is your `GROQ_API_KEY`. You can't view it again after closing the dialog.

---

## Part 3 — Create the Telegram bot

1. Open Telegram and search for **@BotFather** (the official bot for creating bots).
2. Send `/newbot`, give it a name (e.g. "Brain Dump Bot") and a username ending in `bot` (e.g. `braindump_tasks_bot`).
3. BotFather replies with a token like `123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` — this is your `TELEGRAM_BOT_TOKEN`.
4. Leave `TELEGRAM_ALLOWED_USER_IDS` blank for now — you'll fill it in during Part 5.

---

## Part 4 — Put the code on GitHub

Render deploys from a GitHub repository rather than a direct file upload, so
we need the code up there first. This is a one-time setup.

1. If you don't already have one, create a free account at **https://github.com**.
2. Check whether Git is installed on your computer — in your terminal, run:
   ```
   git --version
   ```
   If that errors out, install it from **https://git-scm.com/download/win** (default options are fine), then close and reopen your terminal.
3. On GitHub, click the **+** in the top-right corner → **New repository**. Name it `telegram-brain-dump-bot`, set it to **Private**, and click **Create repository** (don't add a README/gitignore — we already have our own).
4. Back in your terminal, from inside the bot folder, run these one at a time:
   ```
   git init
   git add .
   git commit -m "Initial commit"
   ```
5. GitHub's "Quick setup" page (shown right after creating the repo) has a couple of commands under **"…or push an existing repository from the command line"** — copy those two `git remote add origin ...` and `git push -u origin main` commands from your own repo page and run them. The first push will likely open a browser window asking you to log into GitHub to authorize — approve it there.

Your code (minus `.env` and `node_modules`, which `.gitignore` keeps out) is now on GitHub. Any time we change a file later, the update flow is just:
```
git add .
git commit -m "describe the change"
git push
```
and Render redeploys automatically.

---

## Part 5 — Deploy on Render

1. Go to **https://render.com** and sign up — choosing **"Sign in with GitHub"** is easiest, since it also connects your repos in the same step.
2. Click **New +** → **Web Service**.
3. Select your `telegram-brain-dump-bot` repository (you may need to click "Configure account" to grant Render access to it first).
4. Render should auto-detect it as a Node app. Leave the defaults (**Build Command**: `npm install`, **Start Command**: `npm start`), and choose the **Free** instance type.
5. Before clicking create, scroll to **Environment Variables** and add these (real values from Parts 1–3; leave `TELEGRAM_ALLOWED_USER_IDS` out for now):
   - `TELEGRAM_BOT_TOKEN`
   - `GROQ_API_KEY`
   - `NOTION_API_KEY`
   - `NOTION_DATABASE_ID` = `53a2f215cbb04a7e9a2a9a9e4ab255b3`
6. Click **Create Web Service**. Render will build and deploy — watch the **Logs** tab; once you see `Telegram webhook registered at https://...`, it's live.

Render gives your service a public URL automatically and sets it as `RENDER_EXTERNAL_URL` — the bot uses that to register itself with Telegram on startup, so there's nothing extra for you to configure there.

---

## Part 6 — Authorize both of you (one-time)

1. Open Telegram and search for the bot by the username you gave it in Part 3, then send it any message (e.g. "hi"). It will reply with your numeric Telegram user ID, e.g. `Your Telegram user ID is: 123456789`. (If the service had gone to sleep from inactivity, this first message may take up to a minute to get a reply while it wakes up — that's normal.)
2. Have your boss do the same from his own Telegram account — he'll get a reply with his own ID, e.g. `987654321`.
3. In the Render dashboard, go to your service → **Environment**, and add:
   - `TELEGRAM_ALLOWED_USER_IDS` = `123456789,987654321`
4. Save — Render automatically redeploys with the new variable.

From now on, only messages from those two Telegram accounts are processed — everyone else is silently ignored. To add or remove someone later, just update this same variable in the Render dashboard.

---

## Part 7 — Test it

1. From your boss's Telegram, send a voice memo rambling through a few things to do, e.g. *"Remind me to call the vendor about the invoice tomorrow, and I need someone to book flights for the Berlin trip next month, also let's schedule a follow-up with the design team."*
2. Within a few seconds (or up to a minute if the service was asleep) you should get a reply listing the tasks it created.
3. Check the **Brain Dump Tasks** database in Notion — one new page per task, with due dates where mentioned.

If something doesn't work, check the **Logs** tab on your service in the Render dashboard for the exact error.

---

## Notes, limits, and things to keep in mind

- **Cost**: Telegram's Bot API, Groq's free tier, and Render's free tier — no credit card required anywhere in this setup.
- **Sleep after inactivity**: Render's free tier spins the service down after about 15 minutes with no traffic. The next message wakes it back up automatically, but that first reply can take up to a minute. This is a fine tradeoff for occasional personal/small-team use; it just means it isn't instant if nobody's used it in a while.
- **No sandbox expiry**: unlike WhatsApp's free tier, this Telegram bot never needs re-authorization once Part 6 is done.
- **Security**: the bot ignores every Telegram account except the ones listed in `TELEGRAM_ALLOWED_USER_IDS`, and the webhook URL itself is only guessable if you know the bot token (which only you have).
- **Shared task list**: tasks from you and your boss land in the same "Brain Dump Tasks" database, with the `Source` field noting who sent each one and when.
- **Multiple voice memos**: each message is processed independently.
- **Long voice memos**: Whisper handles fairly long recordings well; very long ones may just take a bit longer.
- **Updating the code later**: edit the files, then `git add .`, `git commit -m "..."`, `git push` — Render redeploys automatically on every push.

---

## File overview

- `server.js` — connects to Telegram, receives messages, orchestrates the flow, replies.
- `ai.js` — calls Groq to transcribe audio and extract structured tasks from a transcript.
- `notion.js` — creates a page (task) in the Brain Dump Tasks Notion database.
- `.env.example` — template for all required configuration; copy to `.env` for local testing (Render's dashboard is where real values live in production).
