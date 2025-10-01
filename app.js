import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import mongoSanitize from 'express-mongo-sanitize';
import xss from 'xss-clean';
import compression from 'compression';

// Import configurations
import { env, isProduction } from './config/environment.js';
import { globalErrorHandler, notFound } from './middleware/errorHandler.js';

// Import routes
import syllabusRoutes from './routes/syllabus.route.js';
import courseRoutes from './routes/course.route.js';
import onboardingRoutes from './routes/onboarding.route.js';
// Import other routes...

// Create Express app
const app = express();

// Configure security middleware
const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps, curl, etc.)
    if (!origin) {
      return callback(null, true);
    }
    
    const allowedOrigins = [
      'http://localhost:3000',
      'http://localhost:5173',
      'https://stride-2-0.onrender.com',
      'https://www.semesterstride.app',
      'https://semesterstride.app'
    ];

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
  maxAge: 600 // 10 minutes
};

// Ensure the response sets Access-Control-Allow-Origin to the requesting origin when allowed
// This avoids returning '*' when credentials are required by the browser
app.use((req, res, next) => {
  const originHeader = req.headers.origin;
  const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:5173',
    'https://stride-2-0.onrender.com',
    'https://www.semesterstride.app',
    'https://semesterstride.app'
  ];

  if (originHeader && allowedOrigins.includes(originHeader)) {
    res.setHeader('Access-Control-Allow-Origin', originHeader);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  }

  // Handle preflight requests quickly
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  next();
});

// Rate limiting
const limiter = rateLimit({
  windowMs: env.rateLimitWindow,
  max: env.rateLimitMax,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

// Apply security middleware
app.use(cors(corsOptions));
app.use(helmet());
app.use(mongoSanitize());
app.use(xss());
app.use(express.json({ limit: env.maxFileSize }));
app.use(express.urlencoded({ extended: true, limit: env.maxFileSize }));

// Enable compression in production
if (isProduction) {
  app.use(compression());
  app.set('trust proxy', 1);
}

// Apply rate limiting to API routes
app.use('/api/', limiter);

// Mount routes
app.use('/api/syllabus', syllabusRoutes);
app.use('/api/courses', courseRoutes);
app.use('/api/onboarding', onboardingRoutes);
// Mount other routes...

// Handle 404 errors
app.use(notFound);

// Global error handler
app.use(globalErrorHandler);

// Connect to MongoDB
mongoose.connect(env.mongodbUri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => {
  console.log('Connected to MongoDB');
  
  // Start server
  const port = env.port;
  app.listen(port, () => {
    console.log(`Server running in ${process.env.NODE_ENV} mode on port ${port}`);
  });
})
.catch((error) => {
  console.error('MongoDB connection error:', error);
  process.exit(1);
});