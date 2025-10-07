import mongoose from 'mongoose';

const ReminderPreferenceSchema = new mongoose.Schema({
  supabaseId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  timezone: {
    type: String,
    default: 'UTC'
  },
  defaultLeadMinutes: {
    type: Number,
    default: 180
  },
  inactivityThresholdHours: {
    type: Number,
    default: 72
  },
  behaviourLookbackDays: {
    type: Number,
    default: 30
  },
  quietHours: {
    startHour: { type: Number, default: 0 },
    endHour: { type: Number, default: 0 }
  },
  preferredWeekdays: {
    type: [Number],
    default: [1, 2, 3, 4, 5]
  },
  snoozeDurationsMinutes: {
    type: [Number],
    default: [10, 30, 60]
  },
  smartRemindersEnabled: {
    type: Boolean,
    default: true
  },
  pushEnabled: {
    type: Boolean,
    default: true
  },
  dataCollectionOptIn: {
    type: Boolean,
    default: true
  },
  encryptionVersion: {
    type: Number,
    default: 1
  }
}, { timestamps: true });

export default mongoose.model('ReminderPreference', ReminderPreferenceSchema);
