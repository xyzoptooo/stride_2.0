import { body, validationResult } from 'express-validator';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';

// Rate limiter for auth endpoints
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // limit each IP to 5 requests per windowMs
  message: 'Too many login attempts, please try again later'
});

// Security headers configuration
export const securityConfig = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      connectSrc: ["'self'", "https:", "wss:"],
      fontSrc: ["'self'", "data:", "https:"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'", "https:"],
      frameSrc: ["'self'"],
      formAction: ["'self'"],
      workerSrc: ["'self'", "blob:"],
    },
  },
  crossOriginEmbedderPolicy: false,
});

// Input validation middleware
const validateInput = (schema) => {
  return async (req, res, next) => {
    await Promise.all(schema.map(validation => validation.run(req)));
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    next();
  };
};

// Request sanitization
const sanitizeRequest = (req, res, next) => {
  // Sanitize body
  if (req.body) {
    for (let key in req.body) {
      if (typeof req.body[key] === 'string') {
        req.body[key] = req.body[key].trim();
      }
    }
  }
  // Sanitize query params
  if (req.query) {
    for (let key in req.query) {
      if (typeof req.query[key] === 'string') {
        req.query[key] = req.query[key].trim();
      }
    }
  }
  next();
};

// Error handling middleware
const errorHandler = (err, req, res, next) => {
  console.error(err.stack);
  
  // Handle mongoose validation errors
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      status: 'error',
      message: 'Validation Error',
      errors: Object.values(err.errors).map(e => e.message)
    });
  }

  // Handle MongoDB duplicate key errors
  if (err.code === 11000) {
    return res.status(409).json({
      status: 'error',
      message: 'Duplicate Entry',
      field: Object.keys(err.keyPattern)[0]
    });
  }

  // Handle JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      status: 'error',
      message: 'Invalid token'
    });
  }

  // Handle token expiration
  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({
      status: 'error',
      message: 'Token expired'
    });
  }

  // Default error
  return res.status(500).json({
    status: 'error',
    message: process.env.NODE_ENV === 'production' 
      ? 'Something went wrong' 
      : err.message
  });
};

// Request logging middleware
const requestLogger = (req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(
      `${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`
    );
  });
  next();
};

// Timeout middleware
const timeout = (seconds = 30) => {
  return (req, res, next) => {
    const timer = setTimeout(() => {
      next(new Error('Request timeout'));
    }, seconds * 1000);

    res.on('finish', () => {
      clearTimeout(timer);
    });
    
    next();
  };
};

export {
  validateInput,
  sanitizeRequest,
  errorHandler,
  requestLogger,
  timeout
};