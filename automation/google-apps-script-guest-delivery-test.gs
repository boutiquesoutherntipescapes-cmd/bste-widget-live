// BSTE guest communication delivery TEST — Apps Script only.
//
// Safety properties:
// - Recipient is fixed to the BSTE inbox. No guest address is accepted.
// - Subject is clearly marked TEST.
// - One time-based trigger is created, then removed after execution.
// - This module does not read Beds24, Supabase or guest email fields.
// - It does not enable the live guest automation queue.

var BSTE_GUEST_TEST_RECIPIENT_ = 'boutiquesoutherntipescapes@gmail.com';
var BSTE_GUEST_TEST_HANDLER_ = 'runBsteGuestDeliveryTest_';
var BSTE_GUEST_TEST_PENDING_KEY_ = 'BSTE_GUEST_TEST_PENDING';
var BSTE_GUEST_TEST_SENT_KEY_ = 'BSTE_GUEST_TEST_SENT_AT';

function bsteGuestDeliveryTestBody_() {
  return [
    'TEST DELIVERY ONLY — this message is intentionally being sent to the BSTE inbox, not to a guest.',
    '',
    'Hi Sample Guest,',
    '',
    'We hope you’re settling in nicely at Legacy Beach Villa.',
    '',
    'Here are a few useful details to keep handy during your stay.',
    '',
    'Wi-Fi',
    'Network: 3 Lagoon',
    'Password: 125Botha456',
    '',
    'The Smart TV is available for you to use — simply log into your own streaming services.',
    '',
    'Please remember to close the windows and doors and arm the alarm whenever you leave the house.',
    '',
    'We’re in a water-critical area, so we really appreciate you using water sparingly during your stay.',
    '',
    'Bath towels and one set of pool towels are supplied. Please don’t use the white towels to remove makeup or sunscreen, as this can permanently stain them. Please use your own towels for the beach.',
    '',
    'If your stay is longer than 7 days, we can arrange a fresh linen change. Just let Bond or Leah know.',
    '',
    'If you make a fire, please never leave it unattended. The braai grids are stainless steel, so please don’t allow open flames to touch the grids as this can permanently stain them.',
    '',
    'Please respect our neighbours and the peaceful surroundings. No parties or filming, and quiet hours are from 23:00–07:00.',
    '',
    'The pool is for supervised use only and no jumping is allowed because it is shallow.',
    '',
    'When using the indoor braai/fireplace, please make the fire as far back as possible and manage smoke in windy conditions by opening or closing the sliding door. Never leave a fire unattended.',
    '',
    'Please bring the outdoor furniture cushions inside if it is raining or very windy.',
    '',
    'Legacy does not have backup power.',
    '',
    'If you need anything at all during your stay:',
    '',
    'Bond: 076 346 0639',
    'Leah: 066 335 0987',
    '',
    'Enjoy your stay. 🌊',
    '',
    'Bond & Leah',
    'Boutique Southern Tip Escapes'
  ].join('\n');
}

function bsteDeleteGuestTestTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === BSTE_GUEST_TEST_HANDLER_) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function scheduleBsteGuestDeliveryTest() {
  var props = PropertiesService.getScriptProperties();
  var manager = props.getProperty('BSTE_MANAGER_EMAIL') || '';

  if (manager !== BSTE_GUEST_TEST_RECIPIENT_) {
    throw new Error('BSTE_MANAGER_EMAIL must be the BSTE inbox before running the guest delivery test.');
  }

  bsteDeleteGuestTestTriggers_();
  props.setProperty(BSTE_GUEST_TEST_PENDING_KEY_, new Date().toISOString());

  var trigger = ScriptApp.newTrigger(BSTE_GUEST_TEST_HANDLER_)
    .timeBased()
    .after(60 * 1000)
    .create();

  return {
    ok: true,
    preview_only: true,
    live_guest_sending_enabled: false,
    recipient: BSTE_GUEST_TEST_RECIPIENT_,
    trigger_id: trigger.getUniqueId(),
    scheduled_after_seconds: 60
  };
}

function runBsteGuestDeliveryTest_() {
  var props = PropertiesService.getScriptProperties();

  try {
    if (!props.getProperty(BSTE_GUEST_TEST_PENDING_KEY_)) {
      throw new Error('No BSTE guest delivery test is pending.');
    }

    var manager = props.getProperty('BSTE_MANAGER_EMAIL') || '';
    if (manager !== BSTE_GUEST_TEST_RECIPIENT_) {
      throw new Error('BSTE test recipient safety check failed.');
    }

    MailApp.sendEmail(
      BSTE_GUEST_TEST_RECIPIENT_,
      '[BSTE TEST – SCHEDULED] Legacy Beach Villa · Arrival day 20:00',
      bsteGuestDeliveryTestBody_()
    );

    props.setProperty(BSTE_GUEST_TEST_SENT_KEY_, new Date().toISOString());
    props.deleteProperty(BSTE_GUEST_TEST_PENDING_KEY_);
  } finally {
    bsteDeleteGuestTestTriggers_();
  }
}
