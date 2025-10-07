import mongoose from 'mongoose';

const ActivitySchema = new mongoose.Schema({
  supabaseId: { type: String, required: true, index: true },
  type: { 
    type: String, 
    required: true,
    enum: [
      'USER_LOGIN', 
      'USER_LOGOUT',
      'COURSE_CREATE', 
      'COURSE_UPDATE', 
      'COURSE_DELETE',
      'ASSIGNMENT_CREATE', 
      'ASSIGNMENT_UPDATE', 
      'ASSIGNMENT_DELETE',
      'NOTE_CREATE',
      'STUDY_SESSION_START',
      'STUDY_SESSION_END',
      'CALENDAR_EVENT_CREATE',
      'CALENDAR_EVENT_UPDATE',
      'CALENDAR_EVENT_DELETE',
      'USER_EVENT' // A generic event type for custom user entries
    ]
  },
  entityId: { type: String }, // ID of the course, assignment, etc.
  title: { type: String }, // For calendar events
  startTime: { type: Date }, // For calendar events
  endTime: { type: Date }, // For calendar events
  details: { type: mongoose.Schema.Types.Mixed }, // Flexible field for additional data
  timestamp: { type: Date, default: Date.now }
});

export default mongoose.model('Activity', ActivitySchema);