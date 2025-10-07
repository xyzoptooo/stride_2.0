import mongoose from 'mongoose';

const ReminderInteractionSchema = new mongoose.Schema({
  action: {
    type: String,
    enum: ['sent', 'delivered', 'snoozed', 'dismissed', 'completed', 'auto_completed'],
    required: true
  },
  actedAt: {
    type: Date,
    default: Date.now
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed
  }
}, { _id: false });

const ReminderSchema = new mongoose.Schema({
  supabaseId: {
    type: String,
    required: true,
    index: true
  },
  type: {
    type: String,
    enum: ['DEADLINE', 'INACTIVITY', 'BEHAVIORAL'],
    required: true,
    index: true
  },
  title: {
    type: String,
    required: true
  },
  message: {
    type: String,
    required: true
  },
  channel: {
    type: String,
    enum: ['push'],
    default: 'push'
  },
  scheduledFor: {
    type: Date,
    required: true,
    index: true
  },
  sentAt: Date,
  deliveredAt: Date,
  status: {
    type: String,
    enum: ['scheduled', 'queued', 'sent', 'snoozed', 'dismissed', 'completed'],
    default: 'scheduled'
  },
  snoozedUntil: Date,
  completionLoggedAt: Date,
  foreignId: String,
  metadata: String, // encrypted payload
  interactions: {
    type: [ReminderInteractionSchema],
    default: []
  }
}, {
  timestamps: true
});

ReminderSchema.index({ supabaseId: 1, type: 1, foreignId: 1 }, { unique: false });

export default mongoose.model('Reminder', ReminderSchema);
