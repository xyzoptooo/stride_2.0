import express from 'express';
import multer from 'multer';
import axios from 'axios';
import { recognizeBuffer } from '../lib/ocr.js';
import { authenticate } from '../middleware/auth.js';
import { env } from '../config/environment.js';
import Course from '../models/course.js';
import Assignment from '../models/assignment.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

// memory storage
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 12 * 1024 * 1024 } });

// Helper: compute current semester string (e.g., "Fall 2025")
function getCurrentSemester() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  if (month >= 1 && month <= 4) return `Spring ${year}`;
  if (month >= 5 && month <= 8) return `Summer ${year}`;
  return `Fall ${year}`;
}

router.post('/import', authenticate, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    // run OCR for images using shared worker
    let ocrText = '';
    if (req.file.mimetype && req.file.mimetype.startsWith('image/')) {
      try {
        ocrText = await recognizeBuffer(req.file.buffer);
      } catch (e) {
        console.warn('OCR error in onboarding route:', e?.message || e);
        ocrText = '';
      }
    }

    const fileBase64 = Buffer.from(req.file.buffer).toString('base64');

  if (!env.OPENAI_API_KEY) {
      // Fallback: if PDF, try pdf-parse; if image, return OCR text as best-effort
      if (req.file.mimetype === 'application/pdf') {
        const pdfParse = await import('pdf-parse');
        const pdfData = await pdfParse.default(req.file.buffer);
        const text = pdfData.text || '';
        // naive parse - return lines as course names
        const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(0, 30);
        const courses = lines.map(l => ({ name: l, code: null, professor: null }));
        return res.json({ status: 'success', source: 'local-fallback', data: { courses, assignments: [] } });
      }

      // For images, return OCR text so frontend can show it
      return res.json({ status: 'success', source: 'ocr-only', data: { ocrText, courses: [], assignments: [] } });
    }

    const messages = [
      { role: 'system', content: 'You are an expert assistant that extracts course and assignment information from uploaded onboarding documents. Return JSON only.' },
      { role: 'user', content: `Extract courses, assignments and important dates from this document. Return JSON with keys: courses, assignments, importantDates. Use null for missing values. Dates as YYYY-MM-DD.` }
    ];

    if (ocrText) messages.push({ role: 'user', content: `OCR_TEXT:\n${ocrText}` });
    messages.push({ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:${req.file.mimetype};base64,${fileBase64}` } }] });

  const resp = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4-vision-preview',
      max_tokens: 4096,
      messages: messages
    }, {
      headers: {
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const content = resp.data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('Empty response from model');

    let extracted;
    try {
      extracted = JSON.parse(content);
    } catch (e) {
      // If model returned text but not strict JSON, wrap in a best-effort parse
      // Try to find JSON substring
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) extracted = JSON.parse(jsonMatch[0]);
      else throw e;
    }

    // Normalize output minimally
    extracted.assignments = (extracted.assignments || []).map(a => ({ ...a }));
    extracted.courses = (extracted.courses || []).filter(c => c?.name).map(c => ({ ...c }));

    // Persist extracted data to DB for the authenticated user
    try {
      const supabaseId = req.user?.id || req.user?.sub || req.user?.user?.id;
      if (!supabaseId) throw new Error('Unable to determine user id from auth');

      // Upsert courses (avoid duplicates)
      const semester = getCurrentSemester();
      const savedCourses = [];
      for (const c of extracted.courses) {
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

      // Create assignments
      const savedAssignments = [];
      for (const a of extracted.assignments || []) {
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

      // Return both extracted and saved records
      res.json({ status: 'success', source: 'gpt-4-vision', data: extracted, saved: { courses: savedCourses, assignments: savedAssignments } });
      return;
    } catch (saveErr) {
      logger?.warn('Failed to persist extracted onboarding data', { err: saveErr?.message || saveErr });
      // Still return extracted data but inform client persistence failed
      res.json({ status: 'success', source: 'gpt-4-vision', data: extracted, saved: { courses: [], assignments: [] }, warning: 'Failed to persist data' });
      return;
    }
  } catch (err) {
    console.error('Onboarding import error:', err?.message || err);
    res.status(500).json({ error: 'Failed to process onboarding document', details: err?.message || '' });
  }
});

export default router;
