import { addDays, differenceInDays, parseISO, format } from 'date-fns';
import axios from 'axios';
import { env } from '../config/environment.js';

/**
 * Analyzes student's learning patterns and preferences
 */
async function analyzeLearningPatterns(activities) {
  const studyPatterns = activities.reduce((patterns, activity) => {
    if (activity.type === 'study_session') {
      // Analyze time of day preferences
      const hour = new Date(activity.timestamp).getHours();
      patterns.preferredTimes[hour] = (patterns.preferredTimes[hour] || 0) + 1;
      
      // Analyze session duration preferences
      patterns.averageSessionLength = 
        (patterns.averageSessionLength * patterns.totalSessions + activity.duration) / 
        (patterns.totalSessions + 1);
      patterns.totalSessions++;
      
      // Track productivity by time slots
      patterns.productivityByTime[hour] = 
        (patterns.productivityByTime[hour] || { total: 0, count: 0 });
      patterns.productivityByTime[hour].total += activity.duration;
      patterns.productivityByTime[hour].count++;
    }
    return patterns;
  }, {
    preferredTimes: {},
    averageSessionLength: 0,
    totalSessions: 0,
    productivityByTime: {}
  });

  return studyPatterns;
}

/**
 * Estimates assignment complexity using Groq AI
 */
