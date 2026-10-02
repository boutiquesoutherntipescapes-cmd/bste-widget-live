import {
  GuestWorkerError,
  inspectPersistedGuestQueue
} from '../lib/guest-communications-worker.js';

function authorized(req, env = process.env) {
  const secret = String(env.CRON_SECRET || '').trim();
  return Boolean(secret)
    && String(req.headers?.authorization || '') === `Bearer ${secret}`;
}

export function createGuestCommunicationsWorkerHandler({
  inspect = inspectPersistedGuestQueue,
  env = process.env
} = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!authorized(req, env)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const result = await inspect({ env });
      return res.status(200).json(result);
    } catch (error) {
      if (error instanceof GuestWorkerError) {
        return res.status(503).json({
          error: 'Guest communications worker unavailable',
          code: error.code
        });
      }
      return res.status(500).json({
        error: 'Guest communications worker failed safely'
      });
    }
  };
}

export default createGuestCommunicationsWorkerHandler();
