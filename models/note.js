import mongoose from 'mongoose';

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

export default mongoose.model('Note', NoteSchema);