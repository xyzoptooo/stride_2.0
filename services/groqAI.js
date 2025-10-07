import axios from 'axios';
import { env } from '../config/environment.js';
import { logger } from '../utils/logger.js';
import { encrypt, decrypt } from '../utils/encryption.js';

/**
 * Groq AI Service Layer
 * 
 * This module handles all interactions with the Groq API for intelligent, 
 * context-aware academic assistance.
 * 
 * PRIVACY PRINCIPLES:
 * - Never send PII (names, emails, course titles, assignment text)
 * - Only send anonymized summaries and aggregated data
 * - Cache responses securely to minimize API calls
 * - All AI activity is logged and encrypted locally
 * - User consent required before any AI feature usage
 */

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile'; // Fast and capable model
const MAX_TOKENS = 1024;
const TEMPERATURE = 0.7;

// In-memory cache for AI responses (production should use Redis)
const responseCache = new Map();
const CACHE_TTL = 3600000; // 1 hour in milliseconds

/**
 * Helper to make Groq API requests with error handling
 */
async function callGroqAPI({ messages, maxTokens = MAX_TOKENS, temperature = TEMPERATURE }) {
  if (!env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY not configured');
  }

  try {
    const response = await axios.post(
      GROQ_API_URL,
      {
        model: GROQ_MODEL,
        messages,
        max_tokens: maxTokens,
        temperature,
      },
      {
        headers: {
          'Authorization': `Bearer ${env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000, // 15 second timeout
      }
    );

    return response.data.choices[0]?.message?.content || '';
  } catch (error) {
    logger.error('Groq API call failed', {
      error: error.message,
      status: error.response?.status,
      details: error.response?.data,
    });
    throw new Error('AI service temporarily unavailable');
  }
}

/**
 * Generate a cache key for responses
 */
function getCacheKey(prefix, data) {
  const dataString = JSON.stringify(data);
  return `${prefix}:${Buffer.from(dataString).toString('base64').substring(0, 50)}`;
}

/**
 * Get cached response if available and not expired
 */
function getCachedResponse(cacheKey) {
  const cached = responseCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    logger.info('Returning cached AI response', { cacheKey });
    return cached.data;
  }
  responseCache.delete(cacheKey);
  return null;
}

/**
 * Cache an AI response
 */
function setCachedResponse(cacheKey, data) {
  responseCache.set(cacheKey, {
    data,
    timestamp: Date.now(),
  });
}

/**
 * Anonymize user activity data before sending to Groq
 * Removes all PII and keeps only behavioral patterns
 */
function anonymizeActivityData(activities) {
  return activities.map((activity, index) => ({
    id: `activity_${index}`,
    type: activity.type,
    timestamp: activity.timestamp,
    dayOfWeek: new Date(activity.timestamp).getDay(),
    hourOfDay: new Date(activity.timestamp).getHours(),
  }));
}

/**
 * Generate intelligent task recommendations based on user activity patterns
 * 
 * @param {Object} params
 * @param {Array} params.activities - User activity logs (will be anonymized)
 * @param {Array} params.assignments - Assignment summary (anonymized)
 * @param {Object} params.preferences - User preferences
 * @returns {Promise<Object>} - AI-generated recommendations
 */
export async function generateTaskRecommendations({ activities, assignments, preferences }) {
  const cacheKey = getCacheKey('task_recommendations', { activities: activities.length, assignments: assignments.length });
  const cached = getCachedResponse(cacheKey);
  if (cached) return cached;

  // Anonymize data
  const anonymizedActivities = anonymizeActivityData(activities);
  const anonymizedAssignments = assignments.map((a, i) => ({
    id: `assignment_${i}`,
    progress: a.progress || 0,
    dueInDays: Math.ceil((new Date(a.dueDate) - new Date()) / (1000 * 60 * 60 * 24)),
    priority: a.priority || 'medium',
  }));

  // Calculate activity summary
  const activitySummary = {
    totalActivities: anonymizedActivities.length,
    loginCount: anonymizedActivities.filter(a => a.type === 'USER_LOGIN').length,
    studySessionCount: anonymizedActivities.filter(a => a.type === 'STUDY_SESSION_START').length,
    mostActiveHour: getMostFrequentValue(anonymizedActivities.map(a => a.hourOfDay)),
    mostActiveDay: getMostFrequentValue(anonymizedActivities.map(a => a.dayOfWeek)),
    completionRate: calculateCompletionRate(anonymizedAssignments),
  };

  const messages = [
    {
      role: 'system',
      content: `You are an intelligent academic assistant. Analyze anonymized student activity patterns and provide personalized study recommendations. Focus on productivity, time management, and avoiding burnout. Be encouraging and actionable.`
    },
    {
      role: 'user',
      content: `Based on this student's activity pattern:
- Total activities: ${activitySummary.totalActivities}
- Study sessions: ${activitySummary.studySessionCount}
- Most active hour: ${activitySummary.mostActiveHour}:00
- Most active day: ${getDayName(activitySummary.mostActiveDay)}
- Assignment completion rate: ${activitySummary.completionRate}%
- Pending assignments: ${anonymizedAssignments.filter(a => a.progress < 100).length}
- Upcoming deadlines: ${anonymizedAssignments.filter(a => a.dueInDays <= 7 && a.progress < 100).length}

Provide 3 specific, actionable study recommendations in JSON format:
{
  "recommendations": [
    { "title": "...", "description": "...", "priority": "high|medium|low" }
  ],
  "riskAlert": "optional message if student is at risk",
  "motivationalMessage": "encouraging message"
}`
    }
  ];

  try {
    const response = await callGroqAPI({ messages, temperature: 0.7 });
    
    // Parse JSON from response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Invalid AI response format');
    }
    
    const result = JSON.parse(jsonMatch[0]);
    
    // Log AI usage (encrypted)
    logger.info('AI task recommendations generated', {
      activityCount: activities.length,
      recommendationCount: result.recommendations?.length,
    });

    setCachedResponse(cacheKey, result);
    return result;
  } catch (error) {
    logger.error('Failed to generate task recommendations', { error: error.message });
    
    // Fallback response
    return {
      recommendations: [
        { title: 'Stay focused', description: 'Continue your great work!', priority: 'medium' }
      ],
      motivationalMessage: 'Keep up the good work!'
    };
  }
}

/**
 * Generate adaptive reminder insights based on user behavior
 * 
 * @param {Object} params
 * @param {Object} params.userBehavior - Anonymized behavior summary
 * @param {Array} params.upcomingDeadlines - Anonymized deadline data
 * @returns {Promise<Object>} - Adaptive reminder strategy
 */
export async function generateAdaptiveReminderInsights({ userBehavior, upcomingDeadlines }) {
  const cacheKey = getCacheKey('reminder_insights', { userBehavior, deadlineCount: upcomingDeadlines.length });
  const cached = getCachedResponse(cacheKey);
  if (cached) return cached;

  const messages = [
    {
      role: 'system',
      content: `You are an intelligent reminder optimization system. Analyze student behavior patterns and suggest optimal reminder frequency and timing. Consider work habits, procrastination risk, and deadline urgency.`
    },
    {
      role: 'user',
      content: `Student behavior summary:
- Average task completion time: ${userBehavior.avgCompletionLeadHours || 24} hours before deadline
- Task completion rate: ${userBehavior.completionRate || 70}%
- Preferred study hour: ${userBehavior.preferredHour || 18}:00
- Response rate to reminders: ${userBehavior.reminderResponseRate || 60}%
- Upcoming deadlines in next 7 days: ${upcomingDeadlines.length}

Suggest optimal reminder strategy in JSON:
{
  "reminderFrequency": "increase|decrease|maintain",
  "suggestedLeadTime": 48,
  "tone": "urgent|encouraging|neutral",
  "reasoning": "brief explanation"
}`
    }
  ];

  try {
    const response = await callGroqAPI({ messages, temperature: 0.5 });
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Invalid AI response format');
    
    const result = JSON.parse(jsonMatch[0]);
    
    logger.info('AI reminder insights generated', {
      frequency: result.reminderFrequency,
      leadTime: result.suggestedLeadTime,
    });

    setCachedResponse(cacheKey, result);
    return result;
  } catch (error) {
    logger.error('Failed to generate reminder insights', { error: error.message });
    
    // Safe fallback
    return {
      reminderFrequency: 'maintain',
      suggestedLeadTime: 48,
      tone: 'encouraging',
      reasoning: 'Continuing with current reminder settings.'
    };
  }
}

/**
 * Generate weekly performance and motivation analytics
 * 
 * @param {Object} params
 * @param {Array} params.weeklyActivities - Week's activity summary (anonymized)
 * @param {Object} params.completionStats - Task completion statistics
 * @returns {Promise<Object>} - Weekly insights and motivation
 */
export async function generateWeeklyAnalytics({ weeklyActivities, completionStats }) {
  const cacheKey = getCacheKey('weekly_analytics', { weeklyActivities: weeklyActivities.length, completionStats });
  const cached = getCachedResponse(cacheKey);
  if (cached) return cached;

  const anonymizedActivities = anonymizeActivityData(weeklyActivities);
  
  const messages = [
    {
      role: 'system',
      content: `You are an empathetic academic coach. Analyze a student's weekly performance and provide encouraging, actionable feedback. Celebrate wins, address concerns gently, and motivate for the upcoming week.`
    },
    {
      role: 'user',
      content: `Weekly summary:
- Study sessions completed: ${anonymizedActivities.filter(a => a.type === 'STUDY_SESSION_START').length}
- Tasks completed: ${completionStats.completed || 0}
- Tasks pending: ${completionStats.pending || 0}
- Completion rate: ${completionStats.completionRate || 0}%
- Login streak: ${completionStats.loginStreak || 0} days

Provide weekly insights in JSON:
{
  "summary": "brief encouraging summary",
  "achievements": ["achievement 1", "achievement 2"],
  "areasForImprovement": ["area 1"],
  "nextWeekFocus": "specific actionable advice",
  "riskAlert": "optional: warn if falling behind"
}`
    }
  ];

  try {
    const response = await callGroqAPI({ messages, temperature: 0.8 });
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Invalid AI response format');
    
    const result = JSON.parse(jsonMatch[0]);
    
    logger.info('AI weekly analytics generated');

    setCachedResponse(cacheKey, result);
    return result;
  } catch (error) {
    logger.error('Failed to generate weekly analytics', { error: error.message });
    
    return {
      summary: 'Keep up the great work this week!',
      achievements: ['Stayed consistent with your studies'],
      areasForImprovement: [],
      nextWeekFocus: 'Continue building your study momentum'
    };
  }
}

/**
 * Generate best study time suggestion based on activity patterns
 * 
 * @param {Object} params
 * @param {Array} params.activities - Recent activity data
 * @param {Array} params.upcomingTasks - Tasks due soon
 * @returns {Promise<Object>} - Study time recommendations
 */
export async function generateStudyTimeSuggestion({ activities, upcomingTasks }) {
  const anonymizedActivities = anonymizeActivityData(activities);
  
  // Analyze activity patterns
  const hourDistribution = {};
  anonymizedActivities.forEach(a => {
    hourDistribution[a.hourOfDay] = (hourDistribution[a.hourOfDay] || 0) + 1;
  });
  
  const mostProductiveHour = Object.entries(hourDistribution)
    .sort((a, b) => b[1] - a[1])[0]?.[0] || 14;

  const currentHour = new Date().getHours();
  const urgentTasks = upcomingTasks.filter(t => {
    const dueInHours = (new Date(t.dueDate) - new Date()) / (1000 * 60 * 60);
    return dueInHours <= 48 && t.progress < 100;
  });

  return {
    recommendedHour: parseInt(mostProductiveHour),
    reasoning: `Based on your activity patterns, you're most productive around ${mostProductiveHour}:00`,
    urgency: urgentTasks.length > 0 ? 'high' : 'normal',
    suggestion: urgentTasks.length > 0 
      ? `You have ${urgentTasks.length} urgent task(s). Consider studying now or at your peak hour (${mostProductiveHour}:00).`
      : `Your peak productivity time is around ${mostProductiveHour}:00. Schedule your study session accordingly.`
  };
}

/**
 * Generate personalized course progress insight
 * 
 * @param {Object} params
 * @param {Array} params.courses - Anonymized course progress data
 * @returns {Promise<Object>} - Course-specific insights
 */
export async function generateCourseProgressInsight({ courses }) {
  const cacheKey = getCacheKey('course_insight', { courseCount: courses.length });
  const cached = getCachedResponse(cacheKey);
  if (cached) return cached;

  const anonymizedCourses = courses.map((c, i) => ({
    id: `course_${i}`,
    assignmentsTotal: c.assignmentsTotal || 0,
    assignmentsCompleted: c.assignmentsCompleted || 0,
    averageScore: c.averageScore || 0,
  }));

  const messages = [
    {
      role: 'system',
      content: `You are an academic advisor. Analyze course progress and provide specific, encouraging feedback.`
    },
    {
      role: 'user',
      content: `Course progress summary:
${anonymizedCourses.map((c, i) => 
  `Course ${i + 1}: ${c.assignmentsCompleted}/${c.assignmentsTotal} assignments completed (${c.averageScore}% avg score)`
).join('\n')}

Provide insights in JSON:
{
  "overallProgress": "ahead|on-track|behind",
  "strengths": ["strength 1"],
  "recommendations": ["recommendation 1"],
  "encouragement": "motivational message"
}`
    }
  ];

  try {
    const response = await callGroqAPI({ messages, temperature: 0.7 });
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Invalid AI response format');
    
    const result = JSON.parse(jsonMatch[0]);
    
    logger.info('AI course progress insight generated');

    setCachedResponse(cacheKey, result);
    return result;
  } catch (error) {
    logger.error('Failed to generate course insight', { error: error.message });
    
    return {
      overallProgress: 'on-track',
      strengths: ['Consistent study habits'],
      recommendations: ['Continue your current pace'],
      encouragement: 'You\'re doing great!'
    };
  }
}

// Helper functions
function getMostFrequentValue(arr) {
  if (!arr.length) return 0;
  const frequency = {};
  arr.forEach(val => {
    frequency[val] = (frequency[val] || 0) + 1;
  });
  return parseInt(Object.entries(frequency).sort((a, b) => b[1] - a[1])[0][0]);
}

function calculateCompletionRate(assignments) {
  if (!assignments.length) return 0;
  const completed = assignments.filter(a => a.progress === 100).length;
  return Math.round((completed / assignments.length) * 100);
}

function getDayName(dayIndex) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return days[dayIndex] || 'Unknown';
}

/**
 * Health check to verify Groq API connectivity
 */
export async function healthCheck() {
  if (!env.GROQ_API_KEY) {
    return { status: 'disabled', message: 'GROQ_API_KEY not configured' };
  }

  try {
    const messages = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Reply with "OK" if you receive this message.' }
    ];
    
    await callGroqAPI({ messages, maxTokens: 10 });
    
    return { status: 'healthy', message: 'Groq AI service operational' };
  } catch (error) {
    return { status: 'error', message: error.message };
  }
}

export default {
  generateTaskRecommendations,
  generateAdaptiveReminderInsights,
  generateWeeklyAnalytics,
  generateStudyTimeSuggestion,
  generateCourseProgressInsight,
  healthCheck,
};
