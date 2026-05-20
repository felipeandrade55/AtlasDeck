/**
 * SQLite-backed Calendar storage for AtlasDeck.
 *
 * All datetimes stored as UTC ISO 8601 strings. WAL mode + prepared statements.
 * Singleton pattern guarded by globalThis to survive HMR in dev.
 */

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import type {
  AvailabilityRule,
  Booking,
  BookingLink,
  BookingStatus,
  CalendarBlock,
  CalendarEvent,
  CalendarEventInput,
  EventException,
  EventReminder,
  EventReminderInput,
  ReminderChannel,
  RescheduleQueueItem,
  RescheduleStatus,
} from "./calendar-types";

const DB_PATH = path.join(process.cwd(), "data", "calendar.db");

type CalendarGlobal = typeof globalThis & {
  __atlasdeckCalendarDb?: Database.Database;
};

const globalRef = globalThis as CalendarGlobal;

function getDb(): Database.Database {
  if (globalRef.__atlasdeckCalendarDb) return globalRef.__atlasdeckCalendarDb;

  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      location TEXT,
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      all_day INTEGER NOT NULL DEFAULT 0,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      color TEXT,
      status TEXT NOT NULL DEFAULT 'confirmed',
      recurrence_json TEXT,
      source TEXT NOT NULL DEFAULT 'ui',
      parent_booking_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_at);
    CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
    CREATE INDEX IF NOT EXISTS idx_events_source ON events(source);

    CREATE TABLE IF NOT EXISTS event_reminders (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      minutes_before INTEGER NOT NULL,
      channel TEXT NOT NULL,
      sent_at TEXT,
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_reminders_event ON event_reminders(event_id);
    CREATE INDEX IF NOT EXISTS idx_reminders_sent ON event_reminders(sent_at);

    CREATE TABLE IF NOT EXISTS availability_rules (
      id TEXT PRIMARY KEY,
      day_of_week INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      slot_minutes INTEGER NOT NULL DEFAULT 30,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_rules_dow ON availability_rules(day_of_week);

    CREATE TABLE IF NOT EXISTS booking_links (
      id TEXT PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL,
      description TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      expires_at TEXT,
      max_uses INTEGER,
      uses INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_links_token ON booking_links(token);

    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      link_id TEXT NOT NULL,
      name TEXT NOT NULL,
      requester_email TEXT NOT NULL,
      requester_phone TEXT,
      message TEXT,
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      event_id TEXT,
      ip TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      decided_at TEXT,
      FOREIGN KEY (link_id) REFERENCES booking_links(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
    CREATE INDEX IF NOT EXISTS idx_bookings_link ON bookings(link_id);
    CREATE INDEX IF NOT EXISTS idx_bookings_start ON bookings(start_at);

    CREATE TABLE IF NOT EXISTS calendar_blocks (
      id TEXT PRIMARY KEY,
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      all_day INTEGER NOT NULL DEFAULT 0,
      title TEXT,
      reason TEXT,
      source TEXT NOT NULL DEFAULT 'ui',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_blocks_start ON calendar_blocks(start_at);

    CREATE TABLE IF NOT EXISTS reschedule_queue (
      id TEXT PRIMARY KEY,
      original_event_id TEXT NOT NULL,
      block_id TEXT NOT NULL,
      original_start TEXT NOT NULL,
      original_end TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      new_event_id TEXT,
      reason TEXT,
      notified_at TEXT,
      resolved_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (original_event_id) REFERENCES events(id) ON DELETE CASCADE,
      FOREIGN KEY (block_id) REFERENCES calendar_blocks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_queue_status ON reschedule_queue(status);
    CREATE INDEX IF NOT EXISTS idx_queue_block ON reschedule_queue(block_id);

    CREATE TABLE IF NOT EXISTS event_exceptions (
      id TEXT PRIMARY KEY,
      parent_event_id TEXT NOT NULL,
      occurrence_date TEXT NOT NULL,
      action TEXT NOT NULL,
      new_event_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (parent_event_id) REFERENCES events(id) ON DELETE CASCADE,
      UNIQUE (parent_event_id, occurrence_date)
    );

    CREATE INDEX IF NOT EXISTS idx_exceptions_parent ON event_exceptions(parent_event_id);
  `);

  globalRef.__atlasdeckCalendarDb = db;
  return db;
}

function rowToEvent(row: Record<string, unknown>): CalendarEvent {
  return {
    id: row.id as string,
    title: row.title as string,
    description: (row.description as string | null) ?? null,
    location: (row.location as string | null) ?? null,
    start_at: row.start_at as string,
    end_at: row.end_at as string,
    all_day: !!row.all_day,
    timezone: row.timezone as string,
    color: (row.color as string | null) ?? null,
    status: row.status as CalendarEvent["status"],
    recurrence_json: (row.recurrence_json as string | null) ?? null,
    source: row.source as CalendarEvent["source"],
    parent_booking_id: (row.parent_booking_id as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function createEvent(input: CalendarEventInput): CalendarEvent {
  const db = getDb();
  const id = input.id ?? randomUUID();
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO events (id, title, description, location, start_at, end_at, all_day, timezone, color, status, recurrence_json, source, parent_booking_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.title,
      input.description ?? null,
      input.location ?? null,
      input.start_at,
      input.end_at,
      input.all_day ? 1 : 0,
      input.timezone ?? "UTC",
      input.color ?? null,
      input.status ?? "confirmed",
      input.recurrence ? JSON.stringify(input.recurrence) : null,
      input.source ?? "ui",
      input.parent_booking_id ?? null,
      now,
      now
    );

    if (input.reminders?.length) {
      const stmt = db.prepare(
        `INSERT INTO event_reminders (id, event_id, minutes_before, channel) VALUES (?, ?, ?, ?)`
      );
      for (const r of input.reminders) {
        stmt.run(randomUUID(), id, r.minutes_before, r.channel);
      }
    }
  });

  tx();

  const row = db.prepare(`SELECT * FROM events WHERE id = ?`).get(id) as Record<string, unknown>;
  return rowToEvent(row);
}

export function getEventById(id: string): CalendarEvent | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM events WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToEvent(row) : null;
}

export function listEventsInRange(from: string, to: string): CalendarEvent[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM events
       WHERE status != 'cancelled'
         AND (
           (start_at < ? AND end_at > ?)
           OR recurrence_json IS NOT NULL
         )
       ORDER BY start_at ASC`
    )
    .all(to, from) as Record<string, unknown>[];
  return rows.map(rowToEvent);
}

export function listAllEvents(): CalendarEvent[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM events WHERE status != 'cancelled' ORDER BY start_at ASC`)
    .all() as Record<string, unknown>[];
  return rows.map(rowToEvent);
}

export function updateEvent(id: string, patch: Partial<CalendarEventInput>): CalendarEvent | null {
  const db = getDb();
  const existing = getEventById(id);
  if (!existing) return null;

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE events SET
      title = COALESCE(?, title),
      description = COALESCE(?, description),
      location = COALESCE(?, location),
      start_at = COALESCE(?, start_at),
      end_at = COALESCE(?, end_at),
      all_day = COALESCE(?, all_day),
      timezone = COALESCE(?, timezone),
      color = COALESCE(?, color),
      status = COALESCE(?, status),
      recurrence_json = ?,
      updated_at = ?
     WHERE id = ?`
  ).run(
    patch.title ?? null,
    patch.description ?? null,
    patch.location ?? null,
    patch.start_at ?? null,
    patch.end_at ?? null,
    patch.all_day === undefined ? null : patch.all_day ? 1 : 0,
    patch.timezone ?? null,
    patch.color ?? null,
    patch.status ?? null,
    patch.recurrence === undefined ? existing.recurrence_json : patch.recurrence ? JSON.stringify(patch.recurrence) : null,
    now,
    id
  );

  if (patch.reminders) {
    db.prepare(`DELETE FROM event_reminders WHERE event_id = ?`).run(id);
    const stmt = db.prepare(
      `INSERT INTO event_reminders (id, event_id, minutes_before, channel) VALUES (?, ?, ?, ?)`
    );
    for (const r of patch.reminders) {
      stmt.run(randomUUID(), id, r.minutes_before, r.channel);
    }
  }

  return getEventById(id);
}

export function deleteEvent(id: string): boolean {
  const db = getDb();
  const result = db.prepare(`DELETE FROM events WHERE id = ?`).run(id);
  return result.changes > 0;
}

export function listRemindersForEvent(eventId: string): EventReminder[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM event_reminders WHERE event_id = ?`)
    .all(eventId) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as string,
    event_id: r.event_id as string,
    minutes_before: r.minutes_before as number,
    channel: r.channel as ReminderChannel,
    sent_at: (r.sent_at as string | null) ?? null,
  }));
}

export function setReminders(eventId: string, reminders: EventReminderInput[]): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM event_reminders WHERE event_id = ?`).run(eventId);
    const stmt = db.prepare(
      `INSERT INTO event_reminders (id, event_id, minutes_before, channel) VALUES (?, ?, ?, ?)`
    );
    for (const r of reminders) {
      stmt.run(randomUUID(), eventId, r.minutes_before, r.channel);
    }
  });
  tx();
}

