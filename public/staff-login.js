const form = document.getElementById('login');
const status = document.getElementById('status');
const mfa = document.getElementById('mfa');
const factor = document.getElementById('factor');
const code = document.getElementById('code');
const logout = document.getElementById('logout');
const enrollment = document.getElementById('enrollment');
const startEnrollment = document.getElementById('start-enrollment');
const setupDetails = document.getElementById('setup-details');
const qr = document.getElementById('setup-qr');
const secret = document.getElementById('setup-secret');
let setupTimer;
let flowVersion = 0;
function clearSetup() {
  clearTimeout(setupTimer);
  qr.removeAttribute('src');
  secret.textContent = '';
  setupDetails.hidden = true;
  code.value = '';
}


function showStaff(staff) {
  document.getElementById('dashboard-link').hidden = false;
  clearSetup();
  enrollment.hidden = true;
  form.hidden = true;
  mfa.hidden = true;
  logout.hidden = false;
  status.textContent = `Signed in as ${staff.display_name}. Staff access is ready. Open the operations dashboard to review saved stays.`;
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  const version = ++flowVersion;
  clearSetup();
  status.textContent = 'Signing in…';
  try {
    const response = await fetch('/api/staff-session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: document.getElementById('email').value, password: document.getElementById('password').value })
    });
    const data = await response.json();
    if (version !== flowVersion) return;
    if (!response.ok) throw new Error(data.error || 'Sign-in failed');
    if (data.mfa_required) {
      form.hidden = true;
      logout.hidden = false;
      factor.replaceChildren(...data.factors.map((f, i) => new Option(`Authenticator ${i + 1}`, f.id)));
      mfa.hidden = data.factors.length === 0;
      enrollment.hidden = data.factors.length !== 0;
      status.textContent = data.factors.length
        ? 'Enter your authenticator code to complete sign-in.'
        : 'MFA is required. Choose Set up authenticator, then verify a six-digit code. If you already use another MFA method, use the recovery process.';
    } else showStaff(data.staff);
  } catch (error) { status.textContent = error.message; }
  finally { document.getElementById('password').value = ''; button.disabled = false; }
});

logout.addEventListener('click', async () => {
  document.getElementById('dashboard-link').hidden = true;
  ++flowVersion;
  clearSetup();
  enrollment.hidden = true;
  try {
    const response = await fetch('/api/staff-session', { method: 'DELETE' });
    if (!response.ok) throw new Error('Sign-out could not be fully recorded. Your browser session has been cleared.');
    status.textContent = 'Signed out.';
  } catch { status.textContent = 'Sign-out could not be confirmed. Close this browser session and contact an administrator if needed.'; }
  mfa.hidden = true;
  form.hidden = false;
  logout.hidden = true;
});

const initialVersion = flowVersion;
fetch('/api/staff-session').then(async response => {
  if (response.ok && flowVersion === initialVersion) showStaff((await response.json()).staff);
}).catch(() => { status.textContent = 'Staff access is temporarily unavailable.'; });

mfa.addEventListener('submit', async event => {
  event.preventDefault();
  const version = flowVersion;
  const button = mfa.querySelector('button');
  button.disabled = true;
  try {
    const response = await fetch('/api/staff-session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'verify_mfa', factor_id: factor.value, code: code.value })
    });
    const data = await response.json();
    if (version !== flowVersion) return;
    if (!response.ok) throw new Error(data.error || 'Verification failed');
    showStaff(data.staff);
  } catch (error) { status.textContent = error.message; }
  finally { code.value = ''; button.disabled = false; }
});
startEnrollment.addEventListener('click', async () => {
  const version = flowVersion;
  startEnrollment.disabled = true;
  clearSetup();
  mfa.hidden = true;
  try {
    const response = await fetch('/api/staff-session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'enroll_mfa' })
    });
    const data = await response.json();
    if (version !== flowVersion) return;
    if (!response.ok) throw new Error(data.error || 'Setup failed');
    const setup = data.enrollment;
    // SVG is an image, never active markup. No third-party QR service is used.
    qr.src = setup.qr_code.startsWith('data:image/svg+xml;')
      ? setup.qr_code : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(setup.qr_code)}`;
    secret.textContent = setup.secret;
    factor.replaceChildren(new Option('New authenticator', setup.factor_id));
    setupDetails.hidden = false;
    mfa.hidden = false;
    status.textContent = 'Scan the QR code or enter the setup key, then verify the code from your authenticator.';
    setupTimer = setTimeout(() => {
      clearSetup();
      status.textContent = 'Setup details cleared. Sign out and sign in again if your setup session has expired.';
    }, 5 * 60 * 1000);
  } catch (error) { if (version === flowVersion) status.textContent = error.message; }
  finally { startEnrollment.disabled = false; }
});
window.addEventListener('pagehide', () => { ++flowVersion; clearSetup(); });
// Only enable inputs once every submission handler is attached. Inputs have no
// names: even a native POST after a script failure cannot serialize credentials.
document.getElementById('login-fields').disabled = false;
document.getElementById('mfa-fields').disabled = false;

startEnrollment.disabled = false;
