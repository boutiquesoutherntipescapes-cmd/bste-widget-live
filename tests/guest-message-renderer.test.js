import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GuestMessageRenderError,
  renderGuestCommunication
} from '../lib/guest-message-renderer.js';

const booking = {
  property_slug: 'legacy-suiderstrand',
  guest_name: 'Sample Guest',
  arrival: '2026-10-01',
  departure: '2026-10-04',
  adults: 7,
  children: 0
};

test('departure-eve render matches locked Legacy wording and needs no Wi-Fi secret', () => {
  const result = renderGuestCommunication({
    booking,
    communication: { message_key: 'departure_eve' },
    env: {}
  });

  assert.equal(result.template_key, 'day_before_departure');
  assert.equal(result.subject, 'We hope you’ve enjoyed your stay 🌊');
  assert.equal(
    result.body,
    [
      'Hi Sample,',
      '',
      'We hope you’ve had a wonderful time at Legacy Beach Villa.',
      '',
      'Just a quick note ahead of tomorrow’s departure.',
      '',
      'Check-out is between 10:00–12:00.',
      '',
      'Please send us a WhatsApp about 30 minutes before you’re ready to leave. We’ll come over to say goodbye, help with loading if needed and collect the keys.',
      '',
      'Before you leave, we’d really appreciate it if you could:',
      '',
      '• Gather all used towels and leave them together in the bathroom or bathtub.',
      '',
      '• Place dirty dishes in the dishwasher and switch it on.',
      '',
      '• Place your rubbish in the garbage cradle by the front wall.',
      '',
      '• Make sure all windows and doors are closed.',
      '',
      'If you need anything before tomorrow:',
      '',
      'Bond: 076 346 0639',
      'Leah: 066 335 0987',
      '',
      'Enjoy your last evening at the Southern Tip.',
      '',
      'Bond & Leah',
      'Boutique Southern Tip Escapes'
    ].join('\n')
  );
});

test('house essentials fail closed when private Wi-Fi values are absent', () => {
  assert.throws(
    () => renderGuestCommunication({
      booking,
      communication: { message_key: 'arrival_evening_essentials' },
      env: {}
    }),
    error => error instanceof GuestMessageRenderError
      && error.code === 'wifi_secret_missing'
  );
});

test('house essentials read Wi-Fi only from private environment values', () => {
  const result = renderGuestCommunication({
    booking,
    communication: { message_key: 'arrival_evening_essentials' },
    env: {
      BSTE_GUEST_WIFI_LEGACY_NETWORK: 'fixture-network',
      BSTE_GUEST_WIFI_LEGACY_PASSWORD: 'fixture-password'
    }
  });

  assert.match(result.body, /Network: fixture-network/);
  assert.match(result.body, /Password: fixture-password/);
});

test('booking confirmation derives guest count from adults and children', () => {
  const result = renderGuestCommunication({
    booking: { ...booking, adults: 5, children: 2 },
    communication: { message_key: 'booking_confirmation' },
    env: {}
  });

  assert.match(result.body, /confirmed for 7 guests/);
});

test('unknown property fails closed', () => {
  assert.throws(
    () => renderGuestCommunication({
      booking: { ...booking, property_slug: 'unknown-property' },
      communication: { message_key: 'departure_eve' },
      env: {}
    }),
    error => error instanceof GuestMessageRenderError
      && error.code === 'unknown_property'
  );
});

test('unknown queue message key fails closed', () => {
  assert.throws(
    () => renderGuestCommunication({
      booking,
      communication: { message_key: 'surprise_message' },
      env: {}
    }),
    error => error instanceof GuestMessageRenderError
      && error.code === 'unsupported_message_key'
  );
});