export interface DueReminder {
  reminder_id: string;
  event_id: string;
  channel: ReminderChannel;
  minutes_before: number;
  event_title: string;
  event_start_at: string;
  event_location: string | null;
}

export function listDueReminders(now: Date = new Date()): DueReminder[] {
  const db = getDb();
  const nowIso = now.toISOString();
  const rows = db
    .prepare(
      `SELECT
         r.id AS reminder_id,
         r.event_id AS event_id,
         r.channel AS channel,
         r.minutes_before AS minutes_before,
         e.title AS event_title,
         e.start_at AS event_start_at,
         e.location AS event_location
       FROM event_reminders r
       JOIN events e ON e.id = r.event_id
       WHERE r.sent_at IS NULL
         AND e.status = 'confirmed'
         AND datetime(e.start_at, '-' || r.minutes_before || ' minutes') <= datetime(?)
         AND datetime(e.start_at) > datetime(?, '-1 minute')`
    )
    .all(nowIso, nowIso) as Record<string, unknown>[];

  return rows.map((r) => ({
    reminder_id: r.reminder_id as string,
    event_id: r.event_id as string,
    channel: r.channel as ReminderChannel,
    minutes_before: r.minutes_before as number,
    event_title: r.event_title as string,
    event_start_at: r.event_start_at as string,
    event_location: (r.event_location as string | null) ?? null,
  }));
}

