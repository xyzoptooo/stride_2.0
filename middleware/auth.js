import axios from 'axios';
import { env } from '../config/environment.js';

// Authenticate middleware verifies Supabase access token by calling Supabase auth endpoint.
export const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No authentication token provided' });
    }

    const token = authHeader.replace('Bearer ', '').trim();

    try {
      // If Supabase config missing, fail fast
      if (!env.SUPABASE_PROJECT_ID || !env.SUPABASE_SERVICE_KEY) {
        console.error('SUPABASE_PROJECT_ID or SUPABASE_SERVICE_KEY not configured');
        return res.status(500).json({ error: 'Server misconfiguration: authentication not available' });
      }

      // Call Supabase user endpoint to validate token
      const resp = await axios.get(`https://${env.SUPABASE_PROJECT_ID}.supabase.co/auth/v1/user`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'apikey': env.SUPABASE_SERVICE_KEY
        },
        timeout: 5000
      });

      if (!resp.data) {
        return res.status(401).json({ error: 'Invalid or expired token' });
      }

      // Attach the Supabase user object to req.user for downstream handlers
      req.user = resp.data;
      return next();
    } catch (err) {
      console.warn('Supabase token verification failed:', err?.response?.status || err.message);
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  } catch (error) {
    console.error('Auth middleware error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
};