async function estimateAssignmentComplexity(assignment) {
  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        messages: [{
          role: 'system',
          content: 'You are an academic difficulty assessment expert. Analyze the assignment details and estimate its complexity.'
        }, {
          role: 'user',
          content: `Analyze this assignment and rate its complexity (1-10):
            Title: ${assignment.title}
            Description: ${assignment.description || 'N/A'}
            Course: ${assignment.course?.name || 'N/A'}
            Due Date: ${assignment.dueDate}
            Progress: ${assignment.progress}%`
        }],
        temperature: 0.7
      },
      {
        headers: {
          'Authorization': `Bearer ${env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const complexityText = response.data.choices[0].message.content;
    const complexityScore = parseInt(complexityText.match(/\d+/)[0]) || 5;
    return complexityScore;
  } catch (error) {
    console.error('Error estimating assignment complexity:', error);
    return 5; // Default medium complexity
  }
}

/**
 * Generates an AI-powered personalized study plan based on courses, assignments, and study history
 */
export async function generateStudyPlan(courses, assignments, activities, userPreferences = {}) {
  const plan = [];
  const now = new Date();
  const upcomingAssignments = assignments
    .filter(a => a.dueDate && new Date(a.dueDate) > now)
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

  // Analyze learning patterns
  const learningPatterns = await analyzeLearningPatterns(activities);

  // Get optimal study times based on productivity patterns
  const optimalStudyHours = Object.entries(learningPatterns.productivityByTime)
    .sort((a, b) => (b[1].total / b[1].count) - (a[1].total / a[1].count))
    .slice(0, 3)
    .map(([hour]) => parseInt(hour));

  // Get courses that need attention using AI analysis
  try {
    const coursesAnalysis = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        messages: [{
          role: 'system',
          content: 'You are an academic advisor specializing in study pattern analysis.'
        }, {
          role: 'user',
          content: `Analyze these courses and recent activities to identify which courses need immediate attention. Consider:
            Courses: ${JSON.stringify(courses)}
            Recent Activities: ${JSON.stringify(activities.slice(-10))}
            Learning Patterns: ${JSON.stringify(learningPatterns)}`
        }],
        temperature: 0.7
      },
      {
        headers: {
          'Authorization': `Bearer ${env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const coursesNeedingAttention = courses.filter(course => 
      coursesAnalysis.data.choices[0].message.content.toLowerCase().includes(course.name.toLowerCase())
    );

    // Process upcoming assignments with AI-estimated complexity
    for (const assignment of upcomingAssignments) {
      const daysUntilDue = differenceInDays(new Date(assignment.dueDate), now);
      if (daysUntilDue <= 14) { // Extended window for complex assignments
        const complexity = await estimateAssignmentComplexity(assignment);
        
        // Calculate suggested time based on complexity and days until due
        const baseTime = Math.min(180, daysUntilDue * 30);
        const suggestedTime = Math.round(baseTime * (complexity / 5));
        
        // Generate optimal study slots
        const studySlots = optimalStudyHours.map(hour => format(addDays(now, 1), 'yyyy-MM-dd') + ` ${hour}:00`);
        
        plan.push({
          priority: complexity >= 8 || daysUntilDue <= 2 ? 'high' : daysUntilDue <= 5 ? 'medium' : 'low',
          type: 'assignment',
          message: `Focus on ${assignment.title} - ${complexity >= 8 ? 'Complex assignment' : ''} due in ${daysUntilDue} days`,
          suggestedTime,
          recommendedSlots: studySlots,
          complexity,
          course: assignment.course,
          strategies: await generateStudyStrategies(assignment, complexity)
        });
      }
    }

    // Add AI-powered recommendations for courses needing attention
    for (const course of coursesNeedingAttention) {
      const courseActivities = activities.filter(a => a.course?.toString() === course._id.toString());
      const recentPerformance = analyzeRecentPerformance(courseActivities);
      
      plan.push({
        priority: 'medium',
        type: 'course',
        message: await generateCourseRecommendation(course, recentPerformance),
        suggestedTime: calculateOptimalStudyDuration(courseActivities, learningPatterns),
        recommendedSlots: optimalStudyHours.map(hour => format(now, 'yyyy-MM-dd') + ` ${hour}:00`),
        course: course._id,
        strategies: await generateStudyStrategies(course, recentPerformance)
      });
    }

    // Add AI-powered consistency recommendations
    for (const course of courses) {
      const courseActivities = activities.filter(a => a.course?.toString() === course._id.toString());
      
      if (courseActivities.length > 0) {
        const consistencyScore = calculateConsistencyScore(courseActivities);
        const totalTime = courseActivities.reduce((sum, a) => sum + (a.duration || 0), 0);
        const avgTimePerSession = totalTime / courseActivities.length;

        // Only suggest consistency improvements if needed
        if (consistencyScore < 0.7) {
          plan.push({
            priority: 'low',
            type: 'consistency',
            message: await generateConsistencyRecommendation(course, consistencyScore, learningPatterns),
            suggestedTime: Math.round(avgTimePerSession || 45),
            recommendedSlots: optimalStudyHours.map(hour => format(addDays(now, 1), 'yyyy-MM-dd') + ` ${hour}:00`),
            course: course._id,
            consistencyScore
          });
        }
      }
    }

  } catch (error) {
    console.error('Error generating AI-powered study plan:', error);
    // Fallback to basic study plan if AI fails
    return generateBasicStudyPlan(courses, assignments, activities);
  }

  // Sort plan by priority and complexity
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  plan.sort((a, b) => {
    const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (priorityDiff !== 0) return priorityDiff;
    return (b.complexity || 5) - (a.complexity || 5);
  });

  return plan;
}

/**
 * Generates personalized study strategies based on assignment/course characteristics
 */
async function generateStudyStrategies(item, complexity) {
  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        messages: [{
          role: 'system',
          content: 'You are an expert in learning strategies and study techniques.'
        }, {
          role: 'user',
          content: `Suggest 3 specific study strategies for this ${item.title ? 'assignment' : 'course'}:
            ${item.title ? `Assignment: ${item.title}` : `Course: ${item.name}`}
            Complexity/Difficulty: ${complexity}/10
            Description: ${item.description || 'N/A'}`
        }],
        temperature: 0.7
      },
      {
        headers: {
          'Authorization': `Bearer ${env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data.choices[0].message.content
      .split('\n')
      .filter(line => line.trim())
      .map(strategy => strategy.replace(/^\d+\.\s*/, ''));
  } catch (error) {
    console.error('Error generating study strategies:', error);
    return ['Break the material into smaller chunks', 'Use active recall techniques', 'Teach concepts to others'];
  }
}

/**
 * Analyzes recent performance based on study sessions and assignments
 */
function analyzeRecentPerformance(activities) {
  const recentActivities = activities
    .filter(a => differenceInDays(new Date(), new Date(a.timestamp)) <= 30);
  
  if (recentActivities.length === 0) return 5;

  const metrics = {
    studyConsistency: calculateConsistencyScore(recentActivities),
    averageDuration: recentActivities.reduce((sum, a) => sum + (a.duration || 0), 0) / recentActivities.length,
    totalSessions: recentActivities.length
  };

  return Math.round((metrics.studyConsistency * 10 + metrics.totalSessions/10) / 2);
}

/**
 * Calculates study consistency score (0-1)
 */
function calculateConsistencyScore(activities) {
  if (activities.length < 2) return 0;
  
  const intervals = [];
  for (let i = 1; i < activities.length; i++) {
    intervals.push(
      differenceInDays(
        new Date(activities[i].timestamp),
        new Date(activities[i-1].timestamp)
      )
    );
  }

  const avgInterval = intervals.reduce((sum, interval) => sum + interval, 0) / intervals.length;
  const variance = intervals.reduce((sum, interval) => sum + Math.pow(interval - avgInterval, 2), 0) / intervals.length;
  
  return 1 / (1 + Math.sqrt(variance));
}

/**
 * Calculates optimal study duration based on historical data
 */
function calculateOptimalStudyDuration(activities, learningPatterns) {
  if (activities.length === 0) return 45; // Default duration
  
  const recentDurations = activities
    .filter(a => a.duration && a.duration > 0)
    .map(a => a.duration)
    .slice(-5);

  if (recentDurations.length === 0) return learningPatterns.averageSessionLength || 45;

  const avgRecentDuration = recentDurations.reduce((sum, d) => sum + d, 0) / recentDurations.length;
  return Math.round(avgRecentDuration);
}

/**
 * Generates a basic study plan without AI assistance (fallback)
 * This version uses simple heuristics and time management principles
 */
function generateBasicStudyPlan(courses, assignments, activities) {
  const plan = [];
  const now = new Date();
  
  // Process upcoming assignments
  const upcomingAssignments = assignments
    .filter(a => a.dueDate && new Date(a.dueDate) > now)
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

  // Basic time allocation heuristics
  for (const assignment of upcomingAssignments) {
    const daysUntilDue = differenceInDays(new Date(assignment.dueDate), now);
    if (daysUntilDue <= 14) {
      // Basic complexity estimation based on description length and progress
      const complexity = assignment.description ? 
        Math.min(8, Math.ceil(assignment.description.length / 200)) : 
        Math.max(3, Math.ceil((100 - assignment.progress) / 20));
      
      // Suggested study time based on days until due and estimated complexity
      const suggestedTime = Math.min(180, daysUntilDue * 20 * (complexity / 5));
      
      // Generate study slots at common productive hours
      const commonStudyHours = [9, 14, 19]; // Morning, afternoon, evening
      const studySlots = commonStudyHours.map(hour => 
        format(addDays(now, 1), 'yyyy-MM-dd') + ` ${hour}:00`
      );

      plan.push({
        priority: daysUntilDue <= 2 ? 'high' : daysUntilDue <= 5 ? 'medium' : 'low',
        type: 'assignment',
        message: `Work on ${assignment.title} - due in ${daysUntilDue} days`,
        suggestedTime: Math.round(suggestedTime),
        recommendedSlots: studySlots,
        complexity,
        course: assignment.course,
        strategies: [
          'Break down the assignment into smaller tasks',
          'Review related course materials',
          'Set specific goals for each study session'
        ]
      });
    }
  }

  // Basic course recommendations based on recent activity
  for (const course of courses) {
    const courseActivities = activities.filter(a => 
      a.course?.toString() === course._id.toString()
    );
    
    const lastActivity = courseActivities
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
    
    const daysSinceLastActivity = lastActivity ? 
      differenceInDays(now, new Date(lastActivity.timestamp)) : 14;

    if (daysSinceLastActivity >= 7) {
      plan.push({
        priority: daysSinceLastActivity >= 14 ? 'high' : 'medium',
        type: 'course',
        message: `Review ${course.name} - ${daysSinceLastActivity} days since last study session`,
        suggestedTime: 60, // Default 1-hour review session
        recommendedSlots: [9, 14, 19].map(hour => 
          format(now, 'yyyy-MM-dd') + ` ${hour}:00`
        ),
        course: course._id,
        strategies: [
          'Review recent course materials',
          'Practice problems or exercises',
          'Create summary notes of key concepts'
        ]
      });
    }
  }

  // Sort plan by priority
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  plan.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  return plan;
}