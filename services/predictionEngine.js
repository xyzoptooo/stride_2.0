import { addMinutes, differenceInHours, getDay, getHours } from 'date-fns';
import ReminderAnalytics from '../models/reminderAnalytics.js';
import Reminder from '../models/reminder.js';
import { logger } from '../utils/logger.js';

const DEFAULT_PREFERRED_HOUR = 18;
const SMOOTHING_FACTOR = 0.35;
const DEFAULT_INACTIVITY_THRESHOLD_HOURS = 72;

const clampHour = (hour) => {
  if (Number.isNaN(hour)) return DEFAULT_PREFERRED_HOUR;
  if (hour < 0) return 0;
  if (hour > 23) return 23;
  return Math.round(hour);
};

export const calculatePreferredHour = async (supabaseId) => {
  try {
    const analytics = await ReminderAnalytics.findOne({ supabaseId });
    if (!analytics) {
      return DEFAULT_PREFERRED_HOUR;
    }
    return clampHour(analytics.preferredHourOfDay ?? DEFAULT_PREFERRED_HOUR);
  } catch (error) {
    logger.error('Failed to compute preferred hour', { error: error.message, supabaseId });
    return DEFAULT_PREFERRED_HOUR;
  }
};

export const updateAnalyticsWithInteraction = async ({
  supabaseId,
  reminder,
  interactionAction,
  interactionDate
}) => {
  try {
    const analytics = await ReminderAnalytics.findOne({ supabaseId }) || new ReminderAnalytics({ supabaseId });
    const newSampleSize = (analytics.sampleSize ?? 0) + 1;

    if (reminder?.scheduledFor) {
      const scheduledHour = getHours(reminder.scheduledFor);
      const interactionHour = getHours(interactionDate ?? new Date());
      const smoothedHour = (SMOOTHING_FACTOR * interactionHour) + ((1 - SMOOTHING_FACTOR) * (analytics.preferredHourOfDay ?? DEFAULT_PREFERRED_HOUR));
      analytics.preferredHourOfDay = clampHour(smoothedHour);

      if (interactionAction === 'completed') {
        const leadTimeHours = differenceInHours(interactionDate ?? new Date(), reminder.scheduledFor);
        const absLead = Math.abs(leadTimeHours);
        analytics.averageCompletionLeadHours = Math.max(1, (SMOOTHING_FACTOR * absLead) + ((1 - SMOOTHING_FACTOR) * (analytics.averageCompletionLeadHours ?? 6)));
      }

      analytics.preferredDayOfWeek = getDay(reminder.scheduledFor);
    }

    analytics.sampleSize = newSampleSize;
    analytics.lastComputedAt = new Date();
    await analytics.save();
  } catch (error) {
    logger.error('Failed to update reminder analytics', { error: error.message, supabaseId });
  }
};

export const suggestSchedule = async ({
  supabaseId,
  dueDate,
  preference,
  fallbackMinutes = 180
}) => {
  const preferredHour = await calculatePreferredHour(supabaseId);
  const quietHours = preference?.quietHours || { startHour: 0, endHour: 0 };
  const leadMinutes = preference?.defaultLeadMinutes ?? fallbackMinutes;

  let candidateDate = dueDate ? new Date(dueDate) : addMinutes(new Date(), leadMinutes);
  candidateDate = addMinutes(candidateDate, -leadMinutes);
  candidateDate.setHours(preferredHour, 0, 0, 0);

  if (quietHours.startHour !== quietHours.endHour) {
    const hour = getHours(candidateDate);
    const isQuiet = quietHours.startHour < quietHours.endHour
      ? hour >= quietHours.startHour && hour < quietHours.endHour
      : hour >= quietHours.startHour || hour < quietHours.endHour;
    if (isQuiet) {
      candidateDate.setHours((quietHours.endHour + 1) % 24, 0, 0, 0);
    }
  }

  if (candidateDate < new Date()) {
    candidateDate = addMinutes(new Date(), Math.max(30, leadMinutes / 2));
  }

  return candidateDate;
};

export const computeInactivitySchedule = async ({
  supabaseId,
  lastLoginAt,
  preference
}) => {
  const threshold = preference?.inactivityThresholdHours ?? DEFAULT_INACTIVITY_THRESHOLD_HOURS;
  const preferredHour = await calculatePreferredHour(supabaseId);
  const base = lastLoginAt ? addMinutes(new Date(lastLoginAt), threshold * 60) : addMinutes(new Date(), threshold * 60);
  base.setHours(preferredHour, 0, 0, 0);
  return base;
};

export const dedupeExistingReminder = async ({
  supabaseId,
  type,
  foreignId,
  scheduledFor
}) => {
  const existing = await Reminder.findOne({
    supabaseId,
    type,
    foreignId,
    status: { $in: ['scheduled', 'queued', 'sent', 'snoozed'] }
  });

  if (existing) {
    existing.scheduledFor = scheduledFor;
    await existing.save();
    return existing;
  }

  return null;
};
