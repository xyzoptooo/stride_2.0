import { isProduction } from '../config/environment.js';
import { logger } from '../utils/logger.js';

// Custom error class
export class AppError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
    this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error';
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

// Global error handler
export const globalErrorHandler = (err, req, res, next) => {
  // Ensure res.headersSent is checked first
  if (res.headersSent) {
    return next(err);
  }

  // Set response type to JSON
  res.setHeader('Content-Type', 'application/json');

  err.statusCode = err.statusCode || 500;
  err.status = err.status || 'error';

  if (!isProduction) {
    return res.status(err.statusCode).json({
      status: err.status,
      error: err,
      message: err.message,
      stack: err.stack,
      path: req.path
    });
  }

  // Production error handling
  if (err.isOperational) {
    return res.status(err.statusCode).json({
      status: err.status,
      message: err.message,
      path: req.path
    });
  }

  // Log unexpected errors with structured logging
  logger.error('Unhandled error occurred', {
    error: err,
    path: req.path,
    method: req.method,
    body: req.body,
    query: req.query,
    user: req.user?.supabaseId
  });
  
  // Send generic error message as JSON
  res.status(500).json({
    status: 'error',
    message: 'Something went wrong!'
  });
};

// Async error handler wrapper
export const catchAsync = fn => {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
};

// Not found error handler
export const notFound = (req, res, next) => {
  const err = new AppError(`Can't find ${req.originalUrl} on this server!`, 404);
  next(err);
};

// Validation error handler
export const handleValidationError = (err) => {
  const errors = Object.values(err.errors).map(el => el.message);
  const message = `Invalid input data. ${errors.join('. ')}`;
  return new AppError(message, 400);
};

// JWT error handler
export const handleJWTError = () => 
  new AppError('Invalid token. Please log in again!', 401);

// JWT expired error handler
export const handleJWTExpiredError = () => 
  new AppError('Your token has expired! Please log in again.', 401);