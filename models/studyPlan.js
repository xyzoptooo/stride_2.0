import mongoose from 'mongoose';

/**
 * StudyPlan Model - Stores AI-generated study plans with user association
 */
const StudyPlanSchema = new mongoose.Schema({
  supabaseId: { 
    type: String, 
    required: true, 
    index: true 
  },
  
  // Plan metadata
  title: {
    type: String,
    default: 'Study Plan'
  },
  
  generatedAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  
  // Core plan data from AI
  planData: {
    overview: String, // Summary of the plan
    recommendations: [{
      title: String,
      description: String,
      priority: {
        type: String,
        enum: ['high', 'medium', 'low'],
        default: 'medium'
      },
      estimatedDuration: Number, // minutes
      dueDate: Date,
      completed: {
        type: Boolean,
        default: false
      },
      courseId: mongoose.Schema.Types.ObjectId, // Reference to course if applicable
      assignmentId: mongoose.Schema.Types.ObjectId // Reference to assignment if applicable
    }],
    
    studySchedule: [{
      day: {
        type: String,
        enum: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
      },
      timeSlot: String, // e.g., "14:00-16:00"
      activity: String,
      subject: String
    }],
    
    weeklyGoals: [String],
    motivationalMessage: String
  },
  
  // User interaction
  status: {
    type: String,
    enum: ['draft', 'active', 'completed', 'archived'],
    default: 'draft'
  },
  
  userModified: {
    type: Boolean,
    default: false
  },
  
  acceptedAt: Date,
  completedAt: Date,
  
  // Track edits
  editHistory: [{
    editedAt: Date,
    changes: String, // Description of what was changed
    previousData: mongoose.Schema.Types.Mixed
  }],
  
  // Context used for generation (anonymized)
  generationContext: {
    coursesCount: Number,
    assignmentsCount: Number,
    upcomingDeadlinesCount: Number,
    activityPatternSummary: String
  },
  
  // AI metadata
  aiModel: {
    type: String,
    default: 'llama-3.3-70b-versatile'
  },
  
  tokensUsed: Number,
  
  // User feedback
  feedback: {
    helpful: Boolean,
    rating: {
      type: Number,
      min: 1,
      max: 5
    },
    comments: String
  }
}, {
  timestamps: true // Adds createdAt and updatedAt
});

// Indexes for performance
StudyPlanSchema.index({ supabaseId: 1, status: 1 });
StudyPlanSchema.index({ generatedAt: -1 });
StudyPlanSchema.index({ 'planData.recommendations.dueDate': 1 });

// Methods
StudyPlanSchema.methods.markAsAccepted = function() {
  this.status = 'active';
  this.acceptedAt = new Date();
  return this.save();
};

StudyPlanSchema.methods.markAsCompleted = function() {
  this.status = 'completed';
  this.completedAt = new Date();
  return this.save();
};

StudyPlanSchema.methods.addEdit = function(changes, previousData) {
  this.userModified = true;
  this.editHistory.push({
    editedAt: new Date(),
    changes,
    previousData
  });
  return this.save();
};

// Statics
StudyPlanSchema.statics.findActiveForUser = function(supabaseId) {
  return this.find({
    supabaseId,
    status: { $in: ['draft', 'active'] }
  }).sort({ generatedAt: -1 });
};

StudyPlanSchema.statics.findLatestForUser = function(supabaseId) {
  return this.findOne({ supabaseId })
    .sort({ generatedAt: -1 });
};

export default mongoose.model('StudyPlan', StudyPlanSchema);
