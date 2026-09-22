const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");
const { toFile } = require("openai");

// Groq's API is compatible with OpenAI's client libraries, so we just point
// the OpenAI SDK at Groq's endpoint instead.
const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

// Zona horaria para interpretar "hoy", "mañana", "el lunes", etc.
const TIMEZONE = process.env.BOT_TIMEZONE || "America/Argentina/Buenos_Aires";

// Idioma y vocabulario para Whisper. El vocabulario ayuda a transcribir bien
// nombres propios (clientes, marcas, personas). Se puede ampliar desde Render.
const WHISPER_LANGUAGE = process.env.WHISPER_LANGUAGE || "es";
const WHISPER_PROMPT =
  process.env.WHISPER_PROMPT ||
  "Miluma, Sodimac, Easy, Tehuelche, Carrefour, Cotto, Kaizen, Klasman, Landiner, " +
    "Full Grow, Roots, GMG, Cogoshop, Mercado Libre, bobinas, pallets, viveros.";

const PRIORITIES = ["Alta", "Media", "Baja"];

function isTransientNetworkError(err) {
  const code = err && (err.code || (err.cause && err.cause.code));
  return (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "EAI_AGAIN" ||
    (err && err.name === "APIConnectionError")
  );
}

/**
 * Transcribe an audio file on disk using Groq's hosted Whisper model.
 * @param {string} filePath
 * @returns {Promise<string>} transcript text
 */
async function transcribeAudio(filePath, attempt = 1) {
  const MAX_ATTEMPTS = 3;
  try {
    // Buffered upload (not a stream): streaming triggered intermittent ECONNRESET on some hosts.
    const buffer = fs.readFileSync(filePath);
    const file = await toFile(buffer, path.basename(filePath));
    const transcription = await groq.audio.transcriptions.create({
      file,
      model: "whisper-large-v3-turbo",
      language: WHISPER_LANGUAGE,
      prompt: WHISPER_PROMPT,
    });
    return transcription.text;
  } catch (err) {
    if (isTransientNetworkError(err) && attempt < MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      return transcribeAudio(filePath, attempt + 1);
    }
    throw err;
  }
}

// --- Fechas en la zona horaria local -------------------------------------

function localDateParts(date) {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date); // YYYY-MM-DD
  const weekday = new Intl.DateTimeFormat("es-AR", { timeZone: TIMEZONE, weekday: "long" }).format(date);
  return { ymd, weekday };
}

/** Hoy en la zona local, como YYYY-MM-DD. */
function todayLocal(now = new Date()) {
  return localDateParts(now).ymd;
}

/**
 * Calendario de los próximos 21 días ("martes 2026-09-22", ...). Se lo pasamos
 * al modelo para que no tenga que calcular qué fecha cae cada día de la semana,
 * que es donde se equivocaba (ej.: "lunes 20/09", que fue domingo).
 */
function upcomingCalendar(now = new Date(), days = 21) {
  const lines = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
    const { ymd, weekday } = localDateParts(d);
    const label = i === 0 ? " (hoy)" : i === 1 ? " (mañana)" : "";
    lines.push(`${weekday} ${ymd}${label}`);
  }
  return lines.join("\n");
}

function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function cleanText(value) {
  return value ? String(value).trim() : "";
}

/**
 * Given a raw transcript (a rambling brain dump), extract a list of
 * distinct, actionable tasks as structured JSON.
 */
async function extractTasks(transcript) {
  const now = new Date();
  const { ymd: today, weekday } = localDateParts(now);

  const systemPrompt =
    "You turn rambling voice-memo brain dumps from a busy executive into a clean list of " +
    "actionable tasks for a team's task tracker. Rules:\n" +
    "- Extract every distinct action item, decision-to-follow-up-on, or thing to delegate.\n" +
    "- Ignore filler, greetings, and pure venting with no actionable content.\n" +
    "- Merge sentences that describe the same single task; don't split one task into many.\n" +
    "- Write each title as a short, clear imperative phrase.\n" +
    "- Write the title and description in the SAME language as the transcript. Do not translate.\n" +
    "- Put extra context, names, numbers, or nuance in 'description'.\n" +
    `- Today is ${weekday} ${today} (timezone ${TIMEZONE}). To resolve relative dates ` +
    "('mañana', 'el lunes', 'la semana que viene'), look the day up in this calendar instead of " +
    "calculating it:\n" +
    upcomingCalendar(now) +
    "\n" +
    "- 'due_date': a deadline (e.g. 'antes del 30', 'para el viernes'). 'planned_date': the day the " +
    "speaker says they will DO it (e.g. 'mañana lo llamo', 'el lunes reviso'). Fill each ONLY if the " +
    "transcript says it explicitly; otherwise null. Never invent a default date.\n" +
    "- 'priority': 'Alta', 'Media' or 'Baja' ONLY if urgency or importance is explicit " +
    "('urgente', 'lo más importante', 'cuando puedas'); otherwise null.\n" +
    "- 'delegated_to': if the task is asking someone else to do something ('pedirle a Juan', " +
    "'que Mauricio mande'), the person's name; otherwise null.\n" +
    "- 'needs_review': true if you are unsure about a name, a word, a number or what the task means " +
    "(likely transcription error, ambiguous amount, conflicting data). Then explain the doubt in " +
    "'review_note' (same language as the transcript). Do not guess silently.\n" +
    "- If there are no actionable tasks at all, return an empty tasks array.\n" +
    'Respond ONLY with JSON of the shape: {"tasks": [{"title": "...", "description": "...", ' +
    '"due_date": "YYYY-MM-DD or null", "planned_date": "YYYY-MM-DD or null", ' +
    '"priority": "Alta|Media|Baja or null", "delegated_to": "name or null", ' +
    '"needs_review": false, "review_note": "text or null"}]}';

  const completion = await groq.chat.completions.create({
    model: "openai/gpt-oss-120b",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: transcript },
    ],
  });

  const raw = completion.choices[0].message.content;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse task extraction JSON: ${err.message}\nRaw: ${raw}`);
  }

  if (!Array.isArray(parsed.tasks)) {
    return [];
  }

  return parsed.tasks
    .filter((t) => t && t.title && String(t.title).trim().length > 0)
    .map((t) => {
      const needsReview = t.needs_review === true;
      return {
        title: cleanText(t.title),
        description: cleanText(t.description),
        due_date: validDate(t.due_date),
        planned_date: validDate(t.planned_date),
        priority: PRIORITIES.includes(t.priority) ? t.priority : null,
        delegated_to: cleanText(t.delegated_to) || null,
        needs_review: needsReview,
        review_note: needsReview ? cleanText(t.review_note) || null : null,
      };
    });
}

module.exports = { transcribeAudio, extractTasks, todayLocal, upcomingCalendar, TIMEZONE };
