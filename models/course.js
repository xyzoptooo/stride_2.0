import mongoose from 'mongoose';

const CourseSchema = new mongoose.Schema({
  supabaseId: { type: String, required: true },
  name: { type: String, required: true },
  professor: String,
  semester: String,
  credits: Number,
  schedule: String,
  progress: Number,
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model('Course', CourseSchema);