export function markReminderSent(reminderId: string): boolean {
  const db = getDb();
  const result = db
    .prepare(`UPDATE event_reminders SET sent_at = datetime('now') WHERE id = ? AND sent_at IS NULL`)
    .run(reminderId);
  return result.changes > 0;
}

function rowToRule(row: Record<string, unknown>): AvailabilityRule {
  return {
    id: row.id as string,
    day_of_week: row.day_of_week as number,
    start_time: row.start_time as string,
    end_time: row.end_time as string,
    slot_minutes: row.slot_minutes as number,
    timezone: row.timezone as string,
    active: !!row.active,
  };
}

export function listAvailabilityRules(activeOnly = true): AvailabilityRule[] {
  const db = getDb();
  const sql = activeOnly
    ? `SELECT * FROM availability_rules WHERE active = 1 ORDER BY day_of_week, start_time`
    : `SELECT * FROM availability_rules ORDER BY day_of_week, start_time`;
  const rows = db.prepare(sql).all() as Record<string, unknown>[];
  return rows.map(rowToRule);
}

export function createAvailabilityRule(input: Omit<AvailabilityRule, "id">): AvailabilityRule {
  const db = getDb();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO availability_rules (id, day_of_week, start_time, end_time, slot_minutes, timezone, active) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, input.day_of_week, input.start_time, input.end_time, input.slot_minutes, input.timezone, input.active ? 1 : 0);
  return { id, ...input };
}

