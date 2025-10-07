import express from 'express';
import multer from 'multer';
import axios from 'axios';
import { recognizeBuffer } from '../lib/ocr.js';
import { authenticate } from '../middleware/auth.js';
import { env } from '../config/environment.js';
import Course from '../models/course.js';
import Assignment from '../models/assignment.js';
import { logger } from '../utils/logger.js';
import rateLimit from 'express-rate-limit';
import { globalSemaphore } from '../utils/concurrency.js';

const router = express.Router();

// Use memory storage so we have access to req.file.buffer
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// Compute current semester helper
function getCurrentSemester(now = new Date()) {
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  if (month >= 1 && month <= 4) return `Spring ${year}`;
  if (month >= 5 && month <= 8) return `Summer ${year}`;
  return `Fall ${year}`;
}

// Per-route limiter for syllabus imports
const syllabusLimiter = rateLimit({ windowMs: 60 * 1000, max: 6, message: 'Too many uploads, please try later.' });

router.post('/import', authenticate, syllabusLimiter, upload.single('file'), async (req, res) => {
  logger?.info('/api/syllabus/import called');

  if (!req.file) {
    logger?.warn('No file uploaded to /api/syllabus/import');
    return res.status(400).json({ error: 'No file uploaded' });
  }

  // Acquire semaphore slot for heavy processing
  const release = await globalSemaphore.acquire();
  try {
    const supabaseId = req.user?.id || req.user?.sub || req.user?.user?.id;
    if (!supabaseId) throw new Error('Unable to determine user id from auth');

    // Base64 for embedding image in prompt
    const fileBase64 = Buffer.from(req.file.buffer).toString('base64');

    // Run OCR for images to aid extraction
    let ocrText = '';
    if (req.file.mimetype && req.file.mimetype.startsWith('image/')) {
      try {
        ocrText = await recognizeBuffer(req.file.buffer);
        logger?.info('OCR text length', { len: ocrText?.length || 0 });
      } catch (e) {
        logger?.warn('OCR failed', { err: e?.message || e });
        ocrText = '';
      }
    }

    // If Groq key is not configured, fall back to pdf-parse or OCR-only
  if (!env.GROQ_API_KEY) {
      try {
        if (req.file.mimetype === 'application/pdf') {
          const pdfParse = await import('pdf-parse');
          const data = await pdfParse.default(req.file.buffer);
          const text = data.text || '';
          const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(0, 30);
          const courses = lines.map(l => ({ name: l }));
          return res.json({ status: 'success', source: 'local-fallback', data: { courses, assignments: [] } });
        }
      } catch (e) {
        logger?.warn('PDF fallback failed', { err: e?.message || e });
      }

      // For images return OCR-only
      return res.json({ status: 'success', source: 'ocr-only', data: { ocrText, courses: [], assignments: [] } });
    }

    // Build prompt string
    let prompt = `Analyze this document and extract academic information in the following JSON structure:\n\n{\n  "courses": [{\n    "name": "string",\n    "code": "string",\n    "professor": "string",\n    "schedule": {\n      "days": ["string"],\n      "time": "string",\n      "location": "string"\n    },\n    "credits": number,\n    "materials": ["string"]\n  }],\n  "assignments": [{\n    "title": "string",\n    "courseCode": "string",\n    "dueDate": "YYYY-MM-DD",\n    "type": "string",\n    "description": "string",\n    "weight": number\n  }],\n  "importantDates": [{\n    "event": "string",\n    "date": "YYYY-MM-DD",\n    "description": "string"\n  }]\n}\n\nExtract ALL relevant information. Use null for missing values. Format dates as YYYY-MM-DD.\n\n`;

    if (ocrText) {
      prompt += `OCR_EXTRACTED_TEXT:\n${ocrText}\n\n`;
    }

    // Add a short instruction that the image (if present) is attached as a data URI
    prompt += `Image (if present) is included as a data URI with mimetype ${req.file.mimetype} and will be available to you for visual analysis.`;

  const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama-3.2-90b-vision-preview',
      max_tokens: 4096,
      messages: [
        { role: 'system', content: 'You are an expert academic data extraction assistant. Extract information in a precise, structured format.' },
        { role: 'user', content: prompt }
      ]
    }, {
      headers: {
        'Authorization': `Bearer ${env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 120000
    });

    const modelContent = response.data?.choices?.[0]?.message?.content;
    if (!modelContent) throw new Error('Empty response from model');

    let extractedData;
    try {
      extractedData = JSON.parse(modelContent);
    } catch (e) {
      const jsonMatch = modelContent.match(/\{[\s\S]*\}/);
      if (jsonMatch) extractedData = JSON.parse(jsonMatch[0]);
      else throw e;
    }

    // Validate structure
    if (!extractedData || !Array.isArray(extractedData.courses) || !Array.isArray(extractedData.assignments)) {
      throw new Error('Invalid data structure from model');
    }

    // Normalize dates
    extractedData.assignments = (extractedData.assignments || []).map(a => ({
      ...a,
      dueDate: a && a.dueDate ? new Date(a.dueDate).toISOString().split('T')[0] : null
    }));

    if (extractedData.importantDates) {
      extractedData.importantDates = extractedData.importantDates.map(d => ({ ...d, date: d?.date ? new Date(d.date).toISOString().split('T')[0] : null }));
    }

    // Filter
    extractedData.courses = (extractedData.courses || []).filter(c => c && c.name);
    extractedData.assignments = (extractedData.assignments || []).filter(a => a && a.title);

  // Persist to DB
  try {
      const semester = getCurrentSemester();

      const savedCourses = [];
      for (const c of extractedData.courses) {
        const name = (c.name || '').trim();
        if (!name) continue;
        const update = {
          supabaseId,
          name,
          professor: c.professor || null,
          credits: c.credits || null,
          schedule: c.schedule ? JSON.stringify(c.schedule) : c.schedule || null,
          progress: 0,
          semester
        };
        const saved = await Course.findOneAndUpdate({ supabaseId, name, semester }, update, { upsert: true, new: true, setDefaultsOnInsert: true });
        savedCourses.push(saved);
      }

      const savedAssignments = [];
      for (const a of extractedData.assignments) {
        if (!a.title) continue;
        const due = a.dueDate ? new Date(a.dueDate) : null;
        const assignmentDoc = new Assignment({
          supabaseId,
          title: a.title,
          course: a.course || a.courseCode || null,
          dueDate: due,
          progress: 0,
          notes: a.description || null
        });
        const savedA = await assignmentDoc.save();
        savedAssignments.push(savedA);
      }

      return res.json({ status: 'success', source: 'groq-vision', data: extractedData, saved: { courses: savedCourses, assignments: savedAssignments } });
    } catch (saveErr) {
      logger?.warn('Failed to persist extracted syllabus data', { err: saveErr?.message || saveErr });
      return res.json({ status: 'success', source: 'groq-vision', data: extractedData, saved: { courses: [], assignments: [] }, warning: 'Failed to persist data' });
    }
  } catch (error) {
    logger?.warn('Groq extraction failed or not configured', { err: error?.message || error });

    // Try PDF fallback
    try {
      if (req.file && req.file.mimetype === 'application/pdf') {
        const pdfParse = await import('pdf-parse');
        const data = await pdfParse.default(req.file.buffer);
        const text = data.text || '';
        const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(0, 30);
        const courses = lines.map(l => ({ name: l }));
        return res.json({ status: 'success', source: 'local-fallback', data: { courses, assignments: [] } });
      }
    } catch (fallbackErr) {
      logger?.error('Local PDF fallback failed', { err: fallbackErr?.message || fallbackErr });
    }

    // For images, return OCR-only result if available
    try {
      if (req.file && req.file.mimetype && req.file.mimetype.startsWith('image/')) {
        const ocrText = await recognizeBuffer(req.file.buffer);
        return res.json({ status: 'success', source: 'ocr-only', data: { ocrText, courses: [], assignments: [] } });
      }
    } catch (ocrErr) {
      logger?.error('OCR fallback failed', { err: ocrErr?.message || ocrErr });
    }

    return res.status(500).json({ error: 'Failed to process syllabus', details: error?.message || '' });
  } finally {
    try { release(); } catch (e) { /* noop */ }
  }
});

export default router;