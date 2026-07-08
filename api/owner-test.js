// /api/owner-test.js
// Simple private test to confirm Vercel can connect to Supabase.
// This version safely handles SUPABASE_URL whether it includes /rest/v1/ or not.

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

function cleanSupabaseUrl(url) {
  return String(url || '')
    .trim()
    .replace(/\/rest\/v1\/?$/i, '')
    .replace(/\/+$/g, '');
}

export default async function handler(req, res) {
  try {
    cors(res);

    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }

    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const supabaseUrl = cleanSupabaseUrl(process.env.SUPABASE_URL);
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceKey) {
      return res.status(500).json({
        ok: false,
        error: 'Missing Supabase environment variables'
      });
    }

    const requestUrl = `${supabaseUrl}/rest/v1/owner_access?select=property_slug,owner_name,is_active&order=property_slug.asc`;

    const response = await fetch(requestUrl, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`
      }
    });

    const text = await response.text();

    if (!response.ok) {
      return res.status(500).json({
        ok: false,
        error: 'Supabase request failed',
        status: response.status,
        request_url_used: requestUrl.replace(supabaseUrl, '[SUPABASE_URL]'),
        detail: text
      });
    }

    const rows = JSON.parse(text);

    return res.status(200).json({
      ok: true,
      message: 'Supabase connection working',
      owner_access_count: rows.length,
      properties: rows
    });

  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: 'Server error in owner-test',
      detail: String(err)
    });
  }
}
