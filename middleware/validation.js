import { AppError } from './errorHandler.js';

// Generic validation function for required fields
const validateRequiredFields = (obj, fields) => {
  const missingFields = fields.filter(field => !obj[field]);
  if (missingFields.length > 0) {
    throw new AppError(`Missing required fields: ${missingFields.join(', ')}`, 400);
  }
};

// Phone number validation
const validatePhoneNumber = (phone) => {
  const phoneRegex = /^(?:254|\+254|0)?((?:7|1)[0-9]{8})$/;
  if (!phoneRegex.test(phone)) {
    throw new AppError('Invalid phone number format', 400);
  }
  return phone.replace(/^(?:\+?254|0)/, '254');
};

// Course validation middleware
export const validateCourse = (req, res, next) => {
  try {
    validateRequiredFields(req.body, ['name', 'code']);
    
    if (req.body.credits && typeof req.body.credits !== 'number') {
      throw new AppError('Credits must be a number', 400);
    }
    
    next();
  } catch (error) {
    next(error);
  }
};

// Assignment validation middleware
export const validateAssignment = (req, res, next) => {
  try {
    validateRequiredFields(req.body, ['title', 'courseId', 'dueDate']);
    
    if (new Date(req.body.dueDate).toString() === 'Invalid Date') {
      throw new AppError('Invalid due date format', 400);
    }
    
    if (req.body.points && typeof req.body.points !== 'number') {
      throw new AppError('Points must be a number', 400);
    }
    
    next();
  } catch (error) {
    next(error);
  }
};

// Note validation middleware
export const validateNote = (req, res, next) => {
  try {
    validateRequiredFields(req.body, ['title', 'content']);
    
    if (req.body.courseId && typeof req.body.courseId !== 'string') {
      throw new AppError('Course ID must be a string', 400);
    }
    
    next();
  } catch (error) {
    next(error);
  }
};

// Shared constants
const VALID_ACTIVITY_TYPES = ['study', 'practice', 'review', 'other'];
const VALID_PAYMENT_PLANS = ['monthly', 'yearly'];

// Activity validation middleware
export const validateActivity = (req, res, next) => {
  try {
    validateRequiredFields(req.body, ['courseId', 'duration', 'activityType']);
    
    if (typeof req.body.duration !== 'number' || req.body.duration <= 0) {
      throw new AppError('Duration must be a positive number', 400);
    }
    
    if (!VALID_ACTIVITY_TYPES.includes(req.body.activityType)) {
      throw new AppError('Invalid activity type', 400);
    }
    
    next();
  } catch (error) {
    next(error);
  }
};

// M-Pesa payment validation middleware
export const validateMpesaPayment = (req, res, next) => {
  try {
    validateRequiredFields(req.body, ['phone', 'amount', 'plan']);
    
    // Validate phone number
    req.body.phone = validatePhoneNumber(req.body.phone);
    
    // Validate amount
    if (typeof req.body.amount !== 'number' || req.body.amount <= 0) {
      throw new AppError('Amount must be a positive number', 400);
    }
    
    // Validate plan
    if (!VALID_PAYMENT_PLANS.includes(req.body.plan)) {
      throw new AppError('Invalid plan type. Must be either monthly or yearly', 400);
    }
    
    // Validate plan (already checked above, so these duplicate checks are removed)
    
    next();
  } catch (error) {
    next(error);
  }
};