export function updateAvailabilityRule(id: string, patch: Partial<Omit<AvailabilityRule, "id">>): AvailabilityRule | null {
  const db = getDb();
  db.prepare(
    `UPDATE availability_rules SET
       day_of_week = COALESCE(?, day_of_week),
       start_time = COALESCE(?, start_time),
       end_time = COALESCE(?, end_time),
       slot_minutes = COALESCE(?, slot_minutes),
       timezone = COALESCE(?, timezone),
       active = COALESCE(?, active)
     WHERE id = ?`
  ).run(
    patch.day_of_week ?? null,
    patch.start_time ?? null,
    patch.end_time ?? null,
    patch.slot_minutes ?? null,
    patch.timezone ?? null,
    patch.active === undefined ? null : patch.active ? 1 : 0,
    id
  );
  const row = db.prepare(`SELECT * FROM availability_rules WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToRule(row) : null;
}

export function deleteAvailabilityRule(id: string): boolean {
  const db = getDb();
  const result = db.prepare(`DELETE FROM availability_rules WHERE id = ?`).run(id);
  return result.changes > 0;
}

function rowToLink(row: Record<string, unknown>): BookingLink {
  return {
    id: row.id as string,
    token: row.token as string,
    title: row.title as string,
    duration_minutes: row.duration_minutes as number,
    description: (row.description as string | null) ?? null,
    active: !!row.active,
    expires_at: (row.expires_at as string | null) ?? null,
    max_uses: (row.max_uses as number | null) ?? null,
    uses: row.uses as number,
    created_at: row.created_at as string,
  };
}

export function listBookingLinks(): BookingLink[] {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM booking_links ORDER BY created_at DESC`).all() as Record<string, unknown>[];
  return rows.map(rowToLink);
}

export function getBookingLinkByToken(token: string): BookingLink | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM booking_links WHERE token = ?`).get(token) as Record<string, unknown> | undefined;
  return row ? rowToLink(row) : null;
}

export function getBookingLinkById(id: string): BookingLink | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM booking_links WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToLink(row) : null;
}

export function createBookingLink(input: {
  token: string;
  title: string;
  duration_minutes: number;
  description?: string | null;
  active?: boolean;
  expires_at?: string | null;
  max_uses?: number | null;
}): BookingLink {
  const db = getDb();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO booking_links (id, token, title, duration_minutes, description, active, expires_at, max_uses) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.token,
    input.title,
    input.duration_minutes,
    input.description ?? null,
    input.active === false ? 0 : 1,
    input.expires_at ?? null,
    input.max_uses ?? null
  );
  return getBookingLinkById(id)!;
}

export function updateBookingLink(id: string, patch: Partial<Omit<BookingLink, "id" | "created_at" | "uses">>): BookingLink | null {
  const db = getDb();
  db.prepare(
    `UPDATE booking_links SET
       token = COALESCE(?, token),
       title = COALESCE(?, title),
       duration_minutes = COALESCE(?, duration_minutes),
       description = COALESCE(?, description),
       active = COALESCE(?, active),
       expires_at = COALESCE(?, expires_at),
       max_uses = COALESCE(?, max_uses)
     WHERE id = ?`
  ).run(
    patch.token ?? null,
    patch.title ?? null,
    patch.duration_minutes ?? null,
    patch.description ?? null,
    patch.active === undefined ? null : patch.active ? 1 : 0,
    patch.expires_at ?? null,
    patch.max_uses ?? null,
    id
  );
  return getBookingLinkById(id);
}

export function deleteBookingLink(id: string): boolean {
  const db = getDb();
  const result = db.prepare(`DELETE FROM booking_links WHERE id = ?`).run(id);
  return result.changes > 0;
}

function rowToBooking(row: Record<string, unknown>): Booking {
  return {
    id: row.id as string,
    link_id: row.link_id as string,
    name: row.name as string,
    requester_email: row.requester_email as string,
    requester_phone: (row.requester_phone as string | null) ?? null,
    message: (row.message as string | null) ?? null,
    start_at: row.start_at as string,
    end_at: row.end_at as string,
    status: row.status as BookingStatus,
    event_id: (row.event_id as string | null) ?? null,
    ip: (row.ip as string | null) ?? null,
    created_at: row.created_at as string,
    decided_at: (row.decided_at as string | null) ?? null,
  };
}

export function listBookings(status?: BookingStatus): Booking[] {
  const db = getDb();
  const rows = status
    ? (db.prepare(`SELECT * FROM bookings WHERE status = ? ORDER BY created_at DESC`).all(status) as Record<string, unknown>[])
    : (db.prepare(`SELECT * FROM bookings ORDER BY created_at DESC`).all() as Record<string, unknown>[]);
  return rows.map(rowToBooking);
}

export function getBookingById(id: string): Booking | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM bookings WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToBooking(row) : null;
}

export function createBooking(input: {
  link_id: string;
  name: string;
  requester_email: string;
  requester_phone?: string | null;
  message?: string | null;
  start_at: string;
  end_at: string;
  ip?: string | null;
}): Booking {
  const db = getDb();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO bookings (id, link_id, name, requester_email, requester_phone, message, start_at, end_at, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.link_id,
    input.name,
    input.requester_email,
    input.requester_phone ?? null,
    input.message ?? null,
    input.start_at,
    input.end_at,
    input.ip ?? null
  );

  db.prepare(`UPDATE booking_links SET uses = uses + 1 WHERE id = ?`).run(input.link_id);
  return getBookingById(id)!;
}

export function updateBookingStatus(id: string, status: BookingStatus, eventId?: string | null): Booking | null {
  const db = getDb();
  db.prepare(
    `UPDATE bookings SET status = ?, event_id = COALESCE(?, event_id), decided_at = datetime('now') WHERE id = ?`
  ).run(status, eventId ?? null, id);
  return getBookingById(id);
}

export function bookingConflictsWithExisting(start: string, end: string): boolean {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM events
       WHERE status != 'cancelled'
         AND start_at < ?
         AND end_at > ?`
    )
    .get(end, start) as { c: number };
  return row.c > 0;
}

