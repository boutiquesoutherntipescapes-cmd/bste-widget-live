// /api/owner-test.js
// Simple private test to confirm Vercel can connect to Supabase.

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
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

    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceKey) {
      return res.status(500).json({
        ok: false,
        error: 'Missing Supabase environment variables'
      });
    }

    const cleanUrl = supabaseUrl.replace(/\/$/, '');

    const response = await fetch(
      `${cleanUrl}/rest/v1/owner_access?select=property_slug,owner_name,is_active&order=property_slug.asc`,
      {
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`
        }
      }
    );

    const text = await response.text();

    if (!response.ok) {
      return res.status(500).json({
        ok: false,
        error: 'Supabase request failed',
        status: response.status,
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
