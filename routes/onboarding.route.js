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
// Load OCR.space API key from exported env only (ensure it's set in environment/config)
const OCR_SPACE_API_KEY = env.OCR_SPACE_API_KEY || null;

const router = express.Router();

// Simple heuristic parser to extract course-like and date-like items from OCR text.
// It's intentionally conservative: returns an array of courses and assignments with
// best-effort fields (name, code, professor, title, dueDate). This helps provide
// usable data when AI inference providers are unavailable.
function parseFromOcrText(ocrText) {
  const lines = (ocrText || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const courses = [];
  const assignments = [];
  const importantDates = [];

  const dateRegex = /(\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b)|(\b\d{4}[\-]\d{2}[\-]\d{2}\b)|(\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4})/i;
  const courseCodeRegex = /([A-Z]{2,4}\s?-?\s?\d{3,4})/;
  const bitCodeRegex = /(BIT\s?-?\s?\d{3,4})/i;
  const locationOnlyRegex = /\b(HALL|LAB|FLT|ROOM|BL|CC)\b/i;

  for (const line of lines.slice(0, 200)) {
    // Try to detect lines that start with a course code like BIT4102 or BIT 4201
    const bitMatch = line.match(bitCodeRegex);
    if (bitMatch) {
      const code = bitMatch[0].replace(/\s+/g, '').toUpperCase();
      // The course name may be on the same line after the code or on the next line
      let name = line.replace(bitMatch[0], '').replace(/[-–—]/g, ' ').trim();
      // peek at next line if name is empty and next line looks like title (not location)
      const nextLine = lines[lines.indexOf(line) + 1];
      if ((!name || name.length < 3) && nextLine && !locationOnlyRegex.test(nextLine) && nextLine.length < 80) {
        name = nextLine;
      }
      // filter out lines that are actually room names e.g., "IT LAB V" or "FLT HALL B"
      if (locationOnlyRegex.test(name) && name.length < 30) {
        // push the code with null name but prefer later detection
        courses.push({ name: null, code, professor: null });
      } else {
        courses.push({ name: name || null, code, professor: null });
      }
      continue;
    }

    // Detect assignment-like lines that include words like "due" or "deadline"
    if (/\b(due date|due|deadline)\b/i.test(line)) {
      const dateMatch = line.match(dateRegex);
      const dueDate = dateMatch ? (new Date(dateMatch[0]).toISOString().slice(0,10)) : null;
      const title = line.replace(/\b(due date|due|deadline)[:\-]?/i, '').replace(dateRegex, '').trim() || null;
      assignments.push({ title, dueDate, course: null });
      continue;
    }

    // Generic important date detection
    if (dateRegex.test(line) && /\b(holiday|exam|exam\s+week|start|end|deadline|due)\b/i.test(line)) {
      const m = line.match(dateRegex);
      const date = m ? (new Date(m[0]).toISOString().slice(0,10)) : null;
      importantDates.push({ title: line.replace(dateRegex, '').trim() || 'Important date', date });
      continue;
    }

    // If line looks like a course name (Intro/Introduction/Seminar) but not a location, capture it
    if (/\b(Intro|Introduction|Seminar|Lab|Mobile|Computing|Network|Management|Graphics)\b/i.test(line) && line.length < 80 && !locationOnlyRegex.test(line)) {
      courses.push({ name: line, code: null, professor: null });
      continue;
    }
  }

  // Deduplicate course names
  const seen = new Set();
  const uniqCourses = [];
  for (const c of courses) {
    const key = (c.name || '') + '||' + (c.code || '');
    if (seen.has(key)) continue;
    seen.add(key);
    uniqCourses.push(c);
  }

  return { courses: uniqCourses, assignments, importantDates };
}

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

    // Acquire a slot in the global semaphore to limit concurrent OCR calls
    const release = await globalSemaphore.acquire();
    try {
      // Attempt to build parsedText using OCR.space (if key present) or local OCR
      let parsedText = '';
      const fileBase64 = Buffer.from(req.file.buffer).toString('base64');

      if (req.file.mimetype && req.file.mimetype.startsWith('image/')) {
        if (OCR_SPACE_API_KEY) {
          try {
            const params = new URLSearchParams();
            params.append('apikey', OCR_SPACE_API_KEY);
            params.append('language', 'eng');
            params.append('isOverlayRequired', 'false');
            params.append('base64Image', `data:${req.file.mimetype};base64,${fileBase64}`);
            const resp = await axios.post('https://api.ocr.space/parse/image', params.toString(), {
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              timeout: 60000,
            });
            if (resp?.data?.IsErroredOnProcessing) {
              logger?.warn('OCR.space reported an error', { err: resp.data.ErrorMessage || resp.data.ErrorDetails });
              parsedText = await recognizeBuffer(req.file.buffer);
            } else {
              const parsed = resp.data.ParsedResults || [];
              parsedText = parsed.map(p => p.ParsedText || '').filter(Boolean).join('\n');
            }
          } catch (ocrErr) {
            logger?.warn('OCR.space request failed, falling back to local OCR', { err: ocrErr?.message || ocrErr });
            parsedText = await recognizeBuffer(req.file.buffer);
          }
        } else {
          parsedText = await recognizeBuffer(req.file.buffer);
        }
      } else if (req.file.mimetype === 'application/pdf') {
        const pdfParse = await import('pdf-parse');
        const pdfData = await pdfParse.default(req.file.buffer);
        parsedText = pdfData.text || '';
      } else {
        parsedText = await recognizeBuffer(req.file.buffer).catch(() => '');
      }

      const extracted = parseFromOcrText(parsedText || '');

      // Persist extracted data to DB for the authenticated user (if available and allowed)
      try {
        const supabaseId = req.user?.id || req.user?.sub || req.user?.user?.id;

        // If no supabaseId found (anonymous) and anon onboarding allowed, return extracted data
        if (!supabaseId) {
          if (env.allowAnonOnboarding) {
            try {
              const draftId = env.REDIS_URL ? await saveDraft(extracted) : null;
              const response = { status: 'success', source: 'ocr-space', data: extracted, saved: { courses: [], assignments: [] }, note: 'anonymous-preview' };
              if (draftId) response['draftId'] = draftId;
              return res.json(response);
            } catch (err) {
              logger?.warn('Failed to save anonymous draft', { err: err?.message || err });
              return res.json({ status: 'success', source: 'ocr-space', data: extracted, saved: { courses: [], assignments: [] }, note: 'anonymous-preview' });
            }
          }
          throw new Error('Unable to determine user id from auth');
        }

        // Upsert courses (avoid duplicates)
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
        res.json({ status: 'success', source: 'ocr-space', data: extracted, saved: { courses: savedCourses, assignments: savedAssignments } });
        return;
      } catch (saveErr) {
        logger?.warn('Failed to persist extracted onboarding data', { err: saveErr?.message || saveErr });
        // Still return extracted data but inform client persistence failed
        res.json({ status: 'success', source: 'ocr-space', data: extracted, saved: { courses: [], assignments: [] }, warning: 'Failed to persist data' });
        return;
      }
    } finally {
      try { release(); } catch (e) { /* noop */ }
    }
  } catch (err) {
    logger?.error('Onboarding import error', { err: err?.message || err });
    res.status(500).json({ error: 'Failed to process onboarding document', details: err?.message || '' });
  }
});

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

export default router;
