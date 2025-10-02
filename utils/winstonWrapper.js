import winston from 'winston';
import { env } from '../config/environment.js';

const { combine, timestamp, printf, json } = winston.format;

const loggerTransports = [];
if (env.logToConsole !== false) {
  loggerTransports.push(new winston.transports.Console({
    format: env.isProduction ? json() : combine(timestamp(), printf(({ level, message, timestamp, ...meta }) => `${timestamp} [${level}] ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`))
  }));
}

const winstonLogger = winston.createLogger({
  level: env.logLevel || (env.isProduction ? 'info' : 'debug'),
  transports: loggerTransports,
  defaultMeta: { service: 'semester-stride-backend' }
});

export default winstonLogger;
