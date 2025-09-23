import mongoose from 'mongoose';

const ActivitySchema = new mongoose.Schema({
  supabaseId: { type: String, required: true },
  type: String, // e.g., "study", "login", "assignment"
  course: String,
  date: Date,
  hours: Number,
  details: String,
  reminder: Date, // When to send reminder
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model('Activity', ActivitySchema);