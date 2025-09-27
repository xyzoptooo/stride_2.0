
import express from 'express';
import dotenv from 'dotenv';
// import cors from 'cors';
import mongoose from 'mongoose';
import multer from 'multer';
import { parseSyllabus } from './syllabusParser.js';
import { AcademicDocumentParser } from './academicParser.js';
import axios from 'axios';
// Removed base-64; use Buffer for base64 encoding
import fetch from 'node-fetch';

// --- Hybrid Recommendation Engine ---

// --- Production Recommendation Algorithm ---
class RecommendationEngine {
  constructor() {
    this.userSimilarityCache = new Map();
    this.cacheTimeout = 30 * 60 * 1000; // 30 minutes
  }

  // Calculate user similarity based on course enrollment and activity patterns
  calculateUserSimilarity(currentUserActivities, allUsersActivities) {
    const cacheKey = JSON.stringify(currentUserActivities);
    if (this.userSimilarityCache.has(cacheKey)) {
      const cached = this.userSimilarityCache.get(cacheKey);
      if (Date.now() - cached.timestamp < this.cacheTimeout) {
        return cached.similarities;
      }
    }

    const similarities = [];
    const currentUserVector = this.buildUserVector(currentUserActivities);

    allUsersActivities.forEach(otherUser => {
      if (otherUser.supabaseId === currentUserActivities.supabaseId) return;

      const otherUserVector = this.buildUserVector(otherUser);
      const similarity = this.cosineSimilarity(currentUserVector, otherUserVector);
      
      if (similarity > 0.3) { // Only include meaningful similarities
        similarities.push({
          userId: otherUser.supabaseId,
          similarity: similarity,
          activities: otherUser.activities
        });
      }
    });

    // Sort by similarity (highest first)
    similarities.sort((a, b) => b.similarity - a.similarity);
    
    this.userSimilarityCache.set(cacheKey, {
      similarities: similarities.slice(0, 10), // Top 10 similar users
      timestamp: Date.now()
    });

    return similarities.slice(0, 10);
  }

  buildUserVector(userData) {
    // Create feature vector: [study_hours, assignment_completion, course_count, recent_activity]
    const totalStudyHours = userData.activities
      .filter(a => a.type === 'study')
      .reduce((sum, a) => sum + (a.duration || 1), 0);

    const completedAssignments = userData.assignments
      .filter(a => a.status === 'completed').length;

    const activeCourses = userData.courses.length;
    
    const recentActivity = userData.activities
      .filter(a => new Date(a.date) > new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)).length;

