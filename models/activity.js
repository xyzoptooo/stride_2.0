import mongoose from 'mongoose';

const ActivitySchema = new mongoose.Schema({
  supabaseId: { type: String, required: true },
  type: String, // e.g., "study", "login", "assignment"
  course: String,
  date: Date,
  hours: Number,
  details: String,
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model('Activity', ActivitySchema);