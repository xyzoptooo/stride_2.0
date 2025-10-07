import express from 'express';
import Reminder from '../models/reminder.js';
import ReminderPreference from '../models/reminderPreference.js';
import ReminderAnalytics from '../models/reminderAnalytics.js';
import PushSubscription from '../models/pushSubscription.js';
import { logger } from '../utils/logger.js';
import { AppError } from '../middleware/errorHandler.js';
import { decrypt } from '../utils/encryption.js';
import { logReminderInteraction } from '../services/reminderScheduler.js';
import { env } from '../config/environment.js';

const router = express.Router();

const ALLOWED_ACTIONS = new Set(['delivered', 'snoozed', 'dismissed', 'completed']);
const MAX_REMINDER_LIMIT = 100;

const sanitizeReminder = (reminder) => {
  if (!reminder) return null;
  const plain = reminder.toObject({ virtuals: false });
  try {
    plain.metadata = plain.metadata ? decrypt(plain.metadata) : null;
  } catch (error) {
    logger.warn('Failed to decrypt reminder metadata', { error: error.message, reminderId: reminder._id });
    plain.metadata = null;
  }
  return plain;
};

const parseDate = (value, label) => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(`Invalid date provided for ${label}`, 400);
  }
  return parsed;
};

router.get('/', async (req, res, next) => {
  try {
    const { supabaseId, windowStart, windowEnd, limit } = req.query;

    if (!supabaseId) {
      throw new AppError('supabaseId query parameter is required', 400);
    }

    const parsedLimit = Math.min(parseInt(limit ?? '50', 10), MAX_REMINDER_LIMIT);
    const startDate = windowStart ? parseDate(windowStart, 'windowStart') : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const endDate = windowEnd ? parseDate(windowEnd, 'windowEnd') : null;

    const query = {
      supabaseId,
      status: { $in: ['scheduled', 'queued', 'sent', 'snoozed'] },
      scheduledFor: { $gte: startDate }
    };

    if (endDate) {
      query.scheduledFor.$lte = endDate;
    }

    const reminders = await Reminder.find(query)
      .sort({ scheduledFor: 1 })
      .limit(parsedLimit);

    res.json({
      status: 'success',
      data: reminders.map(sanitizeReminder)
    });
  } catch (error) {
    next(error);
  }
});

router.get('/history', async (req, res, next) => {
  try {
    const { supabaseId, days = 30 } = req.query;
    if (!supabaseId) {
      throw new AppError('supabaseId query parameter is required', 400);
    }
    const windowStart = new Date(Date.now() - Number(days) * 24 * 60 * 60 * 1000);
    const reminders = await Reminder.find({
      supabaseId,
      scheduledFor: { $gte: windowStart }
    }).sort({ scheduledFor: -1 }).limit(MAX_REMINDER_LIMIT);

    res.json({
      status: 'success',
      data: reminders.map(sanitizeReminder)
    });
  } catch (error) {
    next(error);
  }
});

router.post('/:reminderId/interactions', async (req, res, next) => {
  try {
    const { reminderId } = req.params;
    const { action, metadata } = req.body ?? {};

    if (!ALLOWED_ACTIONS.has(action)) {
      throw new AppError('Invalid interaction action', 400);
    }

    const interactionMetadata = { ...metadata };
    if (interactionMetadata?.snoozedUntil) {
      interactionMetadata.snoozedUntil = parseDate(interactionMetadata.snoozedUntil, 'snoozedUntil');
    }

    await logReminderInteraction({
      reminderId,
      action,
      metadata: interactionMetadata
    });

    res.status(204).send();
  } catch (error) {
    if (error.message === 'Reminder not found') {
      return next(new AppError('Reminder not found', 404));
    }
    next(error);
  }
});

router.post('/:reminderId/acknowledge', async (req, res, next) => {
  try {
    const { reminderId } = req.params;
    const reminder = await Reminder.findById(reminderId);
    if (!reminder) {
      throw new AppError('Reminder not found', 404);
    }

    const deliveredAt = new Date();
    reminder.status = 'sent';
    reminder.deliveredAt = deliveredAt;
    reminder.interactions.push({ action: 'delivered', actedAt: deliveredAt });
    await reminder.save();

    res.status(200).json({ status: 'success' });
  } catch (error) {
    next(error);
  }
});

router.get('/preferences', async (req, res, next) => {
  try {
    const { supabaseId } = req.query;
    if (!supabaseId) {
      throw new AppError('supabaseId query parameter is required', 400);
    }

    let preference = await ReminderPreference.findOne({ supabaseId });
    if (!preference) {
      preference = await ReminderPreference.create({ supabaseId });
    }

    res.json({ status: 'success', data: preference });
  } catch (error) {
    next(error);
  }
});

router.put('/preferences', async (req, res, next) => {
  try {
    const { supabaseId, ...updates } = req.body ?? {};

    if (!supabaseId) {
      throw new AppError('supabaseId is required', 400);
    }

    const allowedFields = [
      'timezone',
      'defaultLeadMinutes',
      'inactivityThresholdHours',
      'behaviourLookbackDays',
      'quietHours',
      'preferredWeekdays',
      'snoozeDurationsMinutes',
      'smartRemindersEnabled',
      'pushEnabled',
      'dataCollectionOptIn'
    ];

    const payload = {};
    for (const key of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(updates, key)) {
        payload[key] = updates[key];
      }
    }

    const preference = await ReminderPreference.findOneAndUpdate(
      { supabaseId },
      { $set: payload },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    res.json({ status: 'success', data: preference });
  } catch (error) {
    next(error);
  }
});

router.get('/analytics', async (req, res, next) => {
  try {
    const { supabaseId } = req.query;
    if (!supabaseId) {
      throw new AppError('supabaseId query parameter is required', 400);
    }

    const analytics = await ReminderAnalytics.findOne({ supabaseId });
    res.json({ status: 'success', data: analytics ?? null });
  } catch (error) {
    next(error);
  }
});

router.post('/subscriptions', async (req, res, next) => {
  try {
    const { supabaseId, endpoint, keys } = req.body ?? {};

    if (!supabaseId || !endpoint || !keys?.p256dh || !keys?.auth) {
      throw new AppError('supabaseId, endpoint, and keys are required', 400);
    }

    const subscription = await PushSubscription.findOneAndUpdate(
      { endpoint },
      {
        supabaseId,
        endpoint,
        keys,
        userAgent: req.headers['user-agent'] || req.body.userAgent || null
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    res.status(201).json({ status: 'success', data: subscription });
  } catch (error) {
    if (error.code === 11000) {
      // Handle duplicate key errors gracefully
      return res.status(200).json({ status: 'success' });
    }
    next(error);
  }
});

router.delete('/subscriptions', async (req, res, next) => {
  try {
    const { supabaseId, endpoint } = req.body ?? {};

    if (!endpoint) {
      throw new AppError('endpoint is required to remove a subscription', 400);
    }

    const query = { endpoint };
    if (supabaseId) {
      query.supabaseId = supabaseId;
    }

    await PushSubscription.deleteOne(query);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

router.get('/config/webpush', (req, res) => {
  res.json({
    status: 'success',
    data: {
      vapidPublicKey: env.WEB_PUSH_VAPID_PUBLIC_KEY || null,
      pushEnabled: Boolean(env.WEB_PUSH_VAPID_PUBLIC_KEY && env.WEB_PUSH_VAPID_PRIVATE_KEY)
    }
  });
});

export default router;
