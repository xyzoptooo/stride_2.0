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
      'STUDY_SESSION_END'
    ]
  },
  entityId: { type: String }, // ID of the course, assignment, etc.
  details: { type: mongoose.Schema.Types.Mixed }, // Flexible field for additional data
  timestamp: { type: Date, default: Date.now }
});

export default mongoose.model('Activity', ActivitySchema);