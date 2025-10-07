// Core dependencies
import express from 'express';
import mongoose from 'mongoose';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import dotenv from 'dotenv';

// Security and optimization
import helmet from 'helmet';
import cors from 'cors';
import mongoSanitize from 'express-mongo-sanitize';
import xss from 'xss-clean';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import hpp from 'hpp';

// File handling
import multer from 'multer';

// External services
import axios from 'axios';

// Import models
import Course from './models/course.js';
import Assignment from './models/assignment.js';
import Activity from './models/activity.js';
import Note from './models/note.js';
import User from './models/user.js';
import MPesaTransaction from './models/mpesaTransaction.js';

// Import middleware
import { catchAsync } from './middleware/errorHandler.js';

// Import utilities
import { generateStudyPlan } from './utils/studyPlanGenerator.js';

// Load environment variables first
dotenv.config();

// Initialize express app
const app = express();

// Compatibility shim: if a newer app.js exists (exporting createApp), mount it so
// deployments that unknowingly start index.js (instead of app.js) still expose
// the routes and readiness endpoints implemented in app.js (for example /api/onboarding).
// This uses a dynamic import and is silent on failure.
try {
  // top-level await is supported in Node ESM; createApp returns an express app
  const mod = await import('./app.js');
  if (mod?.createApp && typeof mod.createApp === 'function') {
    try {
      const nestedApp = mod.createApp();
      // Mount the app at root so its /api/* routes are reachable
      app.use(nestedApp);
      console.log('Mounted app.js routes into index.js for compatibility');
    } catch (mountErr) {
      console.warn('Failed to mount app.js routes:', mountErr?.message || mountErr);
    }
  }
} catch (e) {
  // ignore - keep existing index.js behavior
}

// Temporary debug endpoint: list mounted routes for troubleshooting.
// Remove or restrict this endpoint before long-term production use.
app.get('/debug/routes', (req, res) => {
  try {
    const listRoutes = (expressApp) => {
      const routes = [];
      const stack = expressApp._router?.stack || [];
      stack.forEach((layer) => {
        if (layer.route && layer.route.path) {
          const methods = Object.keys(layer.route.methods || {}).join(',').toUpperCase();
          routes.push({ path: layer.route.path, methods });
        } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
          layer.handle.stack.forEach((l) => {
            if (l.route && l.route.path) {
              const methods = Object.keys(l.route.methods || {}).join(',').toUpperCase();
              routes.push({ path: l.route.path, methods });
            }
          });
        }
      });
      return routes;
    };

    const routes = listRoutes(app);
    return res.json({ ok: true, routes });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// Root route handler
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'Welcome to SemesterStride API',
    version: '1.0.0',
    documentation: '/api-docs',
    environment: process.env.NODE_ENV,
    timestamp: new Date().toISOString()
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'Server is running',
    uptime: process.uptime()
  });
});

// Connect to MongoDB
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/semesterstride';
mongoose.connect(MONGODB_URI)
  .then(() => console.log('MongoDB connected successfully'))
  .catch((err) => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });

// Authentication middleware
const authenticate = catchAsync(async (req, res, next) => {
  // Get token from header
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

  // If no token, allow request to proceed (optional auth)
  if (!token) {
    console.warn('No authentication token provided, proceeding without auth');
    req.user = null;
    return next();
  }

  try {
    // Verify token
    const user = await verifySupabaseToken(token);
    
    // Check if supabaseId in request matches token
    const requestSupabaseId = req.body.supabaseId || req.query.supabaseId || req.params.supabaseId || req.query.user_id;
    if (requestSupabaseId && requestSupabaseId !== user.id) {
      console.warn('supabaseId mismatch:', { requested: requestSupabaseId, tokenUser: user.id });
      // Allow it but log warning - don't block the request
    }

    // Attach user to request
    req.user = user;
    next();
  } catch (error) {
    // Log error but allow request to proceed
    console.error('Authentication error:', error.message);
    req.user = null;
    next();
  }
});

// Initialize middleware
app.use(helmet());
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(mongoSanitize());
app.use(xss());
app.use(hpp());

// CORS configuration
const corsOptions = {
  origin: (origin, callback) => {
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').concat([
      'http://localhost:5173',
      'http://localhost:8080',
      'http://localhost:3000',
      'https://stride-2-0.vercel.app',
      'https://www.semesterstride.app',
      'https://semesterstride.app',
      'https://semester-stride-planner.vercel.app'
    ]);
    // Remove any empty strings from the array, just in case
    const filteredOrigins = allowedOrigins.filter(Boolean);
    if (!origin || filteredOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
  maxAge: 600 // 10 minutes
};
app.use(cors(corsOptions));

// Rate Limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Study plan route handler
app.post('/api/study-plan/generate', authenticate, catchAsync(async (req, res) => {
  const { supabaseId } = req.user;
  
  // Fetch user's courses, assignments and activities
  const [courses, assignments, activities] = await Promise.all([
    Course.find({ userId: supabaseId }),
    Assignment.find({ userId: supabaseId }),
    Activity.find({ userId: supabaseId })
  ]);

  // Generate personalized study plan
  const studyPlan = await generateStudyPlan(courses, assignments, activities, req.body.preferences);

  res.status(200).json({
    status: 'success',
    data: studyPlan
  });
}));

