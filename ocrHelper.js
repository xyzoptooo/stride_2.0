// OCR engine for Academic Document Processing
// Handles images, PDFs, and DOCX with proper error handling, logging, and performance safeguards

import Tesseract from 'tesseract.js';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import { fromBuffer } from 'file-type';
import { createLogger, format, transports } from 'winston';

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
  MAX_FILE_SIZE: 50 * 1024 * 1024, // 50MB
  OCR_TIMEOUT_MS: 120000, // 2 minutes
  MIN_TEXT_CONFIDENCE: 0.7,
  MIN_TEXT_LENGTH: 10,
  SUPPORTED_MIME_TYPES: new Set([
    'image/png', 'image/jpeg', 'image/gif', 'image/bmp', 'image/tiff',
    'application/pdf', 
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ])
};

class OCRProcessingError extends Error {
  constructor(message, errorCode, context = {}) {
    super(message);
    this.name = 'OCRProcessingError';
    this.errorCode = errorCode;
    this.context = context;
  }
}

// Validate input before processing
async function validateInput(buffer, filename) {
  if (!buffer || buffer.length === 0) {
    throw new OCRProcessingError('Empty file provided', 'EMPTY_FILE');
  }

  if (buffer.length > CONFIG.MAX_FILE_SIZE) {
    throw new OCRProcessingError(
      `File size ${buffer.length} exceeds limit ${CONFIG.MAX_FILE_SIZE}`,
      'FILE_TOO_LARGE'
    );
  }

  let fileExtension = filename ? filename.split('.').pop().toLowerCase() : null;
  let mimeType = null;
  if (!fileExtension || !['pdf', 'docx', 'doc', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'tiff'].includes(fileExtension)) {
    // Try to detect MIME type from buffer
  const type = await fromBuffer(buffer);
    mimeType = type?.mime;
    if (!mimeType || !CONFIG.SUPPORTED_MIME_TYPES.has(mimeType)) {
      throw new OCRProcessingError(`Unsupported file type: ${fileExtension || mimeType || 'unknown'}`, 'UNSUPPORTED_TYPE');
    }
  }
}

// Enhanced DOCX extraction with error handling
async function extractTextFromDocxBuffer(buffer, filename) {
  const startTime = Date.now();
  try {
    await validateInput(buffer, filename);
    const result = await mammoth.extractRawText({ buffer });
    if (!result.value || result.value.trim().length < CONFIG.MIN_TEXT_LENGTH) {
      logger.warn('DOCX extracted minimal or no text', { filename, textLength: result.value?.length });
      throw new OCRProcessingError('Document contains no extractable text', 'NO_EXTRACTABLE_TEXT');
    }
    logger.info('DOCX extraction completed', {
      filename,
      duration: Date.now() - startTime,
      textLength: result.value.length
    });
    return result.value;
  } catch (error) {
    logger.error('DOCX extraction failed', {
      filename,
      error: error.message,
      duration: Date.now() - startTime
    });
    if (error instanceof OCRProcessingError) throw error;
    throw new OCRProcessingError(`DOCX processing failed: ${error.message}`, 'PROCESSING_FAILED');
  }
}

// Robust OCR with timeout and progress tracking
async function ocrImageBuffer(buffer, filename) {
  const startTime = Date.now();
  return new Promise(async (resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new OCRProcessingError('OCR processing timeout', 'PROCESS_TIMEOUT'));
    }, CONFIG.OCR_TIMEOUT_MS);
    try {
      await validateInput(buffer, filename);
      Tesseract.recognize(buffer, 'eng', {
        logger: m => logger.debug('Tesseract progress', { ...m, filename })
      })
      .then(({ data: { text, confidence } }) => {
        clearTimeout(timeoutId);
        if (!text || text.trim().length < CONFIG.MIN_TEXT_LENGTH) {
          throw new OCRProcessingError('OCR extracted no meaningful text', 'NO_TEXT_FOUND');
        }
        if (confidence < CONFIG.MIN_TEXT_CONFIDENCE) {
          logger.warn('Low OCR confidence', { filename, confidence });
        }
        logger.info('OCR completed', {
          filename,
          duration: Date.now() - startTime,
          textLength: text.length,
          confidence
        });
        resolve(text);
      })
      .catch(error => {
        clearTimeout(timeoutId);
        reject(new OCRProcessingError(`OCR failed: ${error.message}`, 'OCR_FAILED'));
      });
    } catch (error) {
      clearTimeout(timeoutId);
      reject(error);
    }
  });
}

// Comprehensive PDF processing with proper fallback logic
async function extractTextFromPdfBuffer(buffer, filename) {
  const startTime = Date.now();
  try {
    await validateInput(buffer, filename);
    // Attempt text extraction first
    const pdfData = await pdfParse(buffer);
    const extractedText = pdfData.text || '';
    // Smart text validation instead of magic numbers
    const hasSubstantialText = hasMeaningfulText(extractedText);
    if (hasSubstantialText) {
      logger.info('PDF text extraction successful', {
        filename,
        method: 'pdf-parse',
        duration: Date.now() - startTime,
        textLength: extractedText.length,
        pages: pdfData.numpages
      });
      return extractedText;
    }
    // Fallback to OCR for scanned PDFs
    logger.info('PDF contains minimal text, attempting OCR fallback', { filename });
    const ocrText = await ocrImageBuffer(buffer, filename);
    // Validate OCR result
    if (!hasMeaningfulText(ocrText)) {
      throw new OCRProcessingError('Both text extraction and OCR failed to extract meaningful content', 'EXTRACTION_FAILED');
    }
    logger.info('PDF OCR fallback successful', {
      filename,
      method: 'ocr',
      duration: Date.now() - startTime,
      textLength: ocrText.length
    });
    return ocrText;
  } catch (error) {
    logger.error('PDF processing failed', {
      filename,
      error: error.message,
      duration: Date.now() - startTime
    });
    if (error instanceof OCRProcessingError) throw error;
    throw new OCRProcessingError(`PDF processing failed: ${error.message}`, 'PDF_PROCESSING_FAILED');
  }
}

// Smart text validation using multiple heuristics
function hasMeaningfulText(text) {
  if (!text || text.trim().length < CONFIG.MIN_TEXT_LENGTH) return false;
  
  const cleanText = text.trim();
  
  // Check for common garbage PDF extraction patterns
  const garbagePatterns = [
    /^[\s\S]*?[�]{10,}[\s\S]*$/, // Excessive replacement characters
    /^[^a-zA-Z0-9]{100,}$/, // Mostly non-alphanumeric characters
  ];
  
  if (garbagePatterns.some(pattern => pattern.test(cleanText))) {
    return false;
  }
  
  // Check for reasonable word density
  const words = cleanText.split(/\s+/).filter(word => word.length > 2);
  const wordDensity = words.length / (cleanText.length / 100);
  
  return wordDensity > 5; // At least 5% of characters form meaningful words
}

export { 
  ocrImageBuffer, 
  extractTextFromPdfBuffer, 
  extractTextFromDocxBuffer,
  OCRProcessingError 
};