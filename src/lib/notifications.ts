import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

const DATA_PATH = path.join(process.cwd(), 'data', 'notifications.json');

export interface Notification {
  id: string;
  timestamp: string;
  title: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
  read: boolean;
  link?: string;
  metadata?: Record<string, unknown>;
}

export async function loadNotifications(): Promise<Notification[]> {
  try {
    const data = await fs.readFile(DATA_PATH, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

export async function saveNotifications(notifications: Notification[]): Promise<void> {
  const dir = path.dirname(DATA_PATH);
  try {
    await fs.access(dir);
  } catch {
    await fs.mkdir(dir, { recursive: true });
  }
  await fs.writeFile(DATA_PATH, JSON.stringify(notifications, null, 2));
}

export async function addNotification(
  title: string,
  message: string,
  type: 'info' | 'success' | 'warning' | 'error' = 'info',
  link?: string,
  metadata?: Record<string, unknown>
): Promise<Notification> {
  const notifications = await loadNotifications();

  const newNotification: Notification = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    title,
    message,
    type,
    read: false,
    link,
    metadata,
  };

  // Prepend (newest first)
  notifications.unshift(newNotification);

  // Keep only last 100 notifications
  if (notifications.length > 100) {
    notifications.splice(100);
  }

  await saveNotifications(notifications);
  return newNotification;
}
