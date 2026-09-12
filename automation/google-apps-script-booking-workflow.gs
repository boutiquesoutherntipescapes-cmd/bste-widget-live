// BSTE Booking Operations Workflow — Google Apps Script module
//
// Designed to plug into the existing BSTE Google webhook used by Vercel.
// In your existing doPost(e), after validating BSTE_WEBHOOK_SECRET, route:
//
//   if (payload.action === 'booking_workflow') {
//     return handleBookingWorkflow_(payload);
//   }
//
// Script Properties expected:
//   BSTE_MANAGER_EMAIL   = Bond/BSTE operations email
//   BSTE_CLEANER_EMAIL   = cleaner/team email
//   BSTE_CALENDAR_ID     = Google Calendar ID for BSTE Operations
//   BSTE_TIMEZONE        = Africa/Johannesburg (optional; default below)
//
// Cleaner privacy rule: cleaners receive property, dates, guest count and service
// requirements only — not guest email, phone, passport or other personal data.

function bsteWorkflowConfig_() {
  var props = PropertiesService.getScriptProperties();
  return {
    managerEmail: props.getProperty('BSTE_MANAGER_EMAIL') || '',
    cleanerEmail: props.getProperty('BSTE_CLEANER_EMAIL') || '',
    calendarId: props.getProperty('BSTE_CALENDAR_ID') || '',
    timezone: props.getProperty('BSTE_TIMEZONE') || 'Africa/Johannesburg'
  };
}

function bsteSafe_(value) {
  return String(value == null ? '' : value);
}

function bsteZar_(value) {
  var n = Number(value || 0);
  return 'R' + Utilities.formatString('%,.2f', n);
}

function bsteDateTime_(date, time, timezone) {
  return Utilities.parseDate(
    bsteSafe_(date) + ' ' + bsteSafe_(time || '09:00'),
    timezone || 'Africa/Johannesburg',
    'yyyy-MM-dd HH:mm'
  );
}

function bsteTaskEventKey_(bookingId, taskType) {
  return 'BSTE_CAL_' + bookingId + '_' + taskType;
}

function bsteProcessedKey_(bookingId) {
  return 'BSTE_WORKFLOW_HASH_' + bookingId;
}

function bsteDeleteCalendarEvents_(bookingId, cfg) {
  if (!cfg.calendarId) return;
  var calendar = CalendarApp.getCalendarById(cfg.calendarId);
  if (!calendar) return;

  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var prefix = 'BSTE_CAL_' + bookingId + '_';

  Object.keys(all).forEach(function(key) {
    if (key.indexOf(prefix) !== 0) return;
    try {
      var event = calendar.getEventById(all[key]);
      if (event) event.deleteEvent();
    } catch (err) {
      console.log('Could not delete event ' + key + ': ' + err);
    }
    props.deleteProperty(key);
  });
}

function bsteUpsertCalendarTasks_(payload, cfg) {
  if (!cfg.calendarId) return;

  var calendar = CalendarApp.getCalendarById(cfg.calendarId);
  if (!calendar) throw new Error('BSTE operations calendar not found');

  var props = PropertiesService.getScriptProperties();
  var tasks = payload.operational_tasks || [];

  tasks.forEach(function(task) {
    if (!task.date || !task.type) return;

    var key = bsteTaskEventKey_(payload.booking_id, task.type);
    var oldId = props.getProperty(key);
    if (oldId) {
      try {
        var oldEvent = calendar.getEventById(oldId);
        if (oldEvent) oldEvent.deleteEvent();
      } catch (err) {}
      props.deleteProperty(key);
    }

    var start = bsteDateTime_(task.date, task.time || '09:00', cfg.timezone);
    var end;
    if (task.end_time) {
      end = bsteDateTime_(task.date, task.end_time, cfg.timezone);
    } else {
      end = new Date(start.getTime() + 60 * 60 * 1000);
    }

    var titlePrefix = {
      prep_inspection: 'PREP',
      check_in: 'CHECK-IN',
      check_out: 'CHECK-OUT',
      post_checkout_inspection: 'INSPECTION',
      deep_clean: 'CLEAN',
      balance_due_check: 'PAYMENT CHECK'
    }[task.type] || 'BSTE';

    var title = titlePrefix + ' · ' + payload.property_name;
    var description = [
      'BSTE Booking #' + payload.booking_id,
      'Source: ' + payload.channel,
      'Stay: ' + payload.arrival + ' to ' + payload.departure,
      'Guests: ' + payload.guests,
      task.label || ''
    ].filter(Boolean).join('\n');

    var event = calendar.createEvent(title, start, end, {
      description: description
    });

    // Keep cleaner access limited to the cleaning task only.
    if (task.type === 'deep_clean' && cfg.cleanerEmail) {
      try { event.addGuest(cfg.cleanerEmail); } catch (err) {}
    }

    event.addPopupReminder(60);
    if (task.type === 'prep_inspection' || task.type === 'deep_clean') {
      event.addPopupReminder(24 * 60);
    }

    props.setProperty(key, event.getId());
  });
}