// Utils and helpers
import { healthCheck } from './utils/healthCheck.js';
import { logger } from './utils/logger.js';
import { sanitizeRequest } from './middleware/security.js';

// Get current file path and directory (ES module equivalent of __filename and __dirname)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Port configuration
const PORT = process.env.PORT || 3000;

// Import configurations
import { env, validateEnv, isProduction } from './config/environment.js';
import { AppError, globalErrorHandler, notFound } from './middleware/errorHandler.js';

// In-memory stores for application state
// Cache for study recommendations to reduce API calls
// Store for tracking M-Pesa payment status during processing
// Server instance reference for graceful shutdown
let server;
import { 
  validateCourse, 
  validateAssignment, 
  validateNote, 
  validateActivity, 
  validateMpesaPayment 
} from './middleware/validation.js';

// Validate all required environment variables
try {
  validateEnv();
} catch (err) {
  logger.error('Environment validation failed:', { error: err.message });
  process.exit(1);
}

// Using imported globalErrorHandler for error handling middleware

// Security configurations

// Rate limiting configurations

// Auth limiter is defined later with createRateLimiter

// Security middleware configuration has been moved to app.use() calls

// MPesa Helper Functions


// In-memory payment status store (replace with database in production)
// Payment status is tracked in paymentStatusStore Map defined above

// Environment variables are validated by validateEnv() at startup

// Utility to verify Supabase JWT token
const verifySupabaseToken = async (token) => {
  if (!token) {
    throw new AppError('No token provided', 401);
  }

  try {
    // Add timeout to prevent hanging
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout
    
    const response = await axios.get(`https://${env.SUPABASE_PROJECT_ID}.supabase.co/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': env.SUPABASE_SERVICE_KEY
      },
      signal: controller.signal,
      timeout: 5000
    });
    
    clearTimeout(timeoutId);
    return response.data;
  } catch (error) {
    if (error.code === 'ECONNABORTED' || error.name === 'AbortError') {
      console.warn('Token verification timed out');
      throw new AppError('Authentication service timeout', 503);
    }
    console.error('Token verification error:', error.message);
    throw new AppError('Invalid or expired token', 401);
  }
};

// Using imported AppError and globalErrorHandler from middleware/errorHandler.js

// Using imported AppError and globalErrorHandler



// Data relationship validation utilities
const validateCourseOwnership = async (courseId, supabaseId) => {
  const course = await Course.findOne({ _id: courseId, supabaseId });
  if (!course) {
    throw new AppError('Course not found or unauthorized', 404);
  }
  return course;
};




// Initialize multer for file uploads
const upload = multer({
  dest: `${__dirname}/uploads`, // Store uploaded files in an uploads directory
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB file size limit
  }
});

// Environment variables already configured above

// Trust proxy for Vercel deployment
app.set('trust proxy', 1);

// Apply security middleware with enhanced CSP
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'https://api.openai.com', `https://${process.env.SUPABASE_PROJECT_ID}.supabase.co`]
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }
})); // Set security HTTP headers

// Rate limiting middleware with Redis store for distributed systems
const createRateLimiter = (maxRequests, windowMinutes, errorMessage) => rateLimit({
  max: maxRequests,
  windowMs: windowMinutes * 60 * 1000,
  message: { status: 'error', message: errorMessage || 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'development',
  keyGenerator: (req) => {
    // Use both IP and user ID (if available) to prevent user-specific abuse
    return req.user ? `${req.ip}-${req.user.id}` : req.ip;
  }
});

// Define different rate limits for different routes
const authLimiter = createRateLimiter(20, 15, 'Too many authentication attempts');
const apiLimiter = createRateLimiter(100, 15, 'Too many API requests');
const uploadLimiter = createRateLimiter(10, 15, 'Too many file uploads');
const mpesaLimiter = createRateLimiter(5, 15, 'Too many payment attempts');
const searchLimiter = createRateLimiter(30, 15, 'Too many search requests');

// Apply limiters globally
app.use('/api/auth', authLimiter);
app.use('/api/syllabus/import', uploadLimiter);
app.use('/api/payments', mpesaLimiter);
app.use('/api/search', searchLimiter);
app.use('/api', apiLimiter);

// Rate limiting is already configured above

// CSRF protection (only for browsers)
const csrfProtection = (req, res, next) => {
  // Skip for non-browser requests
  if (!req.headers['user-agent']?.toLowerCase().includes('mozilla')) {
    return next();
  }

  // Check origin header
  // Allow preflight requests through without CSRF checks
  if (req.method === 'OPTIONS') return next();

  const origin = req.headers.origin;
  const allowedOrigins = ['http://localhost:5173', 'https://stride-2-0.vercel.app', 'https://www.semesterstride.app', 'https://semesterstride.app'];

  if (req.method !== 'GET' && (!origin || !allowedOrigins.includes(origin))) {
    return next(new AppError('Invalid origin', 403));
  }
  
  next();
};

// Apply CSRF protection to all routes
app.use(csrfProtection);

// Import security middleware
import {
  validateInput,
  requestLogger,
  timeout
} from './middleware/security.js';

// Request logging in non-production
if (process.env.NODE_ENV !== 'production') {
  app.use(requestLogger);
}

// Global timeout of 30 seconds
app.use(timeout(30));

// Body parsing with size limits
app.use(express.json({ 
  limit: '10kb',
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// Request sanitization middleware is imported from './middleware/security.js'

// Apply request sanitization middleware
app.use(sanitizeRequest);

// Security middleware has already been initialized earlier

// Apply request validation middleware
app.use((req, res, next) => {
  // Validate request size
  const contentLength = parseInt(req.headers['content-length'] || 0);
  if (contentLength > 10 * 1024 * 1024) { // 10MB limit
    return next(new AppError('Request too large', 413));
  }
  
  // Validate content type for POST/PUT requests
  if (req.method === 'POST' || req.method === 'PUT') {
    const contentType = (req.headers['content-type'] || '').toLowerCase();

    // Allow JSON, multipart uploads, PDFs, images, and common Word document types
    const isJson = contentType.includes('application/json');
    const isMultipart = contentType.startsWith('multipart/');
    const isPdf = contentType.includes('application/pdf');
    const isImage = contentType.startsWith('image/');
    const isWord = contentType.includes('application/msword') || contentType.includes('vnd.openxmlformats-officedocument');

    if (!contentType || !(isJson || isMultipart || isPdf || isImage || isWord)) {
      return next(new AppError('Invalid content type', 415));
    }
  }
  
  next();
});

// CORS configuration is handled at the top of the file

app.use(cors(corsOptions));

// Enable gzip compression
app.use(compression());

// Trust proxy is already set above

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info('Request completed', {
      method: req.method,
      url: req.url,
      statusCode: res.statusCode,
      duration,
      ip: req.ip,
      userAgent: req.headers['user-agent']
    });
  });
  next();
});

