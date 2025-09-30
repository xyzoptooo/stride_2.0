import rateLimit from 'express-rate-limit';
import { AppError } from './errorHandler';

export const limiter = rateLimit({
  max: 100, // Limit each IP to 100 requests per windowMs
  windowMs: 15 * 60 * 1000, // 15 minutes
  message: 'Too many requests from this IP, please try again later',
  handler: (req, res, next, options) => {
    next(new AppError('Too many requests from this IP, please try again later', 429));
  }
});

// Stricter limiter for auth endpoints
export const authLimiter = rateLimit({
  max: 5, // Limit each IP to 5 requests per windowMs
  windowMs: 15 * 60 * 1000, // 15 minutes
  message: 'Too many auth attempts from this IP, please try again later',
  handler: (req, res, next, options) => {
    next(new AppError('Too many auth attempts from this IP, please try again later', 429));
  }
});