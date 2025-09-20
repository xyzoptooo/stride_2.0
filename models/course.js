const mongoose = require('mongoose');

const CourseSchema = new mongoose.Schema({
  supabaseId: { type: String, required: true },
  name: { type: String, required: true },
  professor: String,
  credits: Number,
  schedule: String,
  progress: Number,
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Course', CourseSchema);