    return [totalStudyHours, completedAssignments, activeCourses, recentActivity];
  }

  cosineSimilarity(vecA, vecB) {
    if (vecA.length !== vecB.length) return 0;
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  // Collaborative filtering: find what similar users are doing
  async collaborativeRecommendations(currentUserId, similarUsers, currentUserCourses) {
    const recommendations = new Set();
    const currentCourseNames = new Set(currentUserCourses.map(c => c.name));

    similarUsers.forEach(similarUser => {
      // Find study patterns from similar users
      similarUser.activities.forEach(activity => {
        if (activity.type === 'study' && 
            !currentCourseNames.has(activity.courseName) &&
            activity.duration > 30) { // Meaningful study sessions
          recommendations.add(`Similar students study ${activity.courseName} for ${activity.duration} minutes`);
        }
      });

      // Find assignment patterns
      if (similarUser.assignments) {
        similarUser.assignments.forEach(assignment => {
          if (assignment.status === 'completed' && 
              !currentCourseNames.has(assignment.courseName)) {
            recommendations.add(`Try assignment: ${assignment.title} from ${assignment.courseName}`);
          }
        });
      }
    });

    return Array.from(recommendations).slice(0, 5);
  }

  // Content-based filtering: based on user's own patterns
  contentBasedRecommendations(userData) {
    const recommendations = [];
    const now = new Date();

    // 1. Time-based recommendations
    const recentActivities = userData.activities
      .filter(a => new Date(a.date) > new Date(now - 2 * 24 * 60 * 60 * 1000))
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    // 2. Study pattern analysis
    const studyByHour = {};
    userData.activities.forEach(activity => {
      if (activity.type === 'study') {
        const hour = new Date(activity.date).getHours();
        studyByHour[hour] = (studyByHour[hour] || 0) + 1;
      }
    });

    // Find optimal study time
    const bestHour = Object.keys(studyByHour)
      .reduce((a, b) => studyByHour[a] > studyByHour[b] ? a : b, '14'); // Default to 2 PM

    recommendations.push(`Your most productive time is ${bestHour}:00 - consider scheduling study sessions then`);

    // 3. Assignment prioritization
    const upcomingAssignments = userData.assignments
      .filter(a => a.status === 'pending' && new Date(a.dueDate) > now)
      .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

    if (upcomingAssignments.length > 0) {
      const urgentAssignment = upcomingAssignments[0];
      const daysUntilDue = Math.ceil((new Date(urgentAssignment.dueDate) - now) / (1000 * 60 * 60 * 24));
      
      recommendations.push(`Priority: ${urgentAssignment.title} due in ${daysUntilDue} days`);
    }

    // 4. Course balance analysis
    const courseStudyTime = {};
    userData.activities.forEach(activity => {
      if (activity.type === 'study' && activity.courseName) {
        courseStudyTime[activity.courseName] = (courseStudyTime[activity.courseName] || 0) + (activity.duration || 1);
      }
    });

    // Find least studied course
    const courses = Object.keys(courseStudyTime);
    if (courses.length > 1) {
      const leastStudied = courses.reduce((a, b) => 
        courseStudyTime[a] < courseStudyTime[b] ? a : b
      );
      recommendations.push(`Consider spending more time on ${leastStudied}`);
    }

    return recommendations.slice(0, 5);
  }

  // Main recommendation generator
  async generateRecommendations(supabaseId) {
    try {
      // Get all user data in parallel
      const [currentUser, allUsers, courses, assignments, activities] = await Promise.all([
        User.findOne({ supabaseId }),
        User.find({}),
        Course.find({ supabaseId }),
        Assignment.find({ supabaseId }),
        Activity.find({ supabaseId })
      ]);

      if (!currentUser) throw new Error('User not found');

      const currentUserData = {
        supabaseId,
        courses,
        assignments,
        activities,
        user: currentUser
      };

      // Get all users' data for collaborative filtering
      const allUsersData = await Promise.all(
        allUsers.map(async user => ({
          supabaseId: user.supabaseId,
          courses: await Course.find({ supabaseId: user.supabaseId }),
          assignments: await Assignment.find({ supabaseId: user.supabaseId }),
          activities: await Activity.find({ supabaseId: user.supabaseId })
        }))
      );

      // 1. Content-based recommendations (always works)
      const contentRecs = this.contentBasedRecommendations(currentUserData);

      // 2. Collaborative filtering recommendations
      let collaborativeRecs = [];
      try {
        const similarUsers = this.calculateUserSimilarity(currentUserData, allUsersData);
        collaborativeRecs = await this.collaborativeRecommendations(supabaseId, similarUsers, courses);
      } catch (error) {
        console.log('Collaborative filtering failed, using content-based only:', error.message);
      }

      // Combine and deduplicate recommendations
      const allRecs = [...new Set([...contentRecs, ...collaborativeRecs])];
      
      return {
        recommendations: allRecs.slice(0, 5),
        type: collaborativeRecs.length > 0 ? 'hybrid' : 'content-based',
        generatedAt: new Date().toISOString()
      };

    } catch (error) {
      console.error('Recommendation engine error:', error);
      // Fallback to simple rule-based recommendations
      return this.getFallbackRecommendations(supabaseId);
    }
  }

  // Simple fallback when everything else fails
  async getFallbackRecommendations(supabaseId) {
    const courses = await Course.find({ supabaseId });
    const assignments = await Assignment.find({ supabaseId });
    
    const recommendations = [];
    
    if (courses.length > 0) {
      recommendations.push(`Review your notes for ${courses[0].name}`);
      recommendations.push('Plan your study sessions for the week ahead');
    }
    
    if (assignments.length > 0) {
      const pending = assignments.filter(a => a.status === 'pending');
      if (pending.length > 0) {
        recommendations.push(`Work on: ${pending[0].title}`);
      }
    }
    
    recommendations.push('Take regular breaks during study sessions');
    recommendations.push('Stay hydrated and maintain a consistent sleep schedule');

    return {
      recommendations: recommendations.slice(0, 5),
      type: 'fallback',
      generatedAt: new Date().toISOString()
    };
  }
}

