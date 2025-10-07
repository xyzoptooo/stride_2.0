import mongoose from 'mongoose';

const PushSubscriptionSchema = new mongoose.Schema({
  supabaseId: {
    type: String,
    required: true,
    index: true
  },
  endpoint: {
    type: String,
    required: true,
    unique: true
  },
  keys: {
    p256dh: { type: String, required: true },
    auth: { type: String, required: true }
  },
  userAgent: String,
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

PushSubscriptionSchema.index({ supabaseId: 1, endpoint: 1 }, { unique: true });

PushSubscriptionSchema.pre('save', function handleSave(next) {
  this.updatedAt = new Date();
  next();
});

export default mongoose.model('PushSubscription', PushSubscriptionSchema);
