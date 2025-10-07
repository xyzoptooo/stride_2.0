// Image Analysis engine for Academic Document Processing
// Handles images, PDFs, and DOCX with proper error handling, logging, and performance safeguards

import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import { createLogger, format, transports } from 'winston';
import axios from 'axios';
import { env } from './config/environment.js';

// Configure structured logging
const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.json()
  ),
  transports: [new transports.Console()],
});

// Configuration constants
const CONFIG = {
  // derive byte limit from env.maxFileSize if possible; env.maxFileSize is a string like '50mb'
  MAX_FILE_SIZE: (function parseSize(str) {
    try {
      if (!str) return 50 * 1024 * 1024;
      const normalized = String(str).trim().toLowerCase();
      if (normalized.endsWith('mb')) return parseFloat(normalized) * 1024 * 1024;
      if (normalized.endsWith('kb')) return parseFloat(normalized) * 1024;
      if (normalized.endsWith('b')) return parseFloat(normalized);
      // fallback assume bytes
      return parseInt(normalized, 10) || 50 * 1024 * 1024;
    } catch (err) {
      return 50 * 1024 * 1024;
    }
  })(env.maxFileSize),
  OCR_TIMEOUT_MS: 120000, // 2 minutes
  MIN_TEXT_LENGTH: 10,
  SUPPORTED_MIME_TYPES: new Set([
    'image/png', 'image/jpeg', 'image/gif', 'image/bmp', 'image/tiff',
    'application/pdf', 
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ])
};

/**
 * Processes an image buffer using Groq Vision API for text extraction
 * @param {Buffer} buffer - The image buffer to process
 * @param {string} filename - Original filename (for logging)
 * @returns {Promise<string>} Extracted text from the image
 */
async function ocrImageBuffer(buffer, filename) {
  try {
    // Validate file type and size
    const fileType = await import('file-type').then(mod => mod.fileTypeFromBuffer(buffer));
    if (!fileType || !CONFIG.SUPPORTED_MIME_TYPES.has(fileType.mime)) {
      throw new Error(`Unsupported file type: ${fileType?.mime || 'unknown'}`);
    }
    if (buffer.length > CONFIG.MAX_FILE_SIZE) {
      throw new Error(`File too large: ${buffer.length} bytes`);
    }

    // Convert image buffer to base64
    const base64Image = buffer.toString('base64');

    // Set up timeout for Groq API call
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Groq AI operation timed out')), CONFIG.OCR_TIMEOUT_MS);
    });

    // Call Groq AI API for image analysis (using llama-3.2-90b-vision-preview for vision tasks)
    const apiPromise = axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama-3.2-90b-vision-preview',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'You are a syllabus analysis assistant. Please analyze this image and extract all academic information in a structured format. Focus on:\n1. Course details (name, code, professor, contact info)\n2. Assignments and due dates\n3. Course schedule and important dates\n4. Required materials\n5. Grading criteria\n\nProvide the information in a clear, structured format that can be easily parsed.'
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:${fileType.mime};base64,${base64Image}`
              }
            }
          ]
        }
      ],
      max_tokens: 4096
    }, {
      headers: {
        'Authorization': `Bearer ${env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }).catch(error => {
      logger.error('Groq AI API error:', { error });
      throw new Error('Image analysis failed');
    });

    const response = await Promise.race([apiPromise, timeoutPromise]);

    if (!response.data.choices || !response.data.choices[0]?.message?.content) {
      throw new Error('Invalid response from Groq AI');
    }

    const extractedText = response.data.choices[0].message.content;
    if (extractedText.length < CONFIG.MIN_TEXT_LENGTH) {
      throw new Error('Extracted text too short');
    }

    return extractedText;

  } catch (error) {
    logger.error('Image analysis error:', {
      error,
      filename,
      fileSize: buffer.length
    });
    throw error;
  }
}

/**
 * Extracts text from a PDF buffer
 * @param {Buffer} buffer - The PDF buffer to process
 * @returns {Promise<string>} Extracted text from the PDF
 */
async function extractTextFromPdfBuffer(buffer) {
  try {
    const data = await pdfParse(buffer);
    return data.text;
  } catch (error) {
    logger.error('PDF parsing error:', { error });
    throw new Error('PDF processing failed');
  }
}

export { ocrImageBuffer, extractTextFromPdfBuffer };