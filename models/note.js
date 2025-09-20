const mongoose = require('mongoose');

const NoteSchema = new mongoose.Schema({
  supabaseId: { type: String, required: true },
  title: String,
  tags: [String],
  reminder: Date,
  eventId: String,
  content: String,
  attachments: [String],
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Note', NoteSchema);