export function bookingConflictsWithPending(start: string, end: string): boolean {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM bookings
       WHERE status IN ('pending', 'approved')
         AND start_at < ?
         AND end_at > ?`
    )
    .get(end, start) as { c: number };
  return row.c > 0;
}

function rowToBlock(row: Record<string, unknown>): CalendarBlock {
  return {
    id: row.id as string,
    start_at: row.start_at as string,
    end_at: row.end_at as string,
    all_day: !!row.all_day,
    title: (row.title as string | null) ?? null,
    reason: (row.reason as string | null) ?? null,
    source: row.source as CalendarBlock["source"],
    created_at: row.created_at as string,
  };
}

export function listBlocksInRange(from: string, to: string): CalendarBlock[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM calendar_blocks WHERE start_at < ? AND end_at > ? ORDER BY start_at ASC`)
    .all(to, from) as Record<string, unknown>[];
  return rows.map(rowToBlock);
}

export function listAllBlocks(): CalendarBlock[] {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM calendar_blocks ORDER BY start_at ASC`).all() as Record<string, unknown>[];
  return rows.map(rowToBlock);
}

export function getBlockById(id: string): CalendarBlock | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM calendar_blocks WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToBlock(row) : null;
}

export function insertBlockRow(input: {
  id?: string;
  start_at: string;
  end_at: string;
  all_day: boolean;
  title?: string | null;
  reason?: string | null;
  source: CalendarBlock["source"];
}): CalendarBlock {
  const db = getDb();
  const id = input.id ?? randomUUID();
  db.prepare(
    `INSERT INTO calendar_blocks (id, start_at, end_at, all_day, title, reason, source) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, input.start_at, input.end_at, input.all_day ? 1 : 0, input.title ?? null, input.reason ?? null, input.source);
  return getBlockById(id)!;
}

export function deleteBlock(id: string): boolean {
  const db = getDb();
  const result = db.prepare(`DELETE FROM calendar_blocks WHERE id = ?`).run(id);
  return result.changes > 0;
}

