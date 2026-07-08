// /api/owner-blocks.js
// Owner calendar blocks API.
// GET    = list owner blocks for a property token
// POST   = create a new owner block
// DELETE = delete an owner block

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

function cleanSupabaseUrl(url) {
  return String(url || '')
    .trim()
    .replace(/\/rest\/v1\/?$/i, '')
    .replace(/\/+$/g, '');
}

function getSupabase() {
  const url = cleanSupabaseUrl(process.env.SUPABASE_URL);
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }

  return { url, key };
}

async function supabaseFetch(path, options = {}) {
  const { url, key } = getSupabase();

  const response = await fetch(`${url}/rest/v1/${path}`, {
    method: options.method || 'GET',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || ''
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`${response.status}: ${text}`);
  }

  if (!text) return null;

  return JSON.parse(text);
}

async function getOwnerByToken(token) {
  if (!token) {
    throw new Error('Missing owner token');
  }

  const safeToken = encodeURIComponent(token);

  const rows = await supabaseFetch(
    `owner_access?select=property_slug,owner_name,is_active&owner_token=eq.${safeToken}&is_active=eq.true&limit=1`
  );

  if (!rows || !rows.length) {
    throw new Error('Invalid or inactive owner token');
  }

  return rows[0];
}

function isValidDateString(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

export default async function handler(req, res) {
  try {
    cors(res);

    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }

    const token =
      req.method === 'GET' || req.method === 'DELETE'
        ? req.query?.token
        : req.body?.token;

    const owner = await getOwnerByToken(token);
    const propertySlug = owner.property_slug;

    if (req.method === 'GET') {
      const blocks = await supabaseFetch(
        `owner_blocks?select=id,property_slug,start_date,end_date,block_type,note,created_by,created_at&property_slug=eq.${encodeURIComponent(propertySlug)}&order=start_date.asc`
      );

      return res.status(200).json({
        ok: true,
        property_slug: propertySlug,
        owner_name: owner.owner_name,
        blocks: blocks || []
      });
    }

    if (req.method === 'POST') {
      const { start_date, end_date, note = '' } = req.body || {};

      if (!isValidDateString(start_date) || !isValidDateString(end_date)) {
        return res.status(400).json({
          ok: false,
          error: 'Dates must be in YYYY-MM-DD format'
        });
      }

      if (end_date <= start_date) {
        return res.status(400).json({
          ok: false,
          error: 'End date must be after start date'
        });
      }

      const inserted = await supabaseFetch('owner_blocks?select=*', {
        method: 'POST',
        prefer: 'return=representation',
        body: {
          property_slug: propertySlug,
          start_date,
          end_date,
          block_type: 'owner_block',
          note,
          created_by: 'owner'
        }
      });

      return res.status(200).json({
        ok: true,
        message: 'Owner block created',
        property_slug: propertySlug,
        block: inserted?.[0] || null
      });
    }

    if (req.method === 'DELETE') {
      const id = req.query?.id;

      if (!id) {
        return res.status(400).json({
          ok: false,
          error: 'Missing block id'
        });
      }

      await supabaseFetch(
        `owner_blocks?id=eq.${encodeURIComponent(id)}&property_slug=eq.${encodeURIComponent(propertySlug)}`,
        {
          method: 'DELETE',
          prefer: 'return=minimal'
        }
      );

      return res.status(200).json({
        ok: true,
        message: 'Owner block deleted',
        property_slug: propertySlug
      });
    }

    return res.status(405).json({
      ok: false,
      error: 'Method not allowed'
    });

  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: 'Server error in owner-blocks',
      detail: String(err)
    });
  }
}
