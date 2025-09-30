import mongoose from 'mongoose';
import { AppError } from '../middleware/errorHandler';

const connectDB = async () => {
  try {
    const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/semesterstride';
    
    const conn = await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      maxPoolSize: 50,
      retryWrites: true
    });

    console.log(`MongoDB Connected: ${conn.connection.host}`);
    
    mongoose.connection.on('error', err => {
      console.error('MongoDB connection error:', err);
      throw new AppError('Database connection error', 500);
    });

    mongoose.connection.on('disconnected', () => {
      console.log('MongoDB disconnected');
      throw new AppError('Database disconnected', 500);
    });

    process.on('SIGINT', async () => {
      await mongoose.connection.close();
      console.log('MongoDB connection closed through app termination');
      process.exit(0);
    });

  } catch (error) {
    console.error('Error connecting to MongoDB:', error);
    throw new AppError('Failed to connect to database', 500);
  }
};

export default connectDB;