export function findEventsInRange(start: string, end: string): CalendarEvent[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM events
       WHERE status != 'cancelled'
         AND start_at < ?
         AND end_at > ?
       ORDER BY start_at ASC`
    )
    .all(end, start) as Record<string, unknown>[];
  return rows.map(rowToEvent);
}

function rowToQueueItem(row: Record<string, unknown>): RescheduleQueueItem {
  return {
    id: row.id as string,
    original_event_id: row.original_event_id as string,
    block_id: row.block_id as string,
    original_start: row.original_start as string,
    original_end: row.original_end as string,
    status: row.status as RescheduleStatus,
    new_event_id: (row.new_event_id as string | null) ?? null,
    reason: (row.reason as string | null) ?? null,
    notified_at: (row.notified_at as string | null) ?? null,
    resolved_at: (row.resolved_at as string | null) ?? null,
    created_at: row.created_at as string,
  };
}

export function insertRescheduleItem(input: {
  original_event_id: string;
  block_id: string;
  original_start: string;
  original_end: string;
  reason?: string | null;
}): RescheduleQueueItem {
  const db = getDb();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO reschedule_queue (id, original_event_id, block_id, original_start, original_end, reason) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, input.original_event_id, input.block_id, input.original_start, input.original_end, input.reason ?? null);
  const row = db.prepare(`SELECT * FROM reschedule_queue WHERE id = ?`).get(id) as Record<string, unknown>;
  return rowToQueueItem(row);
}

export function listRescheduleQueue(status?: RescheduleStatus): RescheduleQueueItem[] {
  const db = getDb();
  const rows = status
    ? (db.prepare(`SELECT * FROM reschedule_queue WHERE status = ? ORDER BY created_at DESC`).all(status) as Record<string, unknown>[])
    : (db.prepare(`SELECT * FROM reschedule_queue ORDER BY created_at DESC`).all() as Record<string, unknown>[]);
  return rows.map(rowToQueueItem);
}

export function getRescheduleItemById(id: string): RescheduleQueueItem | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM reschedule_queue WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToQueueItem(row) : null;
}

export function updateRescheduleItem(
  id: string,
  patch: { status?: RescheduleStatus; new_event_id?: string | null; notified_at?: string | null }
): RescheduleQueueItem | null {
  const db = getDb();
  db.prepare(
    `UPDATE reschedule_queue SET
       status = COALESCE(?, status),
       new_event_id = COALESCE(?, new_event_id),
       notified_at = COALESCE(?, notified_at),
       resolved_at = CASE WHEN ? IN ('rescheduled','cancelled') THEN datetime('now') ELSE resolved_at END
     WHERE id = ?`
  ).run(patch.status ?? null, patch.new_event_id ?? null, patch.notified_at ?? null, patch.status ?? null, id);
  return getRescheduleItemById(id);
}

export function cancelQueueItemsForBlock(blockId: string, reason: string): number {
  const db = getDb();
  const result = db
    .prepare(
      `UPDATE reschedule_queue SET status = 'cancelled', reason = ?, resolved_at = datetime('now') WHERE block_id = ? AND status = 'pending'`
    )
    .run(reason, blockId);
  return result.changes;
}

export function insertException(input: {
  parent_event_id: string;
  occurrence_date: string;
  action: "cancelled" | "moved";
  new_event_id?: string | null;
}): EventException {
  const db = getDb();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO event_exceptions (id, parent_event_id, occurrence_date, action, new_event_id) VALUES (?, ?, ?, ?, ?)`
  ).run(id, input.parent_event_id, input.occurrence_date, input.action, input.new_event_id ?? null);
  return {
    id,
    parent_event_id: input.parent_event_id,
    occurrence_date: input.occurrence_date,
    action: input.action,
    new_event_id: input.new_event_id ?? null,
    created_at: new Date().toISOString(),
  };
}

export function listExceptions(parentEventId: string): EventException[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM event_exceptions WHERE parent_event_id = ?`)
    .all(parentEventId) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as string,
    parent_event_id: r.parent_event_id as string,
    occurrence_date: r.occurrence_date as string,
    action: r.action as "cancelled" | "moved",
    new_event_id: (r.new_event_id as string | null) ?? null,
    created_at: r.created_at as string,
  }));
}

export function runInTransaction<T>(fn: () => T): T {
  const db = getDb();
  return db.transaction(fn)();
}

export function _getRawDb(): Database.Database {
  return getDb();
}
