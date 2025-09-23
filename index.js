
import express from 'express';
import dotenv from 'dotenv';
// import cors from 'cors';
import mongoose from 'mongoose';
import multer from 'multer';
import { parseSyllabus } from './syllabusParser.js';
import axios from 'axios';
import base64 from 'base-64';
import fetch from 'node-fetch';

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
mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('MongoDB connected'))
  .catch((err) => console.error('MongoDB connection error:', err));

// --- Import models ---
import User from './models/user.js';
import Assignment from './models/assignment.js';
import Note from './models/note.js';
import Course from './models/course.js';
import Activity from './models/activity.js';

// --- AI Mindmap endpoint ---
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
app.post('/api/syllabus/import', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    let parsed;
    try {
      parsed = await parseSyllabus(req.file);
    } catch (err) {
      try {
        const aiPayload = {
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: 'You are an expert academic assistant.' },
            { role: 'user', content: `Extract all assignments and courses with due dates from this syllabus text:\n${req.file.buffer.toString('utf-8')}` }
          ]
        };
        const response = await fetch(process.env.GROQ_API_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(aiPayload)
        });
        const aiResult = await response.json();
        parsed = aiResult.choices?.[0]?.message?.content || aiResult.plan || aiResult.response || null;
      } catch (aiErr) {
        return res.status(500).json({ error: 'Failed to parse syllabus with both rule-based and AI methods.' });
      }
    }
    res.json({ parsed });
  } catch (err) {
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
app.post('/api/recommendations', async (req, res) => {
  try {
    const { supabaseId } = req.body;
    const user = await User.findOne({ supabaseId });
    const activities = await Activity.find({ supabaseId });
    const courses = await Course.find({ supabaseId });

    // Prepare payload for Groq chat completion
    const recMessages = [
      { role: 'system', content: 'You are an expert academic assistant.' },
      { role: 'user', content: `Given the following activities and courses, generate actionable, personalized study recommendations. Use "you" and "your" language (e.g., "since you have", "your courses"), not "the user".\n\nActivities: ${JSON.stringify(activities)}\n\nCourses: ${JSON.stringify(courses)}\n\nFormat as a list.` }
    ];
    let recommendations = null;
    try {
      const response = await fetch(process.env.GROQ_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: recMessages })
      });
      const aiResult = await response.json();
      let content = aiResult.choices?.[0]?.message?.content || aiResult.plan || aiResult.response || null;
      let recArray = [];
      if (content) {
        recArray = content.split(/\n|\r/)
          .filter(line => /^\s*(\d+\.|\*|\u2022)/.test(line))
          .map(line => line.replace(/^\s*(\d+\.|\*|\u2022)\s*/, ''))
          .map(line => line.replace(/^[\u2022\*]+/g, ''))
          .map(line => line.replace(/(^|\s)[\u{1F300}-\u{1FAFF}]+/gu, ''))
          .map(text => text.trim())
          .filter(Boolean)
          .slice(0, 3);
      }
      recommendations = { recommendations: recArray };
    } catch (err) {
      console.log('Groq API error:', err);
    }
    if (!recommendations || !recommendations.recommendations) {
      if (courses && courses.length > 0) {
        recommendations = {
          recommendations: `Based on your courses: ${courses.map(c => c.name).join(", ")}, try reviewing your notes, practicing key concepts, and planning study sessions for each course.`
        };
      } else {
        recommendations = { recommendations: "Add some courses to get personalized study recommendations!" };
      }
    }
    res.json(recommendations);
  } catch (err) {
    console.log('RECOMMENDATIONS ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Home route ---
app.get('/', (req, res) => {
  res.send('Backend API is running');
});

// --- User routes ---
app.post('/api/users', async (req, res) => {
  try {
    const { supabaseId, name, email } = req.body;
    const user = new User({ supabaseId, name, email });
    await user.save();
    res.status(201).json(user);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/users/:supabaseId', async (req, res) => {
  try {
    const user = await User.findOne({ supabaseId: req.params.supabaseId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Assignment routes ---
app.post('/api/assignments', async (req, res) => {
  try {
    const assignment = new Assignment(req.body);
    await assignment.save();
    res.status(201).json(assignment);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/assignments/:supabaseId', async (req, res) => {
  try {
    const assignments = await Assignment.find({ supabaseId: req.params.supabaseId });
    res.json(assignments);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Note routes ---
app.post('/api/notes', async (req, res) => {
  try {
    const note = new Note(req.body);
    await note.save();
    res.status(201).json(note);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/notes/:supabaseId', async (req, res) => {
  try {
    const notes = await Note.find({ supabaseId: req.params.supabaseId });
    res.json(notes);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Course routes ---
app.post('/api/courses', async (req, res) => {
  try {
    const { supabaseId, name, semester } = req.body;
    const existing = await Course.findOne({ supabaseId, name, semester });
    if (existing) {
      return res.status(409).json({ error: 'Course already exists for this semester.' });
    }
    const course = new Course(req.body);
    await course.save();
    res.status(201).json(course);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/courses/:supabaseId', async (req, res) => {
  try {
    const courses = await Course.find({ supabaseId: req.params.supabaseId });
    res.json(courses);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Activity routes ---
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
  const auth = base64.encode(`${consumerKey}:${consumerSecret}`);
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
    const password = base64.encode(businessShortCode + passkey + timestamp);
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