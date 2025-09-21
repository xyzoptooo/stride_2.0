import mongoose from 'mongoose';

const AssignmentSchema = new mongoose.Schema({
  supabaseId: { type: String, required: true }, // Reference to user
  title: { type: String, required: true },
  course: String,
  dueDate: Date,
  progress: Number,
  reminder: Date,
  notes: String,
  attachments: [String], // Array of file URLs or names
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model('Assignment', AssignmentSchema);