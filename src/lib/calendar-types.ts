/**
 * Shared types for the AtlasDeck calendar module.
 *
 * Persistence: SQLite (data/calendar.db). UTC ISO 8601 for all datetimes in DB.
 * `timezone` on events is a display preference for rendering; storage is always UTC.
 */

export type EventStatus = "confirmed" | "tentative" | "cancelled";
export type EventSource = "ui" | "openclaw" | "booking";
export type ReminderChannel = "notification" | "telegram";
export type BookingStatus = "pending" | "approved" | "rejected" | "cancelled";
export type RescheduleStatus = "pending" | "rescheduled" | "cancelled";
export type BlockSource = "ui" | "openclaw";
export type RecurrenceFreq = "daily" | "weekly" | "monthly" | "weekdays";
export type ExceptionAction = "cancelled" | "moved";

export interface Recurrence {
  freq: RecurrenceFreq;
  interval?: number;
  until?: string;
  count?: number;
  byDay?: number[];
}

export interface CalendarEvent {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  start_at: string;
  end_at: string;
  all_day: boolean;
  timezone: string;
  color: string | null;
  status: EventStatus;
  recurrence_json: string | null;
  source: EventSource;
  parent_booking_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CalendarEventInput {
  id?: string;
  title: string;
  description?: string | null;
  location?: string | null;
  start_at: string;
  end_at: string;
  all_day?: boolean;
  timezone?: string;
  color?: string | null;
  status?: EventStatus;
  recurrence?: Recurrence | null;
  source?: EventSource;
  parent_booking_id?: string | null;
  reminders?: EventReminderInput[];
}

export interface EventReminder {
  id: string;
  event_id: string;
  minutes_before: number;
  channel: ReminderChannel;
  sent_at: string | null;
}

export interface EventReminderInput {
  minutes_before: number;
  channel: ReminderChannel;
}

export interface AvailabilityRule {
  id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  slot_minutes: number;
  timezone: string;
  active: boolean;
}

export interface BookingLink {
  id: string;
  token: string;
  title: string;
  duration_minutes: number;
  description: string | null;
  active: boolean;
  expires_at: string | null;
  max_uses: number | null;
  uses: number;
  created_at: string;
}

export interface Booking {
  id: string;
  link_id: string;
  name: string;
  requester_email: string;
  requester_phone: string | null;
  message: string | null;
  start_at: string;
  end_at: string;
  status: BookingStatus;
  event_id: string | null;
  ip: string | null;
  created_at: string;
  decided_at: string | null;
}

export interface CalendarBlock {
  id: string;
  start_at: string;
  end_at: string;
  all_day: boolean;
  title: string | null;
  reason: string | null;
  source: BlockSource;
  created_at: string;
}

export interface RescheduleQueueItem {
  id: string;
  original_event_id: string;
  block_id: string;
  original_start: string;
  original_end: string;
  status: RescheduleStatus;
  new_event_id: string | null;
  reason: string | null;
  notified_at: string | null;
  resolved_at: string | null;
  created_at: string;
}

export interface EventException {
  id: string;
  parent_event_id: string;
  occurrence_date: string;
  action: ExceptionAction;
  new_event_id: string | null;
  created_at: string;
}

export interface ExpandedEvent extends CalendarEvent {
  is_recurring_instance: boolean;
  occurrence_date: string | null;
}
