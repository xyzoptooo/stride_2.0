import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Environment settings
export const isProduction = process.env.NODE_ENV === 'production';
export const isDevelopment = process.env.NODE_ENV === 'development';

// Server settings
// (merged below into the main env export)

// CORS settings
export const corsConfig = {
  allowedOrigins: [
    'http://localhost:3000',
    'http://localhost:5173',
    'https://stride-2-0.onrender.com',
    'https://www.semesterstride.app',
    'https://semesterstride.app',
    process.env.FRONTEND_URL,
  ].filter(Boolean),
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
  maxAge: 600 // 10 minutes
};

// Required environment variables
export const requiredEnvVars = [
  'SUPABASE_SERVICE_KEY',
  'OPENAI_API_KEY',
  'NODE_ENV',
  'MPESA_CONSUMER_KEY',
  'MPESA_CONSUMER_SECRET',
  'MPESA_PASSKEY',
  'MPESA_SHORTCODE',
  'MPESA_PARTYB',
  'MPESA_BASE_URL',
  'MPESA_CALLBACK_URL',
  'MONGODB_URI',
  'EMAIL_SERVICE',
  'EMAIL_USER'
];

// Add production-only required variables
if (isProduction) {
  requiredEnvVars.push(
    'SESSION_SECRET',
    'EMAIL_PASSWORD',
    'COOKIE_SECURE',
    'EMAIL_SECURE'
  );
}

// Validate environment variables
export const validateEnv = () => {
  const missingVars = requiredEnvVars.filter(envVar => !process.env[envVar]);
  
  if (missingVars.length > 0) {
    throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
  }
  
  // Validate MongoDB URI format
  if (!process.env.MONGODB_URI?.startsWith('mongodb')) {
    throw new Error('Invalid MONGODB_URI format');
  }

  return true;
};

// Apply environment validation
validateEnv();

// Export environment variables with defaults
export const env = {
  port: process.env.PORT || 3000,
  MONGODB_URI: process.env.MONGODB_URI,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    HF_API_TOKEN: process.env.HF_API_TOKEN || null,
  sessionSecret: process.env.SESSION_SECRET,
  // Maximum payload size accepted by express.json / urlencoded. Accepts values like '10mb', '50mb'
  maxFileSize: process.env.MAX_FILE_SIZE || '50mb',
  // Rate limit window in milliseconds (default: 15 minutes)
  rateLimitWindow: parseInt(process.env.RATE_LIMIT_WINDOW_MS || (15 * 60 * 1000).toString(), 10),
  // Max requests per window per IP (default: 100)
  rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
  // Concurrency for heavy CPU/IO bound tasks like OCR/OpenAI requests (default: 2)
  ocrConcurrency: parseInt(process.env.OCR_CONCURRENCY || '2', 10),
  // Allow anonymous onboarding (run OCR/extraction without requiring auth).
  // If true, /api/onboarding/import will process files but will not persist them to user DB unless authenticated.
  allowAnonOnboarding: (process.env.ALLOW_ANON_ONBOARDING || 'true') === 'true',
  // Redis for short-lived draft storage (optional). Set REDIS_URL to enable.
  REDIS_URL: process.env.REDIS_URL || process.env.REDIS_URI || null,
  // Draft TTL in seconds (default 24 hours)
  DRAFT_TTL_SECONDS: parseInt(process.env.DRAFT_TTL_SECONDS || (24 * 60 * 60).toString(), 10),
  cookieSecure: isProduction ? true : (process.env.COOKIE_SECURE === 'true'),
  emailSecure: isProduction ? true : (process.env.EMAIL_SECURE === 'true'),
  logLevel: process.env.LOG_LEVEL || (isProduction ? 'error' : 'debug'),
  allowedOrigins: process.env.ALLOWED_ORIGINS?.split(',') || [
    'http://localhost:5173',
    'http://localhost:8080',
    'http://localhost:3000',
    'https://semester-stride-planner.vercel.app',
    'https://semester-stride-planner-git-main-eva254-ke.vercel.app'
  ]
};