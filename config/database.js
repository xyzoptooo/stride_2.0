import mongoose from 'mongoose';
import { isProduction } from './environment.js';
import { logger } from '../utils/logger.js';

const dbOptions = {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  maxPoolSize: isProduction ? 50 : 10,
  minPoolSize: isProduction ? 10 : 2,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
  family: 4,
  keepAlive: true,
  keepAliveInitialDelay: 300000, // 5 minutes
};

// Add production-specific options
if (isProduction) {
  dbOptions.replicaSet = process.env.MONGODB_REPLICA_SET;
  dbOptions.retryWrites = true;
  dbOptions.w = 'majority';
  dbOptions.readPreference = 'secondary';
  dbOptions.autoIndex = false; // Don't build indexes in production
}

export const connectDB = async () => {
  try {
    // Configure mongoose error logging
    mongoose.set('debug', !isProduction);

    // Handle connection events
    mongoose.connection.on('connected', () => {
      logger.info('MongoDB connected successfully');
    });

    mongoose.connection.on('error', (err) => {
      logger.error('MongoDB connection error', { error: err });
    });

    mongoose.connection.on('disconnected', () => {
      logger.warn('MongoDB disconnected');
    });

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      try {
        await mongoose.connection.close();
        logger.info('MongoDB connection closed through app termination');
        process.exit(0);
      } catch (err) {
        logger.error('Error closing MongoDB connection', { error: err });
        process.exit(1);
      }
    });

    // Connect with retry logic
    const maxRetries = 5;
    let retries = 0;
    
    while (retries < maxRetries) {
      try {
        await mongoose.connect(process.env.MONGODB_URI, dbOptions);
        break;
      } catch (err) {
        retries++;
        logger.error(`Failed to connect to MongoDB (attempt ${retries}/${maxRetries})`, { error: err });
        
        if (retries === maxRetries) {
          throw new Error('Failed to connect to MongoDB after maximum retries');
        }
        
        // Wait before retrying (exponential backoff)
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, retries) * 1000));
      }
    }
  } catch (err) {
    logger.error('Fatal MongoDB connection error', { error: err });
    process.exit(1);
  }
};

export default { connectDB };