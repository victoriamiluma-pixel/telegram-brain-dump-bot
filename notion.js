const { Client } = require("@notionhq/client");

// Pinned to a pre-"multi-source-database" API version so a plain
// NOTION_DATABASE_ID (copied from the database URL) works as the page
// parent, regardless of which @notionhq/client version is installed.
const notion = new Client({
  auth: process.env.NOTION_API_KEY,
  notionVersion: "2022-06-28",
});

const DATABASE_ID = process.env.NOTION_DATABASE_ID;

// Property names in the "Brain Dump Tasks" Notion database. Override via env
// vars if you're pointing this at a database with different column names.
const PROP_TITLE = process.env.NOTION_PROP_TITLE || "Task name";
const PROP_STATUS = process.env.NOTION_PROP_STATUS || "Status";
const PROP_STATUS_DEFAULT = process.env.NOTION_PROP_STATUS_DEFAULT || "Not started";
const PROP_DUE = process.env.NOTION_PROP_DUE || "Due";
const PROP_NOTES = process.env.NOTION_PROP_NOTES || "Notes";
const PROP_SOURCE = process.env.NOTION_PROP_SOURCE || "Source";

function buildProperties(task, sourceLabel, { includeStatus = true, includeDue = true } = {}) {
  const properties = {
    [PROP_TITLE]: {
      title: [{ text: { content: String(task.title).slice(0, 2000) } }],
    },
  };

  if (includeStatus) {
    properties[PROP_STATUS] = { status: { name: PROP_STATUS_DEFAULT } };
  }

  if (task.description) {
    properties[PROP_NOTES] = {
      rich_text: [{ text: { content: String(task.description).slice(0, 2000) } }],
    };
  }

  if (includeDue && task.due_date) {
    properties[PROP_DUE] = { date: { start: task.due_date } };
  }

  if (sourceLabel) {
    properties[PROP_SOURCE] = {
      rich_text: [{ text: { content: String(sourceLabel).slice(0, 2000) } }],
    };
  }

  return properties;
}

/**
 * Create one task page in the configured Notion database.
 * Falls back to a minimal property set if the database schema doesn't
 * match exactly, so a schema mismatch never silently drops the task.
 *
 * @param {Object} task
 * @param {string} task.title
 * @param {string} [task.description]
 * @param {string|null} [task.due_date] ISO date string (YYYY-MM-DD) or null
 * @param {string} [sourceLabel] free-text note on where this task came from
 */
async function createTask(task, sourceLabel) {
  if (!DATABASE_ID) {
    throw new Error("NOTION_DATABASE_ID is not set");
  }

  const attempts = [
    { includeStatus: true, includeDue: true },
    { includeStatus: false, includeDue: true },
    { includeStatus: false, includeDue: false },
  ];

  let lastError;
  for (const opts of attempts) {
    try {
      return await notion.pages.create({
        parent: { database_id: DATABASE_ID },
        properties: buildProperties(task, sourceLabel, opts),
      });
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

module.exports = { createTask };
