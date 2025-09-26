// OCR engine for Academic Document Processing
// Handles images, PDFs, and DOCX with proper error handling, logging, and performance safeguards

import Tesseract from 'tesseract.js';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
// (No static import for file-type; use dynamic import below)
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
  // If extension is missing or not recognized, detect MIME type from buffer
  if (!fileExtension || !['pdf', 'docx', 'doc', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'tiff'].includes(fileExtension)) {
    let fileType;
    try {
      fileType = await import('file-type');
    } catch (err) {
      logger.error('Failed to import file-type:', err);
      throw new OCRProcessingError('Failed to import file-type', 'IMPORT_FAILED');
    }

    // Log the structure of the imported fileType module for debugging
    logger.info('fileType module typeof:', typeof fileType);
    logger.info('fileType module keys:', Object.keys(fileType));
    logger.info('fileType module inspect:', JSON.stringify(fileType, null, 2));
    if (fileType.default) {
      logger.info('fileType.default typeof:', typeof fileType.default);
      logger.info('fileType.default keys:', Object.keys(fileType.default));
      logger.info('fileType.default inspect:', JSON.stringify(fileType.default, null, 2));
    }

    let type = null;
    let signatureUsed = null;
    // Try all possible signatures for file-type
    if (typeof fileType.fromBuffer === 'function') {
      type = await fileType.fromBuffer(buffer);
      signatureUsed = 'fileType.fromBuffer';
    } else if (fileType.default && typeof fileType.default.fromBuffer === 'function') {
      type = await fileType.default.fromBuffer(buffer);
      signatureUsed = 'fileType.default.fromBuffer';
    } else if (typeof fileType.default === 'function') {
      type = await fileType.default(buffer);
      signatureUsed = 'fileType.default (function)';
    } else if (typeof fileType === 'function') {
      type = await fileType(buffer);
      signatureUsed = 'fileType (function)';
    } else {
      logger.error('No valid file-type signature found');
      throw new OCRProcessingError('file-type import signature not supported', 'FILE_TYPE_SIGNATURE');
    }
    logger.info(`file-type signature used: ${signatureUsed}`);
    logger.info(`Detected file type: ${type ? type.mime : 'unknown'}`);
    mimeType = type ? type.mime : null;
  } else {
    // Guess MIME type from extension
    const extToMime = {
      pdf: 'application/pdf',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      doc: 'application/msword',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      bmp: 'image/bmp',
      tiff: 'image/tiff',
    };
    mimeType = extToMime[fileExtension] || null;
  }

  if (!mimeType || !CONFIG.SUPPORTED_MIME_TYPES.has(mimeType)) {
    throw new OCRProcessingError(`Unsupported file type: ${mimeType || fileExtension}`, 'UNSUPPORTED_TYPE');
  }
  // Optionally return mimeType for downstream use
  return mimeType;
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
  OCRProcessingError 
};