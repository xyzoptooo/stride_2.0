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
  sessionSecret: process.env.SESSION_SECRET,
  maxFileSize: process.env.MAX_FILE_SIZE || '50mb',
  rateLimitWindow: parseInt(process.env.RATE_LIMIT_WINDOW || (15 * 60 * 1000).toString()),
  rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX || '100'),
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