function bsteManagerEmail_(payload, cfg) {
  if (!cfg.managerEmail) return;

  var eventName = payload.event_type === 'booking_cancelled'
    ? 'BOOKING CANCELLED'
    : payload.event_type === 'booking_modified'
      ? 'BOOKING UPDATED'
      : 'NEW BOOKING';

  var subject = '[BSTE] ' + eventName + ' · ' + payload.property_name + ' · ' + payload.arrival;
  var body = [
    eventName,
    '',
    'Property: ' + payload.property_name,
    'Source: ' + payload.channel,
    'Booking #: ' + payload.booking_id,
    'Guest: ' + (payload.guest && payload.guest.name ? payload.guest.name : 'Not supplied'),
    'Email: ' + (payload.guest && payload.guest.email ? payload.guest.email : 'Not supplied'),
    'Mobile: ' + (payload.guest && payload.guest.mobile ? payload.guest.mobile : 'Not supplied'),
    'Arrival: ' + payload.arrival,
    'Departure: ' + payload.departure,
    'Guests: ' + payload.guests + ' (' + payload.adults + ' adults, ' + payload.children + ' children)',
    'Booking value: ' + bsteZar_(payload.financial && payload.financial.booking_value_zar),
    '',
    payload.event_type === 'booking_cancelled'
      ? 'Operational calendar tasks have been removed.'
      : 'BSTE operational calendar tasks have been created/updated automatically.'
  ].join('\n');

  MailApp.sendEmail(cfg.managerEmail, subject, body);
}

function bsteCleanerEmail_(payload, cfg) {
  if (!cfg.cleanerEmail) return;

  var eventName = payload.event_type === 'booking_cancelled'
    ? 'CLEAN CANCELLED'
    : payload.event_type === 'booking_modified'
      ? 'CLEANING SCHEDULE UPDATED'
      : 'NEW CLEAN SCHEDULED';

  var cleanDate = payload.cleaner && payload.cleaner.service_date
    ? payload.cleaner.service_date
    : payload.departure;

  var subject = '[BSTE Cleaning] ' + eventName + ' · ' + payload.property_name;
  var body = [
    eventName,
    '',
    'Property: ' + payload.property_name,
    'Guest check-out: ' + payload.departure,
    'Deep clean / reset: ' + cleanDate,
    'Guest count: ' + payload.guests,
    'Linen turnover: Yes',
    'Professional laundry: Yes',
    '',
    payload.event_type === 'booking_cancelled'
      ? 'Please remove this stay from the cleaning schedule.'
      : 'The cleaning event has also been added to the BSTE operations calendar.'
  ].join('\n');

  MailApp.sendEmail(cfg.cleanerEmail, subject, body);
}

function handleBookingWorkflow_(payload) {
  var cfg = bsteWorkflowConfig_();
  var props = PropertiesService.getScriptProperties();
  var hashKey = bsteProcessedKey_(payload.booking_id);
  var priorHash = props.getProperty(hashKey) || '';

  // Vercel already dedupes using Beds24 custom10. This second guard protects
  // against Google webhook retries after an email/calendar action succeeds.
  if (priorHash === bsteSafe_(payload.event_hash)) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, ignored: 'duplicate' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  if (payload.event_type === 'booking_cancelled') {
    bsteDeleteCalendarEvents_(payload.booking_id, cfg);
  } else {
    bsteUpsertCalendarTasks_(payload, cfg);
  }

  bsteManagerEmail_(payload, cfg);
  bsteCleanerEmail_(payload, cfg);

  props.setProperty(hashKey, bsteSafe_(payload.event_hash));

  return ContentService
    .createTextOutput(JSON.stringify({
      ok: true,
      event_type: payload.event_type,
      booking_id: payload.booking_id
    }))
    .setMimeType(ContentService.MimeType.JSON);
}
