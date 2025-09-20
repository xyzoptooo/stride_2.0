// Basic Express server scaffold for monorepo backend
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const fetch = require('node-fetch'); // For Groq API integration

const app = express();
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

    // Prepare payload for Groq
    const payload = {
      user,
      activities
    };

    // Call Groq API
    const response = await fetch(process.env.GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const recommendations = await response.json();
    res.json(recommendations);
  } catch (err) {
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

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});