// Initialize the engine
const recommendationEngine = new RecommendationEngine();

dotenv.config();
const app = express();

// --- CORS: Allow requests from frontend origins (including file upload preflight) ---
const allowedOrigins = [
  "http://localhost:8080",
  "http://localhost:5173",
  "https://stride-2-0.onrender.com",
  "https://www.semesterstride.app",
  // Add your production frontend URL if different
];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization,apikey');
  }
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});
app.use(express.json());

// --- MongoDB connection ---
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/semesterstride';
mongoose.connect(MONGODB_URI, { useNewUrlParser: true })
  .then(() => console.log('MongoDB connected'))
  .catch((err) => console.error('MongoDB connection error:', err));

// --- Import models ---
import User from './models/user.js';
import Assignment from './models/assignment.js';
import Course from './models/course.js';
import Activity from './models/activity.js';

// --- AI Mindmap endpoint ---
// --- Home route ---
app.get('/', (req, res) => {
  res.send('Backend API is running');
});
app.post('/api/mindmap', async (req, res) => {
  try {
    const { supabaseId } = req.body;
    if (!supabaseId) return res.status(400).json({ error: 'Missing supabaseId' });
    const courses = await Course.find({ supabaseId });
    const courseNames = courses.map(c => c.name).join(', ');
    const messages = [
      { role: 'system', content: 'You are an expert at creating academic mindmaps.' },
      { role: 'user', content: `Given these courses: ${courseNames}, generate a mindmap as a flat list of 5-10 key topics or concepts the student should focus on. Only return the list, no explanations.` }
    ];
    let topics = [];
    try {
      const response = await fetch(process.env.GROQ_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages })
      });
      const aiResult = await response.json();
      let content = aiResult.choices?.[0]?.message?.content || aiResult.plan || aiResult.response || '';
      topics = content.split(/\n|\r/)
        .map(line => line.replace(/^\s*(\d+\.|\*|\u2022)\s*/, ''))
        .map(line => line.replace(/^[\u2022\*]+/g, ''))
        .map(line => line.trim())
        .filter(Boolean);
    } catch (err) {
      console.log('Groq AI mindmap error:', err);
    }
    if (!topics.length && courses.length > 0) {
      topics = courses.map(c => c.name);
    }
    res.json({ topics });
  } catch (err) {
    console.log('MINDMAP AI ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

const upload = multer();
// --- Syllabus import endpoint (file upload) ---
// Syllabus import endpoint now supports OCR for images and scanned PDFs
app.post('/api/syllabus/import', upload.single('file'), async (req, res) => {
  console.log('--- /api/syllabus/import called ---');
  if (req.file) {
    console.log('File received:', req.file.originalname, req.file.mimetype, req.file.size);
  } else {
    console.log('No file received');
  }
  try {
    if (!req.file) {
      console.error('No file uploaded');
      return res.status(400).json({ error: 'No file uploaded' });
    }
    // Encode file as base64
    const fileBase64 = Buffer.from(req.file.buffer).toString('base64');
    // Prepare GPT-5 vision/multimodal prompt
  const prompt = `You are an expert academic assistant. Your task is to extract structured data from the attached academic document (syllabus, timetable, or assignment list).\n\nReturn a valid JSON object with these keys:\n- courses: array of objects, each with { name, code (if available), professor (if available), credits (if available), schedule (if available) }\n- assignments: array of objects, each with { title, dueDate, course (if available), type (e.g. exam, quiz, project) }\n- deadlines: array of objects, each with { title, dueDate, relatedCourse (if available) }\n\nInstructions:\n- Parse all relevant information, even if the document is noisy, scanned, or contains tables/images.\n- If information is missing, leave fields blank but include the object.\n- Use best effort to infer dates, codes, and relationships.\n- Do not include any explanation, extra text, or formatting—only the JSON object.\n- The output must be valid JSON, suitable for direct parsing in code.`;
    const openaiPayload = {
      model: 'gpt-5-vision',
      messages: [
        { role: 'system', content: 'You are an expert academic assistant.' },
        { role: 'user', content: prompt }
      ],
      files: [
        {
          name: req.file.originalname,
          mime_type: req.file.mimetype,
          data: fileBase64
        }
      ],
      max_tokens: 1000
    };
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(openaiPayload)
    });
    const aiResult = await response.json();
    const aiContent = aiResult.choices?.[0]?.message?.content || null;
    let extracted;
    try {
      extracted = JSON.parse(aiContent);
    } catch (e) {
      extracted = { raw: aiContent };
    }
    return res.json({
      source: 'gpt-5-vision',
      extracted
    });
  } catch (err) {
    console.error('Unexpected error in /api/syllabus/import:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- AI Planner endpoint ---
app.get('/api/plan', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    const user = await User.findOne({ supabaseId: userId });
    const courses = await Course.find({ supabaseId: userId });
    const assignments = await Assignment.find({ supabaseId: userId });
    const activities = await Activity.find({ supabaseId: userId });
    const messages = [
      { role: 'system', content: 'You are an expert academic planner.' },
      { role: 'user', content: `Given the following user data, generate a personalized, actionable daily study/work plan.\n\nUser: ${JSON.stringify(user)}\n\nCourses: ${JSON.stringify(courses)}\n\nAssignments: ${JSON.stringify(assignments)}\n\nRecent Activities: ${JSON.stringify(activities)}\n\nThe plan should be clear, motivating, and broken into steps. Include time blocks, priorities, and tips. Format as a numbered list.` }
    ];
    let plan = null;
    try {
      const response = await fetch(process.env.GROQ_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages })
      });
      const aiResult = await response.json();
      plan = aiResult.choices?.[0]?.message?.content || aiResult.plan || aiResult.response || null;
    } catch (err) {
      console.log('Groq AI planner error:', err);
    }
    if (!plan) {
      if (courses && courses.length > 0) {
        plan = `Today's plan:\n- Review notes for: ${courses.map(c => c.name).join(", ")}\n- Check assignments and upcoming deadlines\n- Log your study sessions\n- Take regular breaks and stay hydrated!`;
      } else {
        plan = 'Add courses to get a personalized daily plan!';
      }
    }
    res.json({ plan });
  } catch (err) {
    console.log('PLANNER AI ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});
// --- Groq AI Recommendations endpoint ---

// --- Home route ---
// --- Production Ready Recommendations endpoint ---
app.post('/api/recommendations', async (req, res) => {
  try {
    const { supabaseId } = req.body;
    if (!supabaseId) {
      return res.status(400).json({ error: 'Missing supabaseId' });
    }

    let recommendations;
    
    // Try AI first, then fallback to algorithmic approach
    try {
      // Your existing AI code first
      const user = await User.findOne({ supabaseId });
      const activities = await Activity.find({ supabaseId });
      const courses = await Course.find({ supabaseId });

      const recMessages = [
        { role: 'system', content: 'You are an expert academic assistant. Generate 3-5 personalized study recommendations based on the user data. Be specific and actionable.' },
        { role: 'user', content: `User courses: ${courses.map(c => c.name).join(', ')}. Recent activities: ${activities.slice(0, 10).map(a => `${a.type} for ${a.courseName}`).join(', ')}. Generate 3-5 specific study recommendations.` }
      ];
      
      const response = await fetch(process.env.GROQ_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ 
          model: 'llama-3.3-70b-versatile', 
          messages: recMessages,
          max_tokens: 500
        })
      });
      
      const aiResult = await response.json();
      
      if (aiResult.choices?.[0]?.message?.content) {
        const aiContent = aiResult.choices[0].message.content;
        // Parse AI response into recommendations
        const aiRecs = aiContent.split('\n')
          .filter(line => line.trim().length > 10)
          .map(line => line.replace(/^\d+\.\s*/, '').trim())
          .slice(0, 5);
        
        if (aiRecs.length > 0) {
          recommendations = {
            recommendations: aiRecs,
            type: 'ai-powered',
            generatedAt: new Date().toISOString()
          };
        } else {
          throw new Error('AI returned no valid recommendations');
        }
      } else {
        throw new Error('AI response malformed');
      }
    } catch (aiError) {
      console.log('AI recommendation failed, using algorithmic approach:', aiError.message);
      // Fallback to algorithmic recommendations
      recommendations = await recommendationEngine.generateRecommendations(supabaseId);
    }

    res.json(recommendations);

  } catch (error) {
    console.error('Recommendations endpoint error:', error);
    // Final fallback
    const fallback = await recommendationEngine.getFallbackRecommendations(req.body.supabaseId);
    res.json(fallback);
  }
});

