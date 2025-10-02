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
import { initWorker, terminateWorker, isWorkerReady } from './lib/ocr.js';
import { redisClient } from './utils/draftStore.js';

// Import routes
import syllabusRoutes from './routes/syllabus.route.js';
import courseRoutes from './routes/course.route.js';
import onboardingRoutes from './routes/onboarding.route.js';
// Import other routes...

// Create Express app factory for testing
function createApp() {
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

  // Rate limiting
  const limiter = rateLimit({
    // values are configurable via RATE_LIMIT_WINDOW_MS and RATE_LIMIT_MAX env vars
    windowMs: env.rateLimitWindow,
    max: env.rateLimitMax,
    message: 'Too many requests from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false
  });

  // Readiness endpoint for platform health checks
  app.get('/ready', async (req, res) => {
    const mongooseState = mongoose.connection.readyState; // 1 = connected
    const workerReady = isWorkerReady();

    if (mongooseState === 1 && workerReady) {
      return res.status(200).json({ status: 'ready', db: 'connected', ocr: 'ready' });
    }

    const details = {
      db: mongooseState === 1 ? 'connected' : 'disconnected',
      ocr: workerReady ? 'ready' : 'not-ready'
    };

    return res.status(503).json({ status: 'not-ready', details });
  });

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

  return app;
}
const app = createApp();

async function startServer() {
  // Connect to MongoDB
  await mongoose.connect(env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });

  console.log('Connected to MongoDB');

  // Pre-warm OCR worker to reduce first-request latency
  initWorker()
    .then(() => console.log('Tesseract worker initialized'))
    .catch((err) => console.warn('Tesseract pre-warm failed', err?.stack || err?.message || err));

  // Start server
  const port = env.port;
  const server = app.listen(port, () => {
    console.log(`Server running in ${process.env.NODE_ENV} mode on port ${port}`);
  });

  // Graceful shutdown handling
  const shutdown = async (signal) => {
    console.log(`Received ${signal}. Shutting down gracefully...`);
    try {
      await terminateWorker();
      if (redisClient && typeof redisClient.quit === 'function') {
        try { await redisClient.quit(); } catch (e) { console.warn('Error quitting redis client', e?.message || e); }
      }
      await mongoose.disconnect();
      server.close(() => {
        console.log('HTTP server closed.');
        process.exit(0);
      });
      // Force exit if not closed in time
      setTimeout(() => {
        console.error('Forcing shutdown after timeout');
        process.exit(1);
      }, 10000).unref();
    } catch (err) {
      console.error('Error during shutdown:', err);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Global crash handlers: attempt graceful shutdown on unexpected errors, but avoid noisy exits from worker threads
  process.on('uncaughtException', async (err) => {
    console.error('UNCAUGHT EXCEPTION! 💥 Shutting down...', err?.stack || err);
    try {
      await terminateWorker();
    } catch (e) { /* noop */ }
    try { await mongoose.disconnect(); } catch (e) { /* noop */ }
    process.exit(1);
  });

  process.on('unhandledRejection', async (reason) => {
    console.error('UNHANDLED REJECTION! 💥 Shutting down...', reason);
    try {
      await terminateWorker();
    } catch (e) { /* noop */ }
    try { await mongoose.disconnect(); } catch (e) { /* noop */ }
    process.exit(1);
  });

  return server;
}

// If this file is run directly, start the server
if (process.argv[1] && process.argv[1].endsWith('app.js')) {
  startServer().catch((err) => {
    console.error('Failed to start server', err);
    process.exit(1);
  });
}

export { createApp, app, startServer };