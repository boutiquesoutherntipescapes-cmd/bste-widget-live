import {
  StaffAuthError, assertStaffOrigin, requireStaff, signInStaff,
  recordSignOut, staffToken, sessionCookie, verifyStaffMfa, enrollStaffMfa
} from '../lib/staff-auth.js';

export default async function handler(req, res) {
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Cookie');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    if (req.method === 'GET') {
      const { staff } = await requireStaff(req);
      return res.status(200).json({ staff });
    }
    if (req.method === 'POST') {
      assertStaffOrigin(req);
      if (!String(req.headers?.['content-type'] || '').startsWith('application/json')) {
        throw new StaffAuthError(415, 'JSON required');
      }
      if (req.body?.action === 'enroll_mfa') {
        const enrollment = await enrollStaffMfa(staffToken(req));
        // Do not reset/extend the pending session cookie while setting up MFA.
        return res.status(200).json({ enrollment });
      }
      if (req.body?.action && !['login', 'verify_mfa'].includes(req.body.action)) {
        throw new StaffAuthError(400, 'Unknown session action');
      }
      const result = req.body?.action === 'verify_mfa'
        ? await verifyStaffMfa(staffToken(req), req.body?.factor_id, req.body?.code)
        : await signInStaff(req.body?.email, req.body?.password);
      const { staff, token, seconds } = result;
      res.setHeader('Set-Cookie', sessionCookie(token, seconds));
      return res.status(200).json(result.mfa_required
        ? { mfa_required: true, factors: result.factors } : { staff });
    }
    if (req.method === 'DELETE') {
      assertStaffOrigin(req);
      // Clear this browser even if the token has expired or the provider is offline.
      res.setHeader('Set-Cookie', sessionCookie());
      const token = staffToken(req);
      if (token) await recordSignOut(token);
      return res.status(200).json({ signed_out: true });
    }
    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    return res.status(error instanceof StaffAuthError ? error.status : 500).json({
      error: error instanceof StaffAuthError ? error.message : 'Staff authentication failed'
    });
  }
}
