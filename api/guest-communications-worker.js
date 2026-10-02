import {
  GuestWorkerError,
  inspectPersistedGuestQueue
} from '../lib/guest-communications-worker.js';
import {
  GuestLiveWorkerError,
  deliverPersistedGuestQueue
} from '../lib/guest-communications-live.js';

function authorized(req, env = process.env) {
  const secret = String(env.CRON_SECRET || '').trim();
  return Boolean(secret)
    && String(req.headers?.authorization || '') === `Bearer ${secret}`;
}

export function createGuestCommunicationsWorkerHandler({
  inspect = inspectPersistedGuestQueue,
  deliver = deliverPersistedGuestQueue,
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
      if (env.BSTE_GUEST_WORKER_MODE === 'dry_run') {
        return res.status(200).json(await inspect({ env }));
      }

      if (env.BSTE_GUEST_WORKER_MODE === 'live') {
        return res.status(200).json(await deliver({ env }));
      }

      return res.status(503).json({
        error: 'Guest communications worker unavailable',
        code: 'worker_mode_invalid'
      });
    } catch (error) {
      if (error instanceof GuestWorkerError || error instanceof GuestLiveWorkerError) {
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
