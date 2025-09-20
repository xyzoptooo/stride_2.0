const express = require('express');
const app = express();
const multer = require('multer');
const { parseSyllabus } = require('./syllabusParser');
const upload = multer();
const axios = require('axios');
const base64 = require('base-64');
// Syllabus import endpoint
app.post('/api/syllabus/import', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    let parsed;
    try {
      parsed = await parseSyllabus(req.file);
    } catch (err) {
      // Fallback: send to Groq AI for extraction
      try {
        const aiPayload = {
          prompt: `Extract all assignments and courses with due dates from this syllabus text:\n${req.file.buffer.toString('utf-8')}`
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
        parsed = aiResult.choices?.[0]?.text || aiResult.plan || aiResult.response || null;
      } catch (aiErr) {
        return res.status(500).json({ error: 'Failed to parse syllabus with both rule-based and AI methods.' });
      }
    }
    res.json({ parsed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// AI Planner endpoint
app.get('/api/plan', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });

    // Fetch all relevant user data
    const user = await User.findOne({ supabaseId: userId });
    const courses = await Course.find({ supabaseId: userId });
    const assignments = await Assignment.find({ supabaseId: userId });
    const activities = await Activity.find({ supabaseId: userId });

    // Compose a detailed prompt for Groq
    const prompt = `You are an expert academic planner. Given the following user data, generate a personalized, actionable daily study/work plan.\n\nUser: ${JSON.stringify(user)}\n\nCourses: ${JSON.stringify(courses)}\n\nAssignments: ${JSON.stringify(assignments)}\n\nRecent Activities: ${JSON.stringify(activities)}\n\nThe plan should be clear, motivating, and broken into steps. Include time blocks, priorities, and tips. Format as a numbered list.`;

    let plan = null;
    try {
      const response = await fetch(process.env.GROQ_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ prompt })
      });
      const aiResult = await response.json();
      plan = aiResult.choices?.[0]?.text || aiResult.plan || aiResult.response || null;
    } catch (err) {
      console.log('Groq AI planner error:', err);
    }

    // Fallback: simple plan if AI fails
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
// Basic Express server scaffold for monorepo backend
require('dotenv').config();
const cors = require('cors');
const mongoose = require('mongoose');
const fetch = require('node-fetch'); // For Groq API integration

app.use(cors());
app.use(express.json());

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/semesterstride';
mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('MongoDB connected'))
  .catch((err) => console.error('MongoDB connection error:', err));

// Import models
const User = require('./models/user');
const Assignment = require('./models/assignment');
const Note = require('./models/note');
const Course = require('./models/course');
const Activity = require('./models/activity');
// Groq AI Recommendations endpoint
app.post('/api/recommendations', async (req, res) => {
  try {
    const { supabaseId } = req.body;
    // Fetch user/activity data from MongoDB
    const user = await User.findOne({ supabaseId });
    const activities = await Activity.find({ supabaseId });
    const courses = await Course.find({ supabaseId });

    // Debug logging
    console.log('AI RECOMMENDATIONS DEBUG');
    console.log('supabaseId:', supabaseId);
    console.log('user:', user);
    console.log('activities:', activities);
    console.log('courses:', courses);

    // Prepare payload for Groq
    const payload = {
      user,
      activities,
      courses
    };

    let recommendations = null;
    try {
      // Call Groq API
      const response = await fetch(process.env.GROQ_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      recommendations = await response.json();
      console.log('AI response:', recommendations);
    } catch (err) {
      console.log('Groq API error:', err);
    }

    // Fallback: If no recommendations, generate simple ones from courses
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

// Home route
app.get('/', (req, res) => {
  res.send('Backend API is running');
});

// User routes
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

// Assignment routes
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

// Note routes
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

// Course routes
app.post('/api/courses', async (req, res) => {
  try {
    const { supabaseId, name, semester } = req.body;
    // Check for duplicate: same user, same semester, same course name
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

// Activity routes
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

// --- Mpesa Payment Status Store (in-memory, for demo; use DB for production) ---
const paymentStatusStore = {};

// Mpesa STK Push Payment Integration
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
      PartyA: phone,
      PartyB: partyB,
      PhoneNumber: phone,
      CallBackURL: process.env.MPESA_CALLBACK_URL,
      AccountReference: accountReference || 'SemesterStride',
      TransactionDesc: transactionDesc || 'Premium Payment'
    };
    console.log('--- Mpesa STK Push Attempt ---');
    console.log('Phone:', phone);
    console.log('Payload:', payload);
    try {
      const stkRes = await axios.post(stkUrl, payload, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      console.log('Mpesa API Response:', stkRes.data);
      // Store pending status
      paymentStatusStore[`${phone}_${plan}`] = { status: 'pending', timestamp: Date.now() };
      res.json({ success: true, data: stkRes.data });
    } catch (err) {
      console.error('Mpesa STK Push error:', err.response?.data || err.message);
      res.status(500).json({ error: 'Mpesa STK Push failed', details: err.response?.data || err.message });
    }
// --- Mpesa Payment Callback Handler (for roombaya.com/callback) ---
// You must ensure roombaya.com/callback notifies this backend, or you can use this as a template for your own callback if self-hosted
app.post('/api/mpesa/callback', express.json(), (req, res) => {
  try {
    // Example: extract phone and plan from callback (customize as per your callback payload)
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
  } catch (err) {
    console.error('Mpesa STK Push error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Mpesa STK Push failed', details: err.response?.data || err.message });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});