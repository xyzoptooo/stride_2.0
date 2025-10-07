import cron from 'node-cron';
import webPush from 'web-push';
import Reminder from '../models/reminder.js';
import ReminderPreference from '../models/reminderPreference.js';
import ReminderAnalytics from '../models/reminderAnalytics.js';
import Assignment from '../models/assignment.js';
import User from '../models/user.js';
import PushSubscription from '../models/pushSubscription.js';
import { encrypt } from '../utils/encryption.js';
import { env } from '../config/environment.js';
import { logger } from '../utils/logger.js';
import { dedupeExistingReminder, suggestSchedule, computeInactivitySchedule, updateAnalyticsWithInteraction } from './predictionEngine.js';

const DEADLINE_LOOKAHEAD_HOURS = 48;
const DISPATCH_BATCH_SIZE = parseInt(env.REMINDER_MAX_BATCH_SIZE ?? '100', 10);

const ensureVapidConfig = () => {
  if (env.WEB_PUSH_VAPID_PUBLIC_KEY && env.WEB_PUSH_VAPID_PRIVATE_KEY) {
    webPush.setVapidDetails(
      'mailto:support@semesterstride.app',
      env.WEB_PUSH_VAPID_PUBLIC_KEY,
      env.WEB_PUSH_VAPID_PRIVATE_KEY
    );
  } else {
    logger.warn('WEB_PUSH_VAPID_PUBLIC_KEY or WEB_PUSH_VAPID_PRIVATE_KEY not configured. Push delivery disabled.');
  }
};

ensureVapidConfig();

const buildPayload = (reminder) => ({
  title: reminder.title,
  body: reminder.message,
  data: {
    reminderId: reminder._id.toString(),
    type: reminder.type,
    scheduledFor: reminder.scheduledFor,
    snoozeOptions: [10, 30, 60]
  }
});

const fetchPreferencesMap = async () => {
  const preferences = await ReminderPreference.find({ smartRemindersEnabled: true });
  return preferences.reduce((acc, pref) => {
    acc[pref.supabaseId] = pref;
    return acc;
  }, {});
};

const scheduleDeadlineReminders = async ({ preferences }) => {
  const now = new Date();
  const upperBound = new Date(now.getTime() + DEADLINE_LOOKAHEAD_HOURS * 60 * 60 * 1000);
  const assignments = await Assignment.find({
    dueDate: { $gte: now, $lte: upperBound },
    progress: { $lt: 100 }
  }).limit(DISPATCH_BATCH_SIZE * 2);

  for (const assignment of assignments) {
    const supabaseId = assignment.supabaseId;
    const preference = preferences[supabaseId];
    if (!preference?.smartRemindersEnabled) continue;

    const scheduledFor = await suggestSchedule({
      supabaseId,
      dueDate: assignment.dueDate,
      preference
    });

    const existing = await dedupeExistingReminder({
      supabaseId,
      type: 'DEADLINE',
      foreignId: assignment._id.toString(),
      scheduledFor
    });

    if (existing) continue;

    const reminder = new Reminder({
      supabaseId,
      type: 'DEADLINE',
      title: `Upcoming: ${assignment.title}`,
      message: `Your assignment "${assignment.title}" is due on ${assignment.dueDate?.toLocaleString()}.` ,
      foreignId: assignment._id.toString(),
      scheduledFor,
      metadata: encrypt({ assignmentId: assignment._id, dueDate: assignment.dueDate })
    });

    await reminder.save();
  }
};

const scheduleInactivityReminders = async ({ preferences }) => {
  const users = await User.find({ smartRemindersOptIn: { $ne: false } }).limit(DISPATCH_BATCH_SIZE * 2);

  for (const user of users) {
    const preference = preferences[user.supabaseId];
    if (!preference?.smartRemindersEnabled) continue;

    const targetDate = await computeInactivitySchedule({
      supabaseId: user.supabaseId,
      lastLoginAt: user.lastLoginAt,
      preference
    });

    if (!targetDate || targetDate < new Date()) continue;

    const existing = await dedupeExistingReminder({
      supabaseId: user.supabaseId,
      type: 'INACTIVITY',
      foreignId: user.supabaseId,
      scheduledFor: targetDate
    });

    if (existing) continue;

    const reminder = new Reminder({
      supabaseId: user.supabaseId,
      type: 'INACTIVITY',
      title: 'We miss you at SemesterStride',
      message: 'Jump back in to keep your study plan on track.',
      foreignId: user.supabaseId,
      scheduledFor: targetDate,
      metadata: encrypt({ reason: 'inactivity', inactivityThresholdHours: preference.inactivityThresholdHours })
    });

    await reminder.save();
  }
};

