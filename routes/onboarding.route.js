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
import { HfInference } from '@huggingface/inference';

const hf = env.HF_API_TOKEN ? new HfInference(env.HF_API_TOKEN) : null;
// Use a DocVQA-style model that is commonly hosted on the HF Inference API.
// Donut (naver-clova-ix) is a good fit for document-to-structured-text tasks.
const VQA_MODEL = 'naver-clova-ix/donut-base-finetuned-docvqa';
// A text-only fallback model (used when a VQA/image provider isn't available for the
// user's account). We will pass the OCR text to this model and ask it to produce the
// same JSON output. This avoids requiring an image inference provider but still
// depends on a text inference provider being available.
const TEXT_FALLBACK_MODEL = 'google/flan-t5-large';

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

  for (const line of lines.slice(0, 200)) {
    // Try to detect course lines like "CS 101 - Intro to Programming - Prof. X"
    if (courseCodeRegex.test(line) && /\b(prof|professor|dr\.|dr\b|lecturer)\b/i.test(line)) {
      const codeMatch = line.match(courseCodeRegex);
      const code = codeMatch ? codeMatch[0].replace(/\s+/g, '') : null;
      const name = line.replace(codeMatch ? codeMatch[0] : '', '').replace(/[-–—]/g, ' ').replace(/\b(prof|professor|dr\.|dr\b|lecturer)\b.*/i, '').trim();
      const profMatch = line.match(/(Prof\.?|Professor|Dr\.|Dr)\s+([A-Za-z .]+)/i);
      const professor = profMatch ? profMatch[2].trim() : null;
      courses.push({ name: name || null, code: code || null, professor });
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

    // If a line looks like a course name (has words like "Introduction" or "Intro" or "101")
    if (/\b(Intro|Introduction|Seminar|Lab|101|102|201|202)\b/i.test(line) && line.length < 80) {
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

      // If HF_API_TOKEN is not set, we can't proceed with AI processing.
      if (!hf) {
        logger.warn('HF_API_TOKEN not set. Skipping AI processing.');
        // Fallback to simple parsers if AI is not configured
        if (req.file.mimetype === 'application/pdf') {
          const pdfParse = await import('pdf-parse');
          const pdfData = await pdfParse.default(req.file.buffer);
          const text = pdfData.text || '';
          const parsed = parseFromOcrText(text);
          return res.json({ status: 'success', source: 'local-fallback', data: parsed });
        }
        // For images, return parsed OCR text so frontend can show structured suggestions
        const parsed = parseFromOcrText(ocrText);
        return res.json({ status: 'success', source: 'ocr-only', data: parsed, note: 'ocr-fallback' });
      }

      const question = `Based on the provided syllabus image, extract all courses, assignments, and important dates. Return the information as a single, clean JSON object with three keys: "courses", "assignments", and "importantDates". The "courses" key should be an array of objects, each with "name", "code", and "professor" properties. The "assignments" key should be an array of objects, each with "title", "dueDate" (in YYYY-MM-DD format), and "course" properties. The "importantDates" key should be an array of objects with "title" and "date" (YYYY-MM-DD). If a value is not found, use null. Do not include any explanatory text outside of the JSON object.`;

      logger.info(`Attempting to use Hugging Face VQA model: ${VQA_MODEL}`);

      let content = '';
      try {
        const hfResponse = await hf.visualQuestionAnswering({
          model: VQA_MODEL,
          inputs: {
            question: question,
            image: req.file.buffer,
          },
        });
        // The response is often a string containing the JSON.
        content = hfResponse?.[0]?.generated_text || hfResponse?.generated_text || '';
        if (!content) throw new Error('Empty response from Hugging Face model');
      } catch (hfErr) {
        // If the error indicates no inference provider is available for the requested
        // image model, attempt a fallback that uses OCR text + a text-generation model.
        const msg = (hfErr && (hfErr.message || hfErr.err || String(hfErr))) || 'Unknown HF error';
        logger?.warn('Hugging Face visualQuestionAnswering failed', { err: msg });
        if (/No Inference Provider available/i.test(msg) || /provider/i.test(msg)) {
          logger.info('Falling back to text-only model using OCR output');
          // Prepare OCR text for prompt (truncate to avoid overly long inputs)
          const ocrForPrompt = (ocrText || '').slice(0, 15000);
          const textPrompt = `You are given the extracted text from a syllabus document.\n\n` +
            `Text:\n${ocrForPrompt}\n\n` +
            `${question}`;

          try {
            const textResp = await hf.textGeneration({
              model: TEXT_FALLBACK_MODEL,
              inputs: textPrompt,
            });
            // textGeneration can return an array or object depending on provider
            content = textResp?.[0]?.generated_text || textResp?.generated_text || String(textResp || '');
            if (!content) throw new Error('Empty response from text fallback model');
          } catch (textErr) {
            const tmsg = (textErr && (textErr.message || String(textErr))) || 'Unknown text-fallback error';
            logger?.error('Text-fallback model failed', { err: tmsg });
            // As a last resort, return OCR-only results so the frontend can at least show
            // extracted text for manual review. Provide a helpful warning so the operator
            // can configure HF inference providers or use an API token with providers.
            return res.json({
              status: 'success',
              source: 'ocr-only',
              data: { ocrText, courses: [], assignments: [] },
              warning: 'AI inference providers unavailable for both image and text models. Please configure inference providers at https://hf.co/settings/inference-providers or use a supported token.'
            });
          }
        } else {
          // Unknown HF error - rethrow to be handled by outer catch
          throw hfErr;
        }
      }

      let extracted;
      try {
        // Find the JSON block within the potentially messy string response
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          extracted = JSON.parse(jsonMatch[0]);
        } else {
          throw new Error('No JSON object found in the model response.');
        }
      } catch (e) {
        logger.error('Failed to parse JSON from Hugging Face response', { content, error: e.message });
        throw new Error('Could not understand the response from the AI model.');
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
            const response = { status: 'success', source: 'huggingface-llava', data: extracted, saved: { courses: [], assignments: [] }, note: 'anonymous-preview' };
            if (draftId) response['draftId'] = draftId;
            return res.json(response);
          } catch (err) {
            logger?.warn('Failed to save anonymous draft', { err: err?.message || err });
            return res.json({ status: 'success', source: 'huggingface-llava', data: extracted, saved: { courses: [], assignments: [] }, note: 'anonymous-preview' });
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
      res.json({ status: 'success', source: 'huggingface-llava', data: extracted, saved: { courses: savedCourses, assignments: savedAssignments } });
      return;
    } catch (saveErr) {
      logger?.warn('Failed to persist extracted onboarding data', { err: saveErr?.message || saveErr });
      // Still return extracted data but inform client persistence failed
      res.json({ status: 'success', source: 'huggingface-llava', data: extracted, saved: { courses: [], assignments: [] }, warning: 'Failed to persist data' });
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
