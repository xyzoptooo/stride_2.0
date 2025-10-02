import express from 'express';
import multer from 'multer';
import axios from 'axios';
import { recognizeBuffer } from '../lib/ocr.js';
import { authenticate } from '../middleware/auth.js';
import { env } from '../config/environment.js';
import Course from '../models/course.js';
import Assignment from '../models/assignment.js';
import { logger } from '../utils/logger.js';
import { saveDraft, getDraft, deleteDraft } from '../utils/draftStore.js';
import rateLimit from 'express-rate-limit';
import { globalSemaphore } from '../utils/concurrency.js';

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

// Per-route limiter: protect heavy AI/OCR endpoints from abuse
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 6,
  message: 'Too many uploads, please try again later.'
});

// Note: allowAnonOnboarding lets anonymous users upload a file and receive extracted
// data for preview. Persistence to the DB happens only when authenticated.
const maybeAuthenticate = async (req, res, next) => {
  const authHeader = req.header('Authorization');
  if (!authHeader) return next();

  // If Authorization present, try to validate token with Supabase.
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.replace('Bearer ', '').trim() : null;
  if (!token) {
    // malformed header - treat as anonymous if allowed
    if (env.allowAnonOnboarding) return next();
    return res.status(401).json({ error: 'No authentication token provided' });
  }

  try {
    // If Supabase config missing, avoid making a network call to undefined host
    if (!env.SUPABASE_PROJECT_ID || !env.SUPABASE_SERVICE_KEY) {
      console.warn('Supabase config missing; skipping token verification');
      if (env.allowAnonOnboarding) return next();
      return res.status(500).json({ error: 'Server misconfiguration: SUPABASE_PROJECT_ID or SUPABASE_SERVICE_KEY missing' });
    }
    const resp = await axios.get(`https://${env.SUPABASE_PROJECT_ID}.supabase.co/auth/v1/user`, {
      headers: { 'Authorization': `Bearer ${token}`, 'apikey': env.SUPABASE_SERVICE_KEY },
      timeout: 5000
    });
    if (resp?.data) {
      req.user = resp.data;
      return next();
    }
    // If no data returned, fallthrough to anonymous if allowed
    if (env.allowAnonOnboarding) return next();
    return res.status(401).json({ error: 'Invalid or expired token' });
  } catch (err) {
    // If verification fails, don't let network/DNS errors throw a 500 - log and fallback.
    const msg = err?.response?.status ? `Supabase responded ${err.response.status}` : err?.message || String(err);
    console.warn('Token verification failed in onboarding route:', msg);
    // If the error is network/DNS related, treat as verification failure (not fatal)
    if (env.allowAnonOnboarding) return next();
    // Otherwise, respond with 401 to indicate auth is required
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

router.post('/import', maybeAuthenticate, uploadLimiter, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    // Acquire a slot in the global semaphore to limit concurrent OCR/OpenAI calls
    const release = await globalSemaphore.acquire();
    try {
      // run OCR for images using shared worker
      let ocrText = '';
      if (req.file.mimetype && req.file.mimetype.startsWith('image/')) {
        try {
          ocrText = await recognizeBuffer(req.file.buffer);
        } catch (e) {
          // recognizeBuffer already logs; bubble up only if it's a fatal worker error
          logger?.warn('OCR error in onboarding route', { err: e?.message || e });
          // If OCR subsystem is broken/unavailable, return a 503 so clients can retry later
          if (e && /OCR worker marked as broken|worker\.load is not a function|langsArr\.map is not a function/i.test(e?.message || '')) {
            return res.status(503).json({ error: 'OCR service currently unavailable, please try again later' });
          }
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

    // Persist extracted data to DB for the authenticated user (if available and allowed)
    try {
      const supabaseId = req.user?.id || req.user?.sub || req.user?.user?.id;

      // If no supabaseId found (anonymous) and anon onboarding allowed, return extracted data
      if (!supabaseId) {
        if (env.allowAnonOnboarding) {
          // Save draft server-side and return draftId so client can finalize after auth
          try {
            const draftId = env.REDIS_URL ? await saveDraft(extracted) : null;
            const response = { status: 'success', source: 'gpt-4-vision', data: extracted, saved: { courses: [], assignments: [] }, note: 'anonymous-preview' };
            if (draftId) response['draftId'] = draftId;
            return res.json(response);
          } catch (err) {
            logger?.warn('Failed to save anonymous draft', { err: err?.message || err });
            return res.json({ status: 'success', source: 'gpt-4-vision', data: extracted, saved: { courses: [], assignments: [] }, note: 'anonymous-preview' });
          }
        }
        throw new Error('Unable to determine user id from auth');
      }

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
    } finally {
      // ensure we always release the semaphore slot
      try { release(); } catch (e) { /* noop */ }
    }
  } catch (err) {
    logger?.error('Onboarding import error', { err: err?.message || err });
    res.status(500).json({ error: 'Failed to process onboarding document', details: err?.message || '' });
  }
});

export default router;

// Finalize endpoint - accepts parsed JSON for persistence and requires authentication
router.post('/finalize', authenticate, async (req, res) => {
  try {
    const supabaseId = req.user?.id || req.user?.sub || req.user?.user?.id;
    if (!supabaseId) return res.status(401).json({ error: 'Unauthorized' });

    // Support finalizing by passing a draftId (preferred) or by passing parsed JSON in body
    let extracted = req.body || {};
    let usedDraftId = null;
    if (extracted.draftId && env.REDIS_URL) {
      usedDraftId = extracted.draftId;
      const draft = await getDraft(usedDraftId);
      if (!draft) return res.status(404).json({ error: 'Draft not found or expired' });
      extracted = draft;
      // delete the draft after reading to avoid reuse
      await deleteDraft(usedDraftId).catch(() => {});
    }

    // Same persistence logic as import
    const semester = getCurrentSemester();
    const savedCourses = [];
    for (const c of extracted.courses || []) {
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

    res.json({ status: 'success', saved: { courses: savedCourses, assignments: savedAssignments } });
  } catch (err) {
    logger?.error('Finalize onboarding error', { err: err?.message || err });
    res.status(500).json({ error: 'Failed to finalize onboarding' });
  }
});
