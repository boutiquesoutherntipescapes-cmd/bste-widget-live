// BSTE Booking Operations Workflow — one-time production setup
// Run setupBsteWorkflowConfig() once in the Google Apps Script project that
// receives BSTE webhook calls. Values are stored as Script Properties so the
// main workflow module remains reusable for future self-managed-owner packages.

function setupBsteWorkflowConfig() {
  PropertiesService.getScriptProperties().setProperties({
    BSTE_MANAGER_EMAIL: 'boutiquesoutherntipescapes@gmail.com',
    BSTE_CLEANER_EMAIL: 'fa171823@gmail.com',
    BSTE_CALENDAR_ID: 'boutiquesoutherntipescapes@gmail.com',
    BSTE_TIMEZONE: 'Africa/Johannesburg'
  }, false);

  return {
    ok: true,
    managerEmail: 'boutiquesoutherntipescapes@gmail.com',
    cleanerEmail: 'fa171823@gmail.com',
    calendarId: 'boutiquesoutherntipescapes@gmail.com',
    timezone: 'Africa/Johannesburg'
  };
}
