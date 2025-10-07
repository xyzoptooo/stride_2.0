import mongoose from 'mongoose';

const ReminderAnalyticsSchema = new mongoose.Schema({
  supabaseId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  preferredHourOfDay: {
    type: Number,
    default: 18
  },
  preferredDayOfWeek: {
    type: Number,
    default: 1
  },
  averageCompletionLeadHours: {
    type: Number,
    default: 6
  },
  averageInactivityHours: {
    type: Number,
    default: 96
  },
  sampleSize: {
    type: Number,
    default: 0
  },
  lastComputedAt: Date
}, { timestamps: true });

export default mongoose.model('ReminderAnalytics', ReminderAnalyticsSchema);