const scheduleBehaviouralReminders = async ({ preferences }) => {
  const analytics = await ReminderAnalytics.find({}).limit(DISPATCH_BATCH_SIZE);

  for (const row of analytics) {
    const preference = preferences[row.supabaseId];
    if (!preference?.smartRemindersEnabled) continue;

    const candidate = await suggestSchedule({
      supabaseId: row.supabaseId,
      dueDate: null,
      preference,
      fallbackMinutes: row.averageCompletionLeadHours * 60
    });

    const existing = await dedupeExistingReminder({
      supabaseId: row.supabaseId,
      type: 'BEHAVIORAL',
      foreignId: `behaviour_${candidate.toISOString().slice(0, 10)}`,
      scheduledFor: candidate
    });

    if (existing) continue;

    const reminder = new Reminder({
      supabaseId: row.supabaseId,
      type: 'BEHAVIORAL',
      title: 'Quick study suggestion',
      message: 'Based on your recent activity, now is a great time for a focused session.',
      foreignId: `behaviour_${candidate.toISOString().slice(0, 10)}`,
      scheduledFor: candidate,
      metadata: encrypt({ reason: 'behavioural', hint: 'study-session' })
    });

    await reminder.save();
  }
};

const dispatchDueReminders = async () => {
  const now = new Date();
  const windowStart = new Date(now.getTime() - 5 * 60 * 1000);
  const reminders = await Reminder.find({
    scheduledFor: { $gte: windowStart, $lte: now },
    status: { $in: ['scheduled', 'queued', 'snoozed'] }
  }).limit(DISPATCH_BATCH_SIZE);

  for (const reminder of reminders) {
    const subscriptions = await PushSubscription.find({ supabaseId: reminder.supabaseId });
    if (!subscriptions.length) {
      logger.info('No push subscription found for user', { supabaseId: reminder.supabaseId });
      continue;
    }

    for (const subscription of subscriptions) {
      try {
        if (!env.WEB_PUSH_VAPID_PUBLIC_KEY || !env.WEB_PUSH_VAPID_PRIVATE_KEY) {
          break;
        }
        await webPush.sendNotification(subscription.toObject(), JSON.stringify(buildPayload(reminder)));
      } catch (error) {
        logger.error('Failed to send push notification', {
          error: error.message,
          endpoint: subscription.endpoint
        });
      }
    }

    reminder.status = 'sent';
    reminder.sentAt = now;
    reminder.interactions.push({ action: 'sent', actedAt: now });
    await reminder.save();
  }
};

const cleanUpResolvedReminders = async () => {
  const now = new Date();
  await Reminder.updateMany(
    { status: 'sent', scheduledFor: { $lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
    { status: 'dismissed' }
  );
};

export const runReminderScheduler = async () => {
  const preferences = await fetchPreferencesMap();
  await scheduleDeadlineReminders({ preferences });
  await scheduleInactivityReminders({ preferences });
  await scheduleBehaviouralReminders({ preferences });
  await dispatchDueReminders();
  await cleanUpResolvedReminders();
};

cron.schedule('*/5 * * * *', async () => {
  try {
    await runReminderScheduler();
  } catch (error) {
    logger.error('Reminder scheduler failed', { error: error.message });
  }
});

export const logReminderInteraction = async ({ reminderId, action, metadata }) => {
  const reminder = await Reminder.findById(reminderId);
  if (!reminder) {
    throw new Error('Reminder not found');
  }

  const actedAt = new Date();

  reminder.interactions.push({ action, actedAt, metadata });

  if (action === 'snoozed' && metadata?.snoozedUntil) {
    reminder.status = 'snoozed';
    reminder.snoozedUntil = metadata.snoozedUntil;
    reminder.scheduledFor = metadata.snoozedUntil;
  }

  if (action === 'dismissed') {
    reminder.status = 'dismissed';
  }

  if (action === 'completed') {
    reminder.status = 'completed';
    reminder.completionLoggedAt = actedAt;
  }

  await reminder.save();

  await updateAnalyticsWithInteraction({
    supabaseId: reminder.supabaseId,
    reminder,
    interactionAction: action,
    interactionDate: actedAt
  });
};
