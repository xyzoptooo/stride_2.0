import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';

const checkMongoDB = async () => {
  try {
    const state = mongoose.connection.readyState;
    return {
      status: state === 1 ? 'up' : 'down',
      responseTime: await measureResponseTime()
    };
  } catch (error) {
    logger.error('MongoDB health check failed', { error });
    return { status: 'down', error: error.message };
  }
};

const measureResponseTime = async () => {
  const start = Date.now();
  try {
    await mongoose.connection.db.admin().ping();
    return Date.now() - start;
  } catch (error) {
    return null;
  }
};

export const healthCheck = async () => {
  const mongodb = await checkMongoDB();
  
  const status = {
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    service: 'semester-stride-api',
    dependencies: {
      mongodb
    },
    memory: {
      heapUsed: process.memoryUsage().heapUsed,
      heapTotal: process.memoryUsage().heapTotal,
      external: process.memoryUsage().external,
      rss: process.memoryUsage().rss
    }
  };

  return {
    healthy: mongodb.status === 'up',
    status
  };
};

export default { healthCheck };