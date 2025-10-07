import express from 'express';
import Activity from '../models/activity.js';
import Assignment from '../models/assignment.js';
import User from '../models/user.js';
import Course from '../models/course.js';
import StudyPlan from '../models/studyPlan.js';
import { 
  generateTaskRecommendations, 
  generateWeeklyAnalytics,
  generateStudyTimeSuggestion,
  generateCourseProgressInsight,
  generateStudyPlan,
  healthCheck 
} from '../services/groqAI.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

/**
 * GET /api/ai/recommendations/:supabaseId
 * Get AI-powered task recommendations
 */
router.get('/recommendations/:supabaseId', async (req, res) => {
  try {
    const { supabaseId } = req.params;
    
    // Check if user has AI features enabled
    const user = await User.findOne({ supabaseId });
    if (!user || !user.aiPreferences?.enabled) {
      return res.status(200).json({
        status: 'success',
        data: {
          enabled: false,
          message: 'AI recommendations are disabled. Enable them in settings.'
        }
      });
    }

    // Fetch recent activities (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const activities = await Activity.find({
      supabaseId,
      timestamp: { $gte: thirtyDaysAgo }
    }).sort({ timestamp: -1 }).limit(500);

    // Fetch assignments
    const assignments = await Assignment.find({ supabaseId });

    // Get user preferences
    const preferences = user.aiPreferences || {};

    // Generate recommendations
    const recommendations = await generateTaskRecommendations({
      activities,
      assignments,
      preferences
    });

    res.json({
      status: 'success',
      data: {
        enabled: true,
        ...recommendations,
        generatedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    logger.error('Failed to get AI recommendations', { 
      error: error.message,
      supabaseId: req.params.supabaseId 
    });
    res.status(500).json({
      status: 'error',
      message: 'Failed to generate recommendations'
    });
  }
});

/**
 * GET /api/ai/weekly-analytics/:supabaseId
 * Get weekly performance analytics
 */
router.get('/weekly-analytics/:supabaseId', async (req, res) => {
  try {
    const { supabaseId } = req.params;
    
    // Check AI preferences
    const user = await User.findOne({ supabaseId });
    if (!user || !user.aiPreferences?.enabled) {
      return res.status(200).json({
        status: 'success',
        data: { enabled: false }
      });
    }

    // Get activities from last 7 days
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    
    const weeklyActivities = await Activity.find({
      supabaseId,
      timestamp: { $gte: weekAgo }
    });

    // Calculate completion stats
    const assignments = await Assignment.find({ supabaseId });
    const completionStats = {
      completed: assignments.filter(a => a.progress === 100).length,
      pending: assignments.filter(a => a.progress < 100).length,
      completionRate: assignments.length > 0 
        ? Math.round((assignments.filter(a => a.progress === 100).length / assignments.length) * 100)
        : 0,
      loginStreak: await calculateLoginStreak(supabaseId)
    };

    const analytics = await generateWeeklyAnalytics({
      weeklyActivities,
      completionStats
    });

    res.json({
      status: 'success',
      data: {
        enabled: true,
        ...analytics,
        stats: completionStats,
        generatedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    logger.error('Failed to get weekly analytics', { 
      error: error.message,
      supabaseId: req.params.supabaseId 
    });
    res.status(500).json({
      status: 'error',
      message: 'Failed to generate analytics'
    });
  }
});

/**
 * GET /api/ai/study-time-suggestion/:supabaseId
 * Get best study time suggestion
 */
router.get('/study-time-suggestion/:supabaseId', async (req, res) => {
  try {
    const { supabaseId } = req.params;
    
    const user = await User.findOne({ supabaseId });
    if (!user || !user.aiPreferences?.enabled) {
      return res.status(200).json({
        status: 'success',
        data: { enabled: false }
      });
    }

    // Get recent activities
    const recentActivities = await Activity.find({ supabaseId })
      .sort({ timestamp: -1 })
      .limit(200);

    // Get upcoming tasks
    const upcomingTasks = await Assignment.find({
      supabaseId,
      dueDate: { $gte: new Date() },
      progress: { $lt: 100 }
    }).limit(50);

    const suggestion = await generateStudyTimeSuggestion({
      activities: recentActivities,
      upcomingTasks
    });

    res.json({
      status: 'success',
      data: {
        enabled: true,
        ...suggestion,
        generatedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    logger.error('Failed to get study time suggestion', { 
      error: error.message,
      supabaseId: req.params.supabaseId 
    });
    res.status(500).json({
      status: 'error',
      message: 'Failed to generate suggestion'
    });
  }
});

/**
 * GET /api/ai/course-insights/:supabaseId
 * Get course-specific progress insights
 */
router.get('/course-insights/:supabaseId', async (req, res) => {
  try {
    const { supabaseId } = req.params;
    
    const user = await User.findOne({ supabaseId });
    if (!user || !user.aiPreferences?.enabled) {
      return res.status(200).json({
        status: 'success',
        data: { enabled: false }
      });
    }

    // Get courses with assignment data
    const courses = await Course.find({ supabaseId });
    const assignments = await Assignment.find({ supabaseId });
    
    // Aggregate data by course
    const courseData = courses.map(course => {
      const courseAssignments = assignments.filter(a => a.course === course.name);
      return {
        assignmentsTotal: courseAssignments.length,
        assignmentsCompleted: courseAssignments.filter(a => a.progress === 100).length,
        averageScore: courseAssignments.length > 0
          ? Math.round(courseAssignments.reduce((sum, a) => sum + (a.progress || 0), 0) / courseAssignments.length)
          : 0
      };
    });

    const insights = await generateCourseProgressInsight({ courses: courseData });

    res.json({
      status: 'success',
      data: {
        enabled: true,
        ...insights,
        generatedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    logger.error('Failed to get course insights', { 
      error: error.message,
      supabaseId: req.params.supabaseId 
    });
    res.status(500).json({
      status: 'error',
      message: 'Failed to generate insights'
    });
  }
});

/**
 * PUT /api/ai/preferences/:supabaseId
 * Update AI preferences for user
 */
router.put('/preferences/:supabaseId', async (req, res) => {
  try {
    const { supabaseId } = req.params;
    const { enabled } = req.body;

    const user = await User.findOneAndUpdate(
      { supabaseId },
      { 
        $set: { 
          'aiPreferences.enabled': enabled === true,
          'aiPreferences.updatedAt': new Date()
        }
      },
      { new: true, upsert: true }
    );

    logger.info('AI preferences updated', { supabaseId, enabled });

    res.json({
      status: 'success',
      data: {
        enabled: user.aiPreferences?.enabled || false
      }
    });
  } catch (error) {
    logger.error('Failed to update AI preferences', { 
      error: error.message,
      supabaseId: req.params.supabaseId 
    });
    res.status(500).json({
      status: 'error',
      message: 'Failed to update preferences'
    });
  }
});

/**
 * GET /api/ai/preferences/:supabaseId
 * Get AI preferences for user
 */
router.get('/preferences/:supabaseId', async (req, res) => {
  try {
    const { supabaseId } = req.params;
    
    const user = await User.findOne({ supabaseId });
    
    res.json({
      status: 'success',
      data: {
        enabled: user?.aiPreferences?.enabled || false,
        updatedAt: user?.aiPreferences?.updatedAt || null
      }
    });
  } catch (error) {
    logger.error('Failed to get AI preferences', { 
      error: error.message,
      supabaseId: req.params.supabaseId 
    });
    res.status(500).json({
      status: 'error',
      message: 'Failed to get preferences'
    });
  }
});

/**
 * GET /api/ai/health
 * Health check for AI service
 */
router.get('/health', async (req, res) => {
  try {
    const health = await healthCheck();
    res.json({
      status: 'success',
      data: health
    });
  } catch (error) {
    res.status(503).json({
      status: 'error',
      message: 'AI service unavailable'
    });
  }
});

/**
 * Helper: Calculate login streak
 */
async function calculateLoginStreak(supabaseId) {
  const logins = await Activity.find({
    supabaseId,
    type: 'USER_LOGIN'
  }).sort({ timestamp: -1 }).limit(30);

  if (logins.length === 0) return 0;

  let streak = 0;
  let currentDate = new Date();
  currentDate.setHours(0, 0, 0, 0);

  for (const login of logins) {
    const loginDate = new Date(login.timestamp);
    loginDate.setHours(0, 0, 0, 0);
    
    const daysDiff = Math.floor((currentDate - loginDate) / (1000 * 60 * 60 * 24));
    
    if (daysDiff === streak) {
      streak++;
    } else {
      break;
    }
  }

  return streak;
}

/**
 * POST /api/ai/study-plan/:supabaseId
 * Generate a comprehensive AI study plan
 */
router.post('/study-plan/:supabaseId', async (req, res) => {
  try {
    const { supabaseId } = req.params;
    
    // Check if user has AI features enabled
    const user = await User.findOne({ supabaseId });
    if (!user || !user.aiPreferences?.enabled) {
      return res.status(200).json({
        status: 'success',
        data: {
          enabled: false,
          message: 'AI study planning is disabled. Enable AI features in settings.'
        }
      });
    }

    // Fetch user's courses
    const courses = await Course.find({ supabaseId });
    if (courses.length === 0) {
      return res.status(400).json({
        status: 'error',
        message: 'No courses found. Please add courses before generating a study plan.'
      });
    }

    // Fetch assignments
    const assignments = await Assignment.find({ 
      supabaseId,
      dueDate: { $exists: true }
    });

    // Fetch recent activities (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const activities = await Activity.find({
      supabaseId,
      timestamp: { $gte: thirtyDaysAgo }
    }).sort({ timestamp: -1 }).limit(500);

    // Get user preferences
    const preferences = user.aiPreferences || {};

    // Generate study plan via Groq AI
    const planData = await generateStudyPlan({
      courses,
      assignments,
      activities,
      preferences
    });

    // Save to database
    const studyPlan = new StudyPlan({
      supabaseId,
      title: `Study Plan - ${new Date().toLocaleDateString()}`,
      planData,
      generationContext: planData.generationContext,
      aiModel: 'llama-3.3-70b-versatile',
      status: 'draft'
    });

    await studyPlan.save();

    res.json({
      status: 'success',
      data: {
        planId: studyPlan._id,
        ...planData,
        generatedAt: studyPlan.generatedAt,
        status: studyPlan.status
      }
    });

  } catch (error) {
    logger.error('Failed to generate study plan', { 
      error: error.message,
      supabaseId: req.params.supabaseId
    });
    res.status(500).json({
      status: 'error',
      message: 'Failed to generate study plan. Please try again.'
    });
  }
});

/**
 * GET /api/ai/study-plan/:supabaseId/latest
 * Get the latest study plan for a user
 */
router.get('/study-plan/:supabaseId/latest', async (req, res) => {
  try {
    const { supabaseId } = req.params;
    
    const latestPlan = await StudyPlan.findLatestForUser(supabaseId);
    
    if (!latestPlan) {
      return res.status(404).json({
        status: 'error',
        message: 'No study plans found. Generate your first plan!'
      });
    }

    res.json({
      status: 'success',
      data: {
        planId: latestPlan._id,
        title: latestPlan.title,
        ...latestPlan.planData,
        status: latestPlan.status,
        generatedAt: latestPlan.generatedAt,
        acceptedAt: latestPlan.acceptedAt,
        userModified: latestPlan.userModified
      }
    });

  } catch (error) {
    logger.error('Failed to fetch latest study plan', { 
      error: error.message,
      supabaseId: req.params.supabaseId
    });
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch study plan'
    });
  }
});

/**
 * PATCH /api/ai/study-plan/:planId/accept
 * Mark a study plan as accepted (active)
 */
router.patch('/study-plan/:planId/accept', async (req, res) => {
  try {
    const { planId } = req.params;
    
    const studyPlan = await StudyPlan.findById(planId);
    if (!studyPlan) {
      return res.status(404).json({
        status: 'error',
        message: 'Study plan not found'
      });
    }

    await studyPlan.markAsAccepted();

    res.json({
      status: 'success',
      data: {
        planId: studyPlan._id,
        status: studyPlan.status,
        acceptedAt: studyPlan.acceptedAt
      }
    });

  } catch (error) {
    logger.error('Failed to accept study plan', { 
      error: error.message,
      planId: req.params.planId
    });
    res.status(500).json({
      status: 'error',
      message: 'Failed to accept study plan'
    });
  }
});

/**
 * PATCH /api/ai/study-plan/:planId/edit
 * Edit a study plan and track changes
 */
router.patch('/study-plan/:planId/edit', async (req, res) => {
  try {
    const { planId } = req.params;
    const { planData, changes } = req.body;
    
    const studyPlan = await StudyPlan.findById(planId);
    if (!studyPlan) {
      return res.status(404).json({
        status: 'error',
        message: 'Study plan not found'
      });
    }

    const previousData = { ...studyPlan.planData };
    
    // Update plan data
    studyPlan.planData = { ...studyPlan.planData, ...planData };
    
    // Track edit
    await studyPlan.addEdit(changes || 'User edited plan', previousData);

    res.json({
      status: 'success',
      data: {
        planId: studyPlan._id,
        ...studyPlan.planData,
        userModified: studyPlan.userModified,
        editHistory: studyPlan.editHistory
      }
    });

  } catch (error) {
    logger.error('Failed to edit study plan', { 
      error: error.message,
      planId: req.params.planId
    });
    res.status(500).json({
      status: 'error',
      message: 'Failed to edit study plan'
    });
  }
});

/**
 * DELETE /api/ai/study-plan/:planId
 * Archive (soft delete) a study plan
 */
router.delete('/study-plan/:planId', async (req, res) => {
  try {
    const { planId } = req.params;
    
    const studyPlan = await StudyPlan.findById(planId);
    if (!studyPlan) {
      return res.status(404).json({
        status: 'error',
        message: 'Study plan not found'
      });
    }

    studyPlan.status = 'archived';
    await studyPlan.save();

    res.json({
      status: 'success',
      message: 'Study plan archived successfully'
    });

  } catch (error) {
    logger.error('Failed to archive study plan', { 
      error: error.message,
      planId: req.params.planId
    });
    res.status(500).json({
      status: 'error',
      message: 'Failed to archive study plan'
    });
  }
});

export default router;
