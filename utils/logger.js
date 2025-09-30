import { isProduction } from '../config/environment.js';

class Logger {
  constructor() {
    this.isProduction = isProduction;
  }

  formatMessage(level, message, meta = {}) {
    return {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...meta,
    };
  }

  log(level, message, meta = {}) {
    if (this.isProduction) {
      console.log(JSON.stringify(this.formatMessage(level, message, meta)));
    } else {
      console.log(`[${level.toUpperCase()}]`, message, meta);
    }
  }

  info(message, meta = {}) {
    this.log('info', message, meta);
  }

  error(message, meta = {}) {
    if (meta.error instanceof Error) {
      meta.errorStack = meta.error.stack;
      meta.errorName = meta.error.name;
      delete meta.error;
    }
    this.log('error', message, meta);
  }

  warn(message, meta = {}) {
    this.log('warn', message, meta);
  }

  debug(message, meta = {}) {
    if (!this.isProduction) {
      this.log('debug', message, meta);
    }
  }

  // Special method for API request logging
  httpRequest(req, res, responseTime) {
    const meta = {
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      responseTime: `${responseTime}ms`,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    };

    // Add user info if available
    if (req.user?.supabaseId) {
      meta.userId = req.user.supabaseId;
    }

    this.info('HTTP Request', meta);
  }

  // Special method for M-Pesa transaction logging
  mpesaTransaction(action, data) {
    const meta = {
      action,
      checkoutRequestId: data.CheckoutRequestID,
      merchantRequestId: data.MerchantRequestID,
      resultCode: data.ResultCode,
      resultDesc: data.ResultDesc,
    };

    this.info('M-Pesa Transaction', meta);
  }
}

export const logger = new Logger();