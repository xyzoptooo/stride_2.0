import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Environment settings
export const isProduction = process.env.NODE_ENV === 'production';
export const isDevelopment = process.env.NODE_ENV === 'development';

// CORS settings
export const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'https://stride-2-0.onrender.com',
  process.env.FRONTEND_URL,
].filter(Boolean);

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
  if (!/^mongodb(\+srv)?:\/\/.+/.test(process.env.MONGODB_URI)) {
    throw new Error('Invalid MONGODB_URI format');
  }

  // Production-specific validations
  if (isProduction) {
    // Validate M-Pesa URLs
    if (process.env.MPESA_BASE_URL.includes('sandbox')) {
      throw new Error('Production environment cannot use sandbox M-Pesa URL');
    }

    if (!process.env.MPESA_CALLBACK_URL.startsWith('https://')) {
      throw new Error('M-Pesa callback URL must use HTTPS in production');
    }

    // Validate security settings
    if (process.env.COOKIE_SECURE !== 'true') {
      throw new Error('Cookies must be secure in production');
    }

    if (process.env.EMAIL_SECURE !== 'true') {
      throw new Error('Email must use secure connection in production');
    }
  }
};

// Export environment variables with defaults
export const env = {
  port: process.env.PORT || 4000,
  MONGODB_URI: process.env.MONGODB_URI,
  sessionSecret: process.env.SESSION_SECRET,
  maxFileSize: process.env.MAX_FILE_SIZE || '10mb',
  rateLimitWindow: parseInt(process.env.RATE_LIMIT_WINDOW || '900000'),
  rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX || '100'),
  cookieSecure: isProduction ? true : (process.env.COOKIE_SECURE === 'true'),
  emailSecure: isProduction ? true : (process.env.EMAIL_SECURE === 'true'),
  logLevel: process.env.LOG_LEVEL || (isProduction ? 'error' : 'debug'),
  allowedOrigins: process.env.ALLOWED_ORIGINS?.split(',') || [
    'http://localhost:5173',
    'http://localhost:8080',
    'http://localhost:3000'
  ]
};