const { Client } = require("@notionhq/client");

// Pinned to a pre-"multi-source-database" API version so a plain
// NOTION_DATABASE_ID (copied from the database URL) works as the page parent.
const notion = new Client({
  auth: process.env.NOTION_API_KEY,
  notionVersion: "2022-06-28",
});

const DATABASE_ID = process.env.NOTION_DATABASE_ID;

// Property names in the Notion database. Override via env vars if the
// database uses different column names.
const PROP_TITLE = process.env.NOTION_PROP_TITLE || "Task name";
const PROP_STATUS = process.env.NOTION_PROP_STATUS || "Status";
const PROP_STATUS_DEFAULT = process.env.NOTION_PROP_STATUS_DEFAULT || "Not started";
const PROP_DUE = process.env.NOTION_PROP_DUE || "Due";
const PROP_NOTES = process.env.NOTION_PROP_NOTES || "Notes";
const PROP_SOURCE = process.env.NOTION_PROP_SOURCE || "Source";

// Propiedades del sistema de seguimiento (agregadas el 22/09/2026).
const PROP_PLANNED = process.env.NOTION_PROP_PLANNED || "Fecha planificada";
const PROP_PRIORITY = process.env.NOTION_PROP_PRIORITY || "Prioridad";
const PROP_DELEGATED = process.env.NOTION_PROP_DELEGATED || "Delegado a";
const PROP_WAITING = process.env.NOTION_PROP_WAITING || "Esperando respuesta";
const PROP_REVIEW = process.env.NOTION_PROP_REVIEW || "A confirmar";
const PROP_TODAY = process.env.NOTION_PROP_TODAY || "En agenda hoy"; // fórmula, solo lectura

// Estados que cuentan como terminados (no se muestran en los resúmenes).
const DONE_STATUSES = (process.env.NOTION_DONE_STATUSES || "Done,Archived")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function richText(content) {
  return { rich_text: [{ text: { content: String(content).slice(0, 2000) } }] };
}

function notesFor(task) {
  let notes = task.description || "";
  if (task.needs_review) {
    const doubt = task.review_note || "revisar la transcripción";
    notes = `${notes} [A confirmar: ${doubt}]`.trim();
  }
  return notes;
}

function buildProperties(
  task,
  sourceLabel,
  { includeStatus = true, includeDue = true, includeTracking = true } = {}
) {
  const properties = {
    [PROP_TITLE]: {
      title: [{ text: { content: String(task.title).slice(0, 2000) } }],
    },
  };

  if (includeStatus) {
    properties[PROP_STATUS] = { status: { name: PROP_STATUS_DEFAULT } };
  }

  // Si falla la creación con los campos nuevos, se reintenta sin ellos,
  // pero la duda igual queda anotada en las notas.
  const notes = notesFor(task);
  if (notes) {
    properties[PROP_NOTES] = richText(notes);
  }

  if (includeDue && task.due_date) {
    properties[PROP_DUE] = { date: { start: task.due_date } };
  }

  if (sourceLabel) {
    properties[PROP_SOURCE] = richText(sourceLabel);
  }

  if (includeTracking) {
    if (task.planned_date) {
      properties[PROP_PLANNED] = { date: { start: task.planned_date } };
    }
    if (task.priority) {
      properties[PROP_PRIORITY] = { select: { name: task.priority } };
    }
    if (task.delegated_to) {
      properties[PROP_DELEGATED] = richText(task.delegated_to);
    }
    if (task.needs_review) {
      properties[PROP_REVIEW] = { checkbox: true };
    }
    // "Esperando respuesta" arranca en false (default de Notion): se marca
    // recién cuando el pedido efectivamente se envió.
  }

  return properties;
}

/**
 * Create one task page in the configured Notion database.
 * Falls back to smaller property sets if the schema doesn't match, so a
 * schema mismatch never silently drops the task.
 */