// Connect to MongoDB with retry logic
const connectWithRetry = async (retries = 5, delay = 5000) => {
  for (let i = 0; i < retries; i++) {
    try {
      await mongoose.connect(env.MONGODB_URI, {
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
        maxPoolSize: 10,
        retryWrites: true,
        w: 'majority'
      });
      logger.info(`MongoDB connected successfully to ${env.MONGODB_URI.split('@')[1]}`); // Log connection without credentials
      return;
    } catch (err) {
      logger.error(`MongoDB connection attempt ${i + 1} failed:`, { error: err });
      if (i < retries - 1) {
        logger.info(`Retrying MongoDB connection in ${delay/1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        logger.error('Failed to connect to MongoDB after multiple attempts');
        process.exit(1);
      }
    }
  }
};

connectWithRetry();

// --- Syllabus import endpoint (file upload) ---
// Syllabus import endpoint now uses GPT-5 Vision for analyzing documents
app.post('/api/syllabus/import', authenticate, uploadLimiter, upload.single('file'), catchAsync(async (req, res) => {
  console.log('--- /api/syllabus/import called ---');
  
  if (!req.file) {
    throw new AppError('No file uploaded', 400);
  }

  // Validate file size
  const maxSize = 10 * 1024 * 1024; // 10MB
  if (req.file.size > maxSize) {
    throw new AppError('File too large. Maximum size is 10MB', 400);
  }
  
  logger.info('File received:', { filename: req.file.originalname, mimetype: req.file.mimetype, size: req.file.size });
  
  // Validate file type
  const allowedMimeTypes = ['application/pdf', 'image/jpeg', 'image/png'];
  if (!allowedMimeTypes.includes(req.file.mimetype)) {
    throw new AppError('Invalid file type. Only PDF, JPEG, and PNG files are allowed.', 400);
  }
  
  // Encode file as base64
  const fileBase64 = Buffer.from(req.file.buffer).toString('base64');

  // Call GPT-5 API for syllabus analysis
  const response = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4-vision-preview',
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'You are an expert academic assistant. Analyze this document and extract all academic information in JSON format. Include:\n\n1. Course details (name, code, professor)\n2. Assignments with due dates\n3. Important deadlines\n4. Required materials\n\nReturn ONLY a JSON object with no additional text.'
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
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.data.choices || !response.data.choices[0]?.message?.content) {
    throw new AppError('Invalid response from GPT-5', 500);
  }

  try {
    // Parse the extracted text as JSON
    const extractedData = JSON.parse(response.data.choices[0].message.content);
    res.status(200).json({
      status: 'success',
      data: {
        source: 'gpt-5-vision',
        extracted: extractedData
      }
    });
  } catch (parseError) {
    throw new AppError('Failed to parse syllabus data as JSON', 500);
  }
}));

// Error handling is applied at the end of the file

// User routes
app.post('/api/users', authenticate, catchAsync(async (req, res) => {
  const { supabaseId, email } = req.body;
  
  if (!supabaseId) {
    throw new AppError('Missing supabaseId', 400);
  }
  
  // Check if user already exists
  const existingUser = await User.findOne({ supabaseId });
  if (existingUser) {
    throw new AppError('User already exists', 409);
  }
  
  const user = await User.create({
    supabaseId,
    email,
    createdAt: new Date(),
    updatedAt: new Date()
  });
  
  res.status(201).json({
    status: 'success',
    data: { user }
  });
}));

app.get('/api/users/:supabaseId', authenticate, catchAsync(async (req, res) => {
  const { supabaseId } = req.params;
  
  if (!supabaseId || typeof supabaseId !== 'string' || supabaseId.length < 8) {
    throw new AppError('Invalid supabaseId', 400);
  }
  
  const user = await User.findOne({ supabaseId });
  if (!user) {
    throw new AppError('User not found', 404);
  }
  
  res.status(200).json({
    status: 'success',
    data: { user }
  });
}));

// Course routes
app.post('/api/courses', authenticate, validateCourse, catchAsync(async (req, res) => {
  logger.info('Creating new course', { userId: req.user.supabaseId });
  const { supabaseId, name, code, instructor } = req.body;
  
  if (!supabaseId || !name) {
    throw new AppError('Missing required fields: supabaseId and name', 400);
  }
  
  // Validate if user exists
  const user = await User.findOne({ supabaseId });
  if (!user) {
    throw new AppError('User not found', 404);
  }
  
  const course = await Course.create({
    supabaseId,
    name,
    code,
    instructor,
    createdAt: new Date(),
    updatedAt: new Date()
  });
  
  res.status(201).json({
    status: 'success',
    data: { course }
  });
}));

app.get('/api/courses', authenticate, catchAsync(async (req, res) => {
  const { user_id } = req.query;
  
  if (!user_id || typeof user_id !== 'string' || user_id.length < 8) {
    throw new AppError('Invalid user_id parameter', 400);
  }
  
  // Verify user is requesting their own data
  if (user_id !== req.user.supabaseId) {
    throw new AppError('Unauthorized: Cannot access other users\' data', 403);
  }
  
  const courses = await Course.find({ supabaseId: user_id }).sort({ createdAt: -1 });
  
  res.status(200).json({
    status: 'success',
    data: courses
  });
}));

app.put('/api/courses/:id', authenticate, catchAsync(async (req, res) => {
  const { id } = req.params;
  const updates = req.body;
  
  // Validate course exists
  const course = await Course.findById(id);
  if (!course) {
    throw new AppError('Course not found', 404);
  }
  
  // Validate user owns the course
  if (updates.supabaseId && updates.supabaseId !== course.supabaseId) {
    throw new AppError('Unauthorized: Cannot change course ownership', 403);
  }
  
  const updatedCourse = await Course.findByIdAndUpdate(
    id,
    { ...updates, updatedAt: new Date() },
    { new: true, runValidators: true }
  );
  
  res.status(200).json({
    status: 'success',
    data: { course: updatedCourse }
  });
}));

app.delete('/api/courses/:id', authenticate, catchAsync(async (req, res) => {
  logger.info('Deleting course', { courseId: req.params.id, userId: req.user.supabaseId });
  const { id } = req.params;
  const { supabaseId } = req.query;
  
  if (!supabaseId) {
    throw new AppError('Missing supabaseId', 400);
  }
  
  // Validate course exists and user owns it
  const course = await Course.findOne({ _id: id, supabaseId });
  if (!course) {
    throw new AppError('Course not found or unauthorized', 404);
  }
  
  await Course.findByIdAndDelete(id);
  
  res.status(200).json({
    status: 'success',
    message: 'Course deleted successfully'
  });
}));

// Assignment routes
app.post('/api/assignments', authenticate, validateAssignment, catchAsync(async (req, res) => {
  logger.info('Creating new assignment', { userId: req.user.supabaseId });
  const { supabaseId, title, dueDate, course, description } = req.body;
  
  if (!supabaseId || !title) {
    throw new AppError('Missing required fields: supabaseId and title', 400);
  }
  
  // Validate if user exists
  const user = await User.findOne({ supabaseId });
  if (!user) {
    throw new AppError('User not found', 404);
  }
  
  // Validate dueDate if provided
  if (dueDate && new Date(dueDate).toString() === 'Invalid Date') {
    throw new AppError('Invalid due date format', 400);
  }
  
  // Validate course if provided
  if (course) {
    const courseExists = await Course.findOne({ _id: course, supabaseId });
    if (!courseExists) {
      throw new AppError('Course not found', 404);
    }
  }
  
  const assignment = await Assignment.create({
    supabaseId,
    title,
    dueDate,
    course,
    description,
    progress: 0,
    createdAt: new Date(),
    updatedAt: new Date()
  });
  
  res.status(201).json({
    status: 'success',
    data: { assignment }
  });
}));

app.get('/api/assignments/:supabaseId', authenticate, catchAsync(async (req, res) => {
  const { supabaseId } = req.params;
  const { course, status } = req.query;
  
  if (!supabaseId || typeof supabaseId !== 'string' || supabaseId.length < 8) {
    throw new AppError('Invalid supabaseId', 400);
  }
  
  // Verify user is requesting their own data
  if (supabaseId !== req.user.id) {
    throw new AppError('Unauthorized: Cannot access other users\' data', 403);
  }
  
  // Build query
  const query = { supabaseId };
  if (course) {
    // Verify course belongs to user
    await validateCourseOwnership(course, supabaseId);
    query.course = course;
  }
  if (status === 'completed') query.progress = 100;
  if (status === 'pending') query.progress = { $lt: 100 };
  
  const assignments = await Assignment.find(query)
    .sort({ dueDate: 1, createdAt: -1 })
    .populate('course', 'name');
  
  res.status(200).json({
    status: 'success',
    results: assignments.length,
    data: { assignments }
  });
}));

app.put('/api/assignments/:id', authenticate, catchAsync(async (req, res) => {
  const { id } = req.params;
  const updates = req.body;
  
  // Validate assignment exists
  const assignment = await Assignment.findById(id);
  if (!assignment) {
    throw new AppError('Assignment not found', 404);
  }
  
  // Validate user owns the assignment
  if (updates.supabaseId && updates.supabaseId !== assignment.supabaseId) {
    throw new AppError('Unauthorized: Cannot change assignment ownership', 403);
  }
  
  // Validate date if provided
  if (updates.dueDate && new Date(updates.dueDate).toString() === 'Invalid Date') {
    throw new AppError('Invalid due date format', 400);
  }
  
  const updatedAssignment = await Assignment.findByIdAndUpdate(
    id,
    { ...updates, updatedAt: new Date() },
    { new: true, runValidators: true }
  );
  
  res.status(200).json({
    status: 'success',
    data: { assignment: updatedAssignment }
  });
}));

app.delete('/api/assignments/:id', authenticate, catchAsync(async (req, res) => {
  const { id } = req.params;
  const { supabaseId } = req.query;
  
  if (!supabaseId) {
    throw new AppError('Missing supabaseId', 400);
  }
  
  // Validate assignment exists and user owns it
  const assignment = await Assignment.findOne({ _id: id, supabaseId });
  if (!assignment) {
    throw new AppError('Assignment not found or unauthorized', 404);
  }
  
  await Assignment.findByIdAndDelete(id);
  
  res.status(200).json({
    status: 'success',
    message: 'Assignment deleted successfully'
  });
}));

// Note routes
app.post('/api/notes', authenticate, validateNote, catchAsync(async (req, res) => {
  const { supabaseId, title, content, tags = [], course } = req.body;
  
  if (!supabaseId || !content) {
    throw new AppError('Missing required fields: supabaseId and content', 400);
  }
  
  // Validate if user exists
  const user = await User.findOne({ supabaseId });
  if (!user) {
    throw new AppError('User not found', 404);
  }
  
  // Validate course if provided
  if (course) {
    const courseExists = await Course.findOne({ _id: course, supabaseId });
    if (!courseExists) {
      throw new AppError('Course not found', 404);
    }
  }
  
  // Validate tags
  if (!Array.isArray(tags)) {
    throw new AppError('Tags must be an array', 400);
  }
  
  const note = await Note.create({
    supabaseId,
    title: title || 'Untitled',
    content,
    tags,
    course,
    createdAt: new Date(),
    updatedAt: new Date()
  });
  
  res.status(201).json({
    status: 'success',
    data: { note }
  });
}));

app.get('/api/notes/:supabaseId', authenticate, catchAsync(async (req, res) => {
  const { supabaseId } = req.params;
  const { course, tag } = req.query;
  
  if (!supabaseId || typeof supabaseId !== 'string' || supabaseId.length < 8) {
    throw new AppError('Invalid supabaseId', 400);
  }
  
  // Build query
  const query = { supabaseId };
  if (course) query.course = course;
  if (tag) query.tags = tag;
  
  const notes = await Note.find(query)
    .sort({ updatedAt: -1 })
    .populate('course', 'name');
  
  res.status(200).json({
    status: 'success',
    results: notes.length,
    data: { notes }
  });
}));

app.put('/api/notes/:id', authenticate, catchAsync(async (req, res) => {
  const { id } = req.params;
  const updates = req.body;
  
  // Validate note exists
  const note = await Note.findById(id);
  if (!note) {
    throw new AppError('Note not found', 404);
  }
  
  // Validate user owns the note
  if (updates.supabaseId && updates.supabaseId !== note.supabaseId) {
    throw new AppError('Unauthorized: Cannot change note ownership', 403);
  }
  
  // Validate tags if provided
  if (updates.tags && !Array.isArray(updates.tags)) {
    throw new AppError('Tags must be an array', 400);
  }
  
  // Validate course if provided
  if (updates.course) {
    const courseExists = await Course.findOne({ _id: updates.course, supabaseId: note.supabaseId });
    if (!courseExists) {
      throw new AppError('Course not found', 404);
    }
  }
  
  const updatedNote = await Note.findByIdAndUpdate(
    id,
    { ...updates, updatedAt: new Date() },
    { new: true, runValidators: true }
  );
  
  res.status(200).json({
    status: 'success',
    data: { note: updatedNote }
  });
}));

app.delete('/api/notes/:id', authenticate, catchAsync(async (req, res) => {
  const { id } = req.params;
  const { supabaseId } = req.query;
  
  if (!supabaseId) {
    throw new AppError('Missing supabaseId', 400);
  }
  
  // Validate note exists and user owns it
  const note = await Note.findOne({ _id: id, supabaseId });
  if (!note) {
    throw new AppError('Note not found or unauthorized', 404);
  }
  
  await Note.findByIdAndDelete(id);
  
  res.status(200).json({
    status: 'success',
    message: 'Note deleted successfully'
  });
}));

// Recommendations endpoint
app.post('/api/recommendations', authenticate, catchAsync(async (req, res) => {
  logger.info('Generating recommendations', { userId: req.body.supabaseId });
  const { supabaseId } = req.body;
  
  if (!supabaseId) {
    throw new AppError('Missing supabaseId', 400);
  }
  
  // Get user's courses
  const courses = await Course.find({ supabaseId });
  if (!courses.length) {
    return res.status(200).json({
      status: 'success',
      data: {
        recommendations: ['Add courses to get personalized recommendations.']
      }
    });
  }
  
  // Get user's study activities
  const activities = await Activity.find({
    supabaseId,
    type: 'study_session',
    timestamp: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } // Last 30 days
  });
  
  // Get assignments
  const assignments = await Assignment.find({ supabaseId, dueDate: { $exists: true } });
  
  // Generate recommendations based on study patterns and upcoming assignments
  const recommendations = [];
  
  // Check for courses without recent study sessions
  const coursesWithoutStudy = courses.filter(course => 
    !activities.some(activity => activity.course?.toString() === course._id.toString())
  );
  if (coursesWithoutStudy.length) {
    recommendations.push(`Consider studying ${coursesWithoutStudy.map(c => c.name).join(', ')} - no recent study sessions recorded.`);
  }
  
  // Check for upcoming assignments
  const upcomingAssignments = assignments.filter(a => 
    new Date(a.dueDate) > new Date() && 
    new Date(a.dueDate) <= new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  );
  if (upcomingAssignments.length) {
    recommendations.push(`You have ${upcomingAssignments.length} assignments due in the next week. Plan your study time accordingly.`);
  }
  
  // Add general recommendations
  if (!activities.length) {
    recommendations.push('Start logging your study sessions to get personalized study recommendations.');
  }
  
  res.status(200).json({
    status: 'success',
    data: {
      recommendations: recommendations.length ? recommendations : ['Keep up the good work! No specific recommendations at this time.']
    }
  });
}));

// Activity routes
app.post('/api/activities', authenticate, validateActivity, catchAsync(async (req, res) => {
  logger.info('Recording new activity', { userId: req.user.supabaseId, type: req.body.type });
  const { supabaseId, type, courseName, details, duration } = req.body;
  
  if (!supabaseId || !type) {
    throw new AppError('Missing required fields: supabaseId and type', 400);
  }
  
  // Validate activity type
  const validTypes = ['study_session', 'note_add', 'assignment_add', 'course_add'];
  if (!validTypes.includes(type)) {
    throw new AppError('Invalid activity type', 400);
  }
  
  // Validate course name if provided
  let course = null;
  if (courseName) {
    course = await Course.findOne({ supabaseId, name: courseName });
    if (!course) {
      throw new AppError('Course not found', 404);
    }
  }
  
  const activity = await Activity.create({
    supabaseId,
    type,
    course: course?._id,
    details,
    duration,
    timestamp: new Date(),
    createdAt: new Date(),
    updatedAt: new Date()
  });
  
  res.status(201).json({
    status: 'success',
    data: { activity }
  });
}));

// Get activities
// Activities route is defined later in the file

app.get('/api/activities/:supabaseId', authenticate, catchAsync(async (req, res) => {
  const { supabaseId } = req.params;
  const { type, startDate, endDate, course } = req.query;
  
  if (!supabaseId || typeof supabaseId !== 'string' || supabaseId.length < 8) {
    throw new AppError('Invalid supabaseId', 400);
  }
  
  // Build query
  const query = { supabaseId };
  if (type) query.type = type;
  if (course) query.course = course;
  
  // Date range filter
  if (startDate || endDate) {
    query.timestamp = {};
    if (startDate) query.timestamp.$gte = new Date(startDate);
    if (endDate) query.timestamp.$lte = new Date(endDate);
  }
  
  const activities = await Activity.find(query)
    .sort({ timestamp: -1 })
    .limit(100)
    .populate('course', 'name');
  
  // Format activities for frontend
  const formattedActivities = activities.map(activity => ({
    id: activity._id,
    title: activity.type === 'study_session' ? `Study: ${activity.course?.name || 'General'}` : activity.details,
    startsAt: activity.timestamp,
    endsAt: activity.type === 'study_session' ? 
      new Date(new Date(activity.timestamp).getTime() + (activity.duration || 0) * 60000).toISOString() :
      activity.timestamp,
    type: activity.type,
    course: activity.course,
    details: activity.details,
    duration: activity.duration
  }));
  
  res.status(200).json({
    status: 'success',
    results: formattedActivities.length,
    data: formattedActivities
  });
}));

app.put('/api/activities/:id', authenticate, catchAsync(async (req, res) => {
  const { id } = req.params;
  const updates = req.body;
  
  // Validate activity exists
  const activity = await Activity.findById(id);
  if (!activity) {
    throw new AppError('Activity not found', 404);
  }
  
  // Validate user owns the activity
  if (updates.supabaseId && updates.supabaseId !== activity.supabaseId) {
    throw new AppError('Unauthorized: Cannot change activity ownership', 403);
  }
  
  // Validate course if provided
  if (updates.course) {
    const courseExists = await Course.findOne({ _id: updates.course, supabaseId: activity.supabaseId });
    if (!courseExists) {
      throw new AppError('Course not found', 404);
    }
  }
  
  // Validate duration if provided
  if (updates.duration !== undefined && updates.duration < 0) {
    throw new AppError('Duration cannot be negative', 400);
  }
  
  const updatedActivity = await Activity.findByIdAndUpdate(
    id,
    { ...updates, updatedAt: new Date() },
    { new: true, runValidators: true }
  );
  
  res.status(200).json({
    status: 'success',
    data: { activity: updatedActivity }
  });
}));

app.delete('/api/activities/:id', authenticate, catchAsync(async (req, res) => {
  const { id } = req.params;
  const { supabaseId } = req.query;
  
  if (!supabaseId) {
    throw new AppError('Missing supabaseId', 400);
  }
  
  // Validate activity exists and user owns it
  const activity = await Activity.findOne({ _id: id, supabaseId });
  if (!activity) {
    throw new AppError('Activity not found or unauthorized', 404);
  }
  
  await Activity.findByIdAndDelete(id);
  
  res.status(200).json({
    status: 'success',
    message: 'Activity deleted successfully'
  });
}));

// Mindmap endpoint to get course relationships and connections
app.get('/api/mindmap', authenticate, catchAsync(async (req, res) => {
  const { supabaseId } = req.user;
  if (!supabaseId) {
    throw new AppError('User ID is required', 400);
  }

  // Get user's courses
  const courses = await Course.find({ supabaseId });
  
  // Get all assignments to analyze relationships
  const assignments = await Assignment.find({ supabaseId });
  
  // Get all notes to analyze relationships
  const notes = await Note.find({ supabaseId });

  // Create nodes for each course
  const nodes = courses.map(course => ({
    id: course._id.toString(),
    label: course.name,
    type: 'course',
    data: {
      code: course.code,
      description: course.description,
      credits: course.credits
    }
  }));

  // Create edges based on related assignments and notes
  const edges = [];
  
  // Add edges between courses that share similar topics or have related assignments
  courses.forEach((course1, i) => {
    courses.slice(i + 1).forEach(course2 => {
      // Check for related assignments
      const relatedAssignments = assignments.filter(assignment =>
        assignment.relatedCourses?.includes(course1._id) &&
        assignment.relatedCourses?.includes(course2._id)
      );

      // Check for related notes
      const relatedNotes = notes.filter(note =>
        note.relatedCourses?.includes(course1._id) &&
        note.relatedCourses?.includes(course2._id)
      );

      if (relatedAssignments.length > 0 || relatedNotes.length > 0) {
        edges.push({
          source: course1._id.toString(),
          target: course2._id.toString(),
          label: `${relatedAssignments.length} shared assignments, ${relatedNotes.length} shared notes`,
          weight: relatedAssignments.length + relatedNotes.length
        });
      }
    });
  });

  res.json({ nodes, edges });
}));

// M-Pesa STK Push endpoint
app.post('/api/mpesa/stkpush', authenticate, validateMpesaPayment, catchAsync(async (req, res) => {
  const { phone, amount, plan } = req.body;
  const { supabaseId } = req.user;

  // Format phone number to required format (254XXXXXXXXX)
  const formattedPhone = phone.replace(/^(?:\+?254|0)/, '254');

  try {
    // Generate timestamp
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, -3);
    const shortcode = env.MPESA_SHORTCODE;
    const passkey = env.MPESA_PASSKEY;

    // Generate password
    const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');

    // Make request to M-Pesa API
    const response = await axios.post(
      'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
      {
        BusinessShortCode: shortcode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: amount,
        PartyA: formattedPhone,
        PartyB: shortcode,
        PhoneNumber: formattedPhone,
        CallBackURL: `${env.API_URL}/api/mpesa/callback`,
        AccountReference: `SemesterStride-${plan}`,
        TransactionDesc: `SemesterStride ${plan} Plan`
      },
      {
        headers: {
          'Authorization': `Bearer ${env.MPESA_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    // Save transaction details to database
    const transaction = new MPesaTransaction({
      supabaseId,
      phone: formattedPhone,
      amount,
      plan,
      checkoutRequestId: response.data.CheckoutRequestID,
      merchantRequestId: response.data.MerchantRequestID,
      status: 'pending'
    });
    await transaction.save();

    res.json({
      success: true,
      checkoutRequestId: response.data.CheckoutRequestID
    });
  } catch (error) {
    logger.error('M-Pesa API Error:', { error: error.response?.data || error.message });
    throw new AppError('Failed to initiate payment', 500);
  }
}));

// M-Pesa status check endpoint
app.get('/api/mpesa/status', authenticate, catchAsync(async (req, res) => {
  const { phone, plan } = req.query;
  const { supabaseId } = req.user;
  
  if (!phone || !plan) {
    throw new AppError('Phone and plan are required', 400);
  }
  
  // Validate phone number format (Kenyan format)
  const phoneRegex = /^(?:254|\+254|0)?((?:7|1)[0-9]{8})$/;
  if (!phoneRegex.test(phone)) {
    throw new AppError('Invalid phone number format', 400);
  }

  // Format phone number
  const formattedPhone = phone.replace(/^(?:\+?254|0)/, '254');

  // Find latest transaction for this user, phone and plan
  const transaction = await MPesaTransaction.findOne({
    supabaseId,
    phone: formattedPhone,
    plan
  }).sort({ createdAt: -1 });

  if (!transaction) {
    throw new AppError('No transaction found', 404);
  }

  res.json({
    success: true,
    status: transaction.status,
    transactionId: transaction.transactionId,
    completedAt: transaction.completedAt
  });
}));

// Study planning endpoint
app.get('/api/plan', authenticate, catchAsync(async (req, res) => {
  const { userId } = req.query;
  
  if (!userId) {
    throw new AppError('Missing userId', 400);
  }

  // Get user's courses, assignments and activities
  const courses = await Course.find({ supabaseId: userId });
  const assignments = await Assignment.find({ 
    supabaseId: userId,
    dueDate: { $exists: true }
  });
  
  // Get recent study activities - last 7 days
  const activities = await Activity.find({
    supabaseId: userId,
    type: 'study_session',
    timestamp: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
  }).sort({ timestamp: -1 });

  // Generate personalized study plan
  const plan = await generateStudyPlan(courses, assignments, activities);

  res.status(200).json({
    status: 'success',
    data: { plan }
  });
}));



// M-Pesa routes moved to a more robust implementation with validation above
// Health check endpoint
app.get('/health', catchAsync(async (req, res) => {
  const health = await healthCheck();
  const statusCode = health.healthy ? 200 : 503;
  
  res.status(statusCode).json(health);
}));

// Study data endpoint
app.get('/api/study-data/:supabaseId', authenticate, catchAsync(async (req, res) => {
  const { supabaseId } = req.params;
  const { startDate, endDate } = req.query;

  // Build date range query
  const dateQuery = {};
  if (startDate) dateQuery.$gte = new Date(startDate);
  if (endDate) dateQuery.$lte = new Date(endDate);

  // Get study sessions
  const studySessions = await Activity.find({
    supabaseId,
    type: 'study_session',
    ...(Object.keys(dateQuery).length && { timestamp: dateQuery })
  }).populate('course', 'name');

  // Aggregate study time by course
  const studyData = studySessions.reduce((acc, session) => {
    const courseName = session.course?.name || 'General';
    if (!acc[courseName]) {
      acc[courseName] = {
        totalMinutes: 0,
        sessions: 0
      };
    }
    acc[courseName].totalMinutes += session.duration || 0;
    acc[courseName].sessions += 1;
    return acc;
  }, {});

  res.status(200).json({
    status: 'success',
    data: studyData
  });
}));

// Analytics endpoints
app.get('/api/analytics/study-time/:supabaseId', authenticate, catchAsync(async (req, res) => {
  const { supabaseId } = req.params;
  const { startDate, endDate } = req.query;
  
  // Build date range
  const dateQuery = {};
if (startDate) dateQuery.$gte = new Date(startDate);
if (endDate) dateQuery.$lte = new Date(endDate);  // Get study sessions
  const studySessions = await Activity.find({
    supabaseId,
    type: 'study_session',
    ...(Object.keys(dateQuery).length && { timestamp: dateQuery })
  }).populate('course', 'name');
  
  // Aggregate study time by course
  const studyTimeByCourse = studySessions.reduce((acc, session) => {
    const courseName = session.course?.name || 'General';
    if (!acc[courseName]) {
      acc[courseName] = {
        totalMinutes: 0,
        sessions: 0
      };
    }
    acc[courseName].totalMinutes += session.duration || 0;
    acc[courseName].sessions += 1;
    return acc;
  }, {});

  res.status(200).json({
    status: 'success',
    data: studyTimeByCourse
  });
}));

app.get('/api/analytics/progress/:supabaseId', authenticate, catchAsync(async (req, res) => {
  const { supabaseId } = req.params;
  
  // Get all assignments
  const assignments = await Assignment.find({ supabaseId }).populate('course', 'name');
  
  // Get study sessions from last 30 days
  const recentStudySessions = await Activity.find({
    supabaseId,
    type: 'study_session',
    timestamp: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
  }).populate('course', 'name');
  
  // Calculate analytics
  const analytics = {
    totalAssignments: assignments.length,
    completedAssignments: assignments.filter(a => a.progress === 100).length,
    upcomingAssignments: assignments.filter(a => 
      new Date(a.dueDate) > new Date() && 
      new Date(a.dueDate) <= new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    ).length,
    totalStudyTimeLastMonth: recentStudySessions.reduce((sum, session) => sum + (session.duration || 0), 0),
    averageStudyTimePerDay: Math.round(
      recentStudySessions.reduce((sum, session) => sum + (session.duration || 0), 0) / 30
    )
  };
  
  res.status(200).json({
    status: 'success',
    data: analytics
  });
}));

// 404 handler for undefined routes
app.all('*', (req, res, next) => {
  next(new AppError(`Can't find ${req.originalUrl} on this server`, 404));
});

// Handle 404 errors for undefined routes - after all routes but before error handler
app.use(notFound);

// Apply global error handler - must be last middleware
app.use(globalErrorHandler);

// Function to handle graceful shutdown
const gracefulShutdown = () => {
  logger.info('Starting graceful shutdown...');
  server.close(() => {
    logger.info('Server closed. Disconnecting from MongoDB...');
    mongoose.connection.close(false)
      .then(() => {
        logger.info('MongoDB connection closed.');
        process.exit(0);
      })
      .catch(err => {
        logger.error('Error during MongoDB disconnect:', { error: err });
        process.exit(1);
      });
  });

  // Force shutdown after 10 seconds if graceful shutdown fails
  setTimeout(() => {
    logger.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);
};

// Error handling is consolidated at the end of the file

// Start server
server = app.listen(PORT, () => {
  logger.info(`Server running in ${process.env.NODE_ENV} mode on port ${PORT}`);
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  logger.error('UNCAUGHT EXCEPTION! 💥 Shutting down...', { error: err });
  gracefulShutdown();
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  logger.error('UNHANDLED REJECTION! 💥 Shutting down...', { error: err });
  gracefulShutdown();
});

// Handle SIGTERM
process.on('SIGTERM', () => {
  logger.info('👋 SIGTERM RECEIVED. Shutting down gracefully');
  gracefulShutdown();
});