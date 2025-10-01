import express from 'express';
import multer from 'multer';
import axios from 'axios';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// Use memory storage so we have access to req.file.buffer
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

router.post('/import', authenticate, upload.single('file'), async (req, res) => {
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

    // Call GPT-4 Vision API for syllabus analysis
    let response;
    // If OpenAI key is missing, skip remote call and fallback to local parsing
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OpenAI API key not configured');
    }

    response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4-vision-preview',
      max_tokens: 4096,
      messages: [
        {
          role: 'system',
          content: 'You are an expert academic data extraction assistant. Extract information in a precise, structured format.'
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Analyze this document and extract academic information in the following JSON structure:

{
  "courses": [{
    "name": "string",
    "code": "string",
    "professor": "string",
    "schedule": {
      "days": ["string"],
      "time": "string",
      "location": "string"
    },
    "credits": number,
    "materials": ["string"]
  }],
  "assignments": [{
    "title": "string",
    "courseCode": "string",
    "dueDate": "YYYY-MM-DD",
    "type": "string",
    "description": "string",
    "weight": number
  }],
  "importantDates": [{
    "event": "string",
    "date": "YYYY-MM-DD",
    "description": "string"
  }]
}

Extract ALL relevant information. Use null for missing values. Format dates as YYYY-MM-DD.`
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:${req.file.mimetype};base64,${fileBase64}`
              }
            }
          ]
        }
      ]
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
  });

    if (!response.data.choices || !response.data.choices[0]?.message?.content) {
      throw new Error('Invalid response from GPT-4 Vision');
    }

    try {
      // Parse and validate the extracted data
      const extractedData = JSON.parse(response.data.choices[0].message.content);
      
      // Validate required structure
      if (!extractedData.courses || !Array.isArray(extractedData.courses) ||
          !extractedData.assignments || !Array.isArray(extractedData.assignments)) {
        throw new Error('Invalid data structure in response');
      }

      // Clean and normalize dates
      extractedData.assignments = extractedData.assignments.map(assignment => ({
        ...assignment,
        dueDate: assignment.dueDate ? new Date(assignment.dueDate).toISOString().split('T')[0] : null
      }));

      if (extractedData.importantDates) {
        extractedData.importantDates = extractedData.importantDates.map(date => ({
          ...date,
          date: date.date ? new Date(date.date).toISOString().split('T')[0] : null
        }));
      }

      // Filter out invalid entries
      extractedData.courses = extractedData.courses.filter(course => course.name);
      extractedData.assignments = extractedData.assignments.filter(assignment => 
        assignment.title && assignment.dueDate);

      res.json({
        status: 'success',
        source: 'gpt-4-vision',
        data: extractedData
      });
    } catch (parseError) {
      console.error('Failed to parse or validate GPT-4 Vision response:', parseError);
      res.status(422).json({
        status: 'error',
        source: 'gpt-4-vision',
        error: 'Failed to parse or validate extracted data',
        details: parseError.message
      });
    }
  } catch (error) {
    console.warn('OpenAI extraction failed or not configured:', error.message);

    // Try a simple fallback for PDFs using pdf-parse to extract text
    try {
      if (req.file && req.file.mimetype === 'application/pdf') {
        const pdfParse = await import('pdf-parse');
        const data = await pdfParse.default(req.file.buffer);
        const text = data.text || '';

        // Very naive parsing: split by lines and look for course-like lines (fallback)
        const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const courses = lines.slice(0, 10).map((l, i) => ({ name: l, code: null, professor: null }));
        return res.json({ status: 'success', source: 'local-fallback', data: { courses, assignments: [] } });
      }
    } catch (fallbackErr) {
      console.error('Local PDF fallback failed:', fallbackErr);
    }

    console.error('Error processing syllabus:', error);
    res.status(500).json({
      error: 'Failed to process syllabus',
      details: error.message
    });
  }
});

export default router;