async function createTask(task, sourceLabel) {
  if (!DATABASE_ID) {
    throw new Error("NOTION_DATABASE_ID is not set");
  }

  const attempts = [
    { includeStatus: true, includeDue: true, includeTracking: true },
    { includeStatus: true, includeDue: true, includeTracking: false },
    { includeStatus: false, includeDue: true, includeTracking: false },
    { includeStatus: false, includeDue: false, includeTracking: false },
  ];

  let lastError;
  for (let i = 0; i < attempts.length; i++) {
    try {
      const page = await notion.pages.create({
        parent: { database_id: DATABASE_ID },
        properties: buildProperties(task, sourceLabel, attempts[i]),
      });
      if (i > 0) {
        console.warn(
          `Task created with fallback #${i} (check NOTION_PROP_* names). Error:`,
          lastError && lastError.message
        );
      }
      return page;
    } catch (err) {
      lastError = err;
    }
  }

  // Final fallback: title only, so the task is never silently lost.
  return notion.pages
    .create({
      parent: { database_id: DATABASE_ID },
      properties: {
        [PROP_TITLE]: {
          title: [{ text: { content: String(task.title).slice(0, 2000) } }],
        },
      },
    })
    .catch(() => {
      throw lastError;
    });
}

// --- Lectura para el resumen diario --------------------------------------

function notDoneFilters() {
  return DONE_STATUSES.map((name) => ({ property: PROP_STATUS, status: { does_not_equal: name } }));
}

async function queryAll(filter, sorts) {
  const results = [];
  let cursor;
  do {
    const res = await notion.databases.query({
      database_id: DATABASE_ID,
      filter,
      sorts,
      start_cursor: cursor,
      page_size: 100,
    });
    results.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return results;
}

function readPage(page) {
  const p = page.properties || {};
  const text = (prop) =>
    prop && (prop.title || prop.rich_text)
      ? (prop.title || prop.rich_text).map((t) => t.plain_text).join("")
      : "";
  return {
    title: text(p[PROP_TITLE]) || "(sin título)",
    priority: p[PROP_PRIORITY] && p[PROP_PRIORITY].select ? p[PROP_PRIORITY].select.name : null,
    planned: p[PROP_PLANNED] && p[PROP_PLANNED].date ? p[PROP_PLANNED].date.start : null,
    due: p[PROP_DUE] && p[PROP_DUE].date ? p[PROP_DUE].date.start : null,
    delegatedTo: text(p[PROP_DELEGATED]) || null,
    needsReview: Boolean(p[PROP_REVIEW] && p[PROP_REVIEW].checkbox),
    url: page.url,
  };
}

const PRIORITY_ORDER = { Alta: 0, Media: 1, Baja: 2 };
function byPriority(a, b) {
  const pa = a.priority in PRIORITY_ORDER ? PRIORITY_ORDER[a.priority] : 3;
  const pb = b.priority in PRIORITY_ORDER ? PRIORITY_ORDER[b.priority] : 3;
  return pa - pb || String(a.planned || a.due || "").localeCompare(String(b.planned || b.due || ""));
}

/**
 * Datos para el resumen: tareas de hoy (incluye vencidas), delegadas que
 * esperan respuesta y cantidad de tareas sin planificar en la bandeja.
 */
async function getDailySummary() {
  if (!DATABASE_ID) {
    throw new Error("NOTION_DATABASE_ID is not set");
  }

  const [today, waiting, inbox] = await Promise.all([
    queryAll({
      and: [
        { property: PROP_TODAY, formula: { checkbox: { equals: true } } },
        { property: PROP_WAITING, checkbox: { equals: false } },
      ],
    }),
    queryAll({
      and: [{ property: PROP_WAITING, checkbox: { equals: true } }, ...notDoneFilters()],
    }),
    queryAll({
      and: [
        { property: PROP_PLANNED, date: { is_empty: true } },
        { property: PROP_WAITING, checkbox: { equals: false } },
        ...notDoneFilters(),
      ],
    }),
  ]);

  return {
    today: today.map(readPage).sort(byPriority),
    waiting: waiting.map(readPage).sort(byPriority),
    inboxCount: inbox.length,
  };
}

module.exports = { createTask, getDailySummary, buildProperties };