// --- Activity routes ---
// --- Notes CRUD endpoints ---
// --- Assignments CRUD endpoints ---
// Create an assignment
app.post('/api/assignments', async (req, res) => {
  try {
    const assignment = new Assignment(req.body);
    await assignment.save();
    res.status(201).json(assignment);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Get all assignments for a user
app.get('/api/assignments/:supabaseId', async (req, res) => {
  try {
    const assignments = await Assignment.find({ supabaseId: req.params.supabaseId });
    res.json(assignments);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update an assignment
app.put('/api/assignments/:id', async (req, res) => {
  try {
    const assignment = await Assignment.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
    res.json(assignment);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete an assignment
app.delete('/api/assignments/:id', async (req, res) => {
  try {
    const result = await Assignment.findByIdAndDelete(req.params.id);
    if (!result) return res.status(404).json({ error: 'Assignment not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
// Create a note
app.post('/api/notes', async (req, res) => {
  try {
    const note = new Note(req.body);
    await note.save();
    res.status(201).json(note);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Get all notes for a user
app.get('/api/notes/:supabaseId', async (req, res) => {
  try {
    const { supabaseId } = req.params;
    if (!supabaseId || typeof supabaseId !== 'string' || supabaseId.length < 8) {
      return res.status(400).json({ error: 'Invalid or missing supabaseId' });
    }
    const notes = await Note.find({ supabaseId });
    res.json(notes);
  } catch (err) {
    console.error('Error fetching notes for user:', req.params.supabaseId, err);
    res.status(400).json({ error: err.message });
  }
});

// Update a note
app.put('/api/notes/:id', async (req, res) => {
  try {
    const note = await Note.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!note) return res.status(404).json({ error: 'Note not found' });
    res.json(note);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete a note
app.delete('/api/notes/:id', async (req, res) => {
  try {
    const result = await Note.findByIdAndDelete(req.params.id);
    if (!result) return res.status(404).json({ error: 'Note not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
// --- Get courses for a user ---
app.get('/api/courses/:supabaseId', async (req, res) => {
  try {
    const courses = await Course.find({ supabaseId: req.params.supabaseId });
    res.json(courses);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
// --- Course creation endpoint ---
app.post('/api/courses', async (req, res) => {
  try {
    const { supabaseId, name } = req.body;
    if (!supabaseId || !name) {
      const missing = [];
      if (!supabaseId) missing.push('supabaseId');
      if (!name) missing.push('name');
      return res.status(400).json({ error: `Missing required field(s): ${missing.join(', ')}` });
    }
    const course = new Course(req.body);
    await course.save();
    res.status(201).json(course);
  } catch (err) {
    // If it's a Mongoose validation error, include details
    if (err.name === 'ValidationError') {
      const errors = Object.values(err.errors).map(e => e.message);
      return res.status(400).json({ error: 'Validation error', details: errors });
    }
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/activities', async (req, res) => {
  try {
    const activity = new Activity(req.body);
    await activity.save();
    res.status(201).json(activity);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/activities/:supabaseId', async (req, res) => {
  try {
    const activities = await Activity.find({ supabaseId: req.params.supabaseId });
    res.json(activities);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Study data endpoint for charts ---
app.get('/api/study-data/:supabaseId', async (req, res) => {
  try {
    const activities = await Activity.find({ supabaseId: req.params.supabaseId });
    res.json(activities);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});


// --- Mpesa Payment Status Store (in-memory, for demo; use DB for production) ---
const paymentStatusStore = {};

// --- Mpesa STK Push Payment Integration ---
async function getMpesaAccessToken() {
  const consumerKey = process.env.MPESA_CONSUMER_KEY;
  const consumerSecret = process.env.MPESA_CONSUMER_SECRET;
  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
  const url = `${process.env.MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`;
  const res = await axios.get(url, {
    headers: { Authorization: `Basic ${auth}` }
  });
  return res.data.access_token;
}

function getTimestamp() {
  const now = new Date();
  const pad = (n) => n.toString().padStart(2, '0');
  return (
    now.getFullYear().toString() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  );
}

app.post('/api/mpesa/stkpush', async (req, res) => {
  try {
    const { phone, amount, accountReference, transactionDesc, plan } = req.body;
    if (!phone || !amount) {
      return res.status(400).json({ error: 'Phone and amount are required.' });
    }
    // Normalize phone number: 07xxxxxxxx or 01xxxxxxxx to 2547xxxxxxxx or 2541xxxxxxxx
    let normalizedPhone = phone.trim();
    if (/^0(7|1)\d{8}$/.test(normalizedPhone)) {
      normalizedPhone = '254' + normalizedPhone.slice(1);
    }
    // Accept already normalized numbers
    if (!/^254(7|1)\d{8}$/.test(normalizedPhone)) {
      return res.status(400).json({ error: 'Invalid phone number format.' });
    }
    const accessToken = await getMpesaAccessToken();
    const timestamp = getTimestamp();
    const businessShortCode = '5468788';
    const partyB = '4953118';
    const passkey = process.env.MPESA_PASSKEY;
  const password = Buffer.from(businessShortCode + passkey + timestamp).toString('base64');
    const stkUrl = `${process.env.MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`;
    const payload = {
      BusinessShortCode: businessShortCode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerBuyGoodsOnline',
      Amount: amount,
      PartyA: normalizedPhone,
      PartyB: partyB,
      PhoneNumber: normalizedPhone,
      CallBackURL: process.env.MPESA_CALLBACK_URL,
      AccountReference: accountReference || 'SemesterStride',
      TransactionDesc: transactionDesc || 'Premium Payment'
    };
    console.log('--- Mpesa STK Push Attempt ---');
    console.log('Phone:', normalizedPhone);
    console.log('Payload:', payload);
    try {
      const stkRes = await axios.post(stkUrl, payload, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      console.log('Mpesa API Response:', stkRes.data);
      paymentStatusStore[`${normalizedPhone}_${plan}`] = { status: 'pending', timestamp: Date.now() };
      res.json({ success: true, data: stkRes.data });
    } catch (err) {
      console.error('Mpesa STK Push error:', err.response?.data || err.message);
      res.status(500).json({ error: 'Mpesa STK Push failed', details: err.response?.data || err.message });
    }
  } catch (err) {
    console.error('Mpesa STK Push error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Mpesa STK Push failed', details: err.response?.data || err.message });
  }
});

// --- Mpesa Payment Callback Handler (for roombaya.com/callback) ---
app.post('/api/mpesa/callback', express.json(), (req, res) => {
  try {
    const { phone, plan, status } = req.body;
    if (phone && plan && status === 'success') {
      paymentStatusStore[`${phone}_${plan}`] = { status: 'confirmed', timestamp: Date.now() };
    }
    res.json({ received: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Payment Status Polling Endpoint ---
app.get('/api/mpesa/status', (req, res) => {
  const { phone, plan } = req.query;
  if (!phone || !plan) return res.status(400).json({ error: 'Missing phone or plan' });
  const key = `${phone}_${plan}`;
  const status = paymentStatusStore[key]?.status || 'pending';
  res.json({ status });
});

// --- Start server ---
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});