const QUEUE_TO_TEMPLATE_KEY = Object.freeze({
  booking_confirmation: 'booking_confirmed',
  pre_arrival: 'three_days_before',
  arrival_morning: 'arrival_morning',
  arrival_evening_essentials: 'house_essentials',
  departure_eve: 'day_before_departure',
  departure_morning: 'checkout_morning',
  post_stay: 'post_stay'
});

const CONFIG = Object.freeze({
  website: 'https://www.boutiquesoutherntipescapes.com',
  bondPhone: '076 346 0639',
  leahPhone: '066 335 0987',
  checkInWindow: '14:00–16:00'
});

const PROPERTIES = Object.freeze({
  legacy: {
    name: 'Legacy Beach Villa',
    address: '3 Lagoon Weg, Suiderstrand',
    checkOutWindow: '10:00–12:00',
    parking: '1 vehicle can park in the garage and a second vehicle can park in front of the garage.',
    garbage: 'the garbage cradle by the front wall',
    shopping: 'There are no shops in Suiderstrand, so please stock up before you arrive. Pick n Pay and OK in Struisbaai are both very well stocked.',
    smartTv: 'The Smart TV is available for you to use — simply log into your own streaming services.',
    importantNote:
      'The pool is for supervised use only and no jumping is allowed because it is shallow.\n\n' +
      'When using the indoor braai/fireplace, please make the fire as far back as possible and manage smoke in windy conditions by opening or closing the sliding door. Never leave a fire unattended.\n\n' +
      'Please bring the outdoor furniture cushions inside if it is raining or very windy.\n\n' +
      'Legacy does not have backup power.',
    wifiNetworkEnv: 'BSTE_GUEST_WIFI_LEGACY_NETWORK',
    wifiPasswordEnv: 'BSTE_GUEST_WIFI_LEGACY_PASSWORD'
  },
  kalaya: {
    name: 'Kalaya Ridge Villa',
    address: '4 Talita Crescent, Struisbaai',
    gps: "34°48'37.9\"S 20°01'38.2\"E",
    checkOutWindow: '10:00–12:00',
    parking: 'The driveway is steep and narrow. Please take extra care entering and exiting. One vehicle can park in the garage and one in front of the garage. Please do not park in the street or in the open lot next to the house.',
    garbage: 'the garbage cradle outside the gate or in the garage',
    shopping: 'Pick n Pay and OK in Struisbaai are both very well stocked.',
    smartTv: 'The Smart TV is available for you to use — simply log into your own streaming services.',
    importantNote:
      'The pool is for supervised use only and no jumping is allowed because it is shallow.\n\n' +
      'Please do not move the furniture.\n\n' +
      'The outdoor fire pit may only be used when there is NO wind. The property borders fynbos, so never leave a fire unattended.\n\n' +
      'Please do not lean over the balcony and do not climb over the back wall into the fynbos. Snakes and scorpions are part of the natural environment.\n\n' +
      'Kalaya is in a very quiet neighbourhood, so please help us respect the peace.\n\n' +
      'Kalaya does not have backup power.',
    wifiNetworkEnv: 'BSTE_GUEST_WIFI_KALAYA_NETWORK',
    wifiPasswordEnv: 'BSTE_GUEST_WIFI_KALAYA_PASSWORD'
  },
  pearl: {
    name: 'The Pearl Beach Villa',
    address: '34A Main Road, Agulhas',
    checkOutWindow: '11:00–12:00',
    parking: 'The driveway is steep, so please take care entering and exiting. One garage is available, with two additional parking spaces next to the garage.',
    garbage: 'the large black bin or in the garage',
    shopping: 'Pick n Pay and OK in Struisbaai are both very well stocked.',
    smartTv: 'The two Smart TVs are available for you to use — simply log into your own streaming services.',
    importantNote:
      'The indoor fireplace is a fireplace only — please do not braai inside. The outdoor braai is protected from the wind, but never leave a fire unattended.\n\n' +
      'Please do not lean over the balconies and take extra care on the stairs.\n\n' +
      'Please do not open the loft door — it is for the view only.\n\n' +
      'The Spookdraai hiking route runs behind the property but is not accessible from the house. Please do not climb over the wall to reach the mountain.\n\n' +
      'Take care when collecting firewood because the property borders mountain and fynbos and snakes or scorpions may occasionally be present.\n\n' +
      'The house is solar powered, so please use electricity wisely. On very windy days, please close the sliding doors.',
    wifiNetworkEnv: 'BSTE_GUEST_WIFI_PEARL_NETWORK',
    wifiPasswordEnv: 'BSTE_GUEST_WIFI_PEARL_PASSWORD'
  },
  ctonic: {
    name: '"C"tonic Ocean View Villa',
    address: '93 Malvern Drive, Struisbaai',
    checkOutWindow: '10:00–12:00',
    parking: 'Please do not park on the street or on the grass in front of the gate, as you may receive a ticket. Open the gate and park one vehicle in the garage, one in front of the garage, or use the open lot.',
    garbage: 'the garbage cradle outside the front fence',
    shopping: 'Pick n Pay and OK in Struisbaai are both very well stocked.',
    smartTv: 'The two Smart TVs are available for you to use — simply log into your own streaming services.',
    importantNote:
      'The pool is for supervised use only and no jumping is allowed because it is shallow.\n\n' +
      'There are three indoor fireplaces. Please never leave a fire unattended and manage smoke on windy days by closing the sliding doors.\n\n' +
      'Please do not lean over the balconies. On very windy days, close the windows and the front sliding door.\n\n' +
      'Only two small dogs are permitted. Please clean up after your pets and do not allow pets on beds or furniture. An additional pet clean-up fee may be charged if required.\n\n' +
      'Guests over 16 years old may not sleep on the bunk beds.\n\n' +
      'The house has an inverter for emergency backup power.',
    wifiNetworkEnv: 'BSTE_GUEST_WIFI_CTONIC_NETWORK',
    wifiPasswordEnv: 'BSTE_GUEST_WIFI_CTONIC_PASSWORD'
  }
});

const SHARED = Object.freeze({
  starterPack: 'We’ll have a small starter pack waiting for you with milk, coffee, sugar, butter and some firewood.',
  firewood: 'If you need more firewood during your stay, you can buy it from the grocery stores or from the sellers on the Plein next to Pick n Pay.',
  water: 'The tap water is safe to drink, although many guests prefer bottled water. Bottled water is available from the grocery stores or from Fibblo in the industrial area.',
  waterWise: 'We’re in a water-critical area, so we really appreciate you using water sparingly during your stay.',
  towels: 'Bath towels and one set of pool towels are supplied. Please don’t use the white towels to remove makeup or sunscreen, as this can permanently stain them. Please use your own towels for the beach.',
  linen: 'If your stay is longer than 7 days, we can arrange a fresh linen change. Just let Bond or Leah know.',
  security: 'Please remember to close the windows and doors and arm the alarm whenever you leave the house.',
  fire: 'If you make a fire, please never leave it unattended. The braai grids are stainless steel, so please don’t allow open flames to touch the grids as this can permanently stain them.',
  rules: 'Please respect our neighbours and the peaceful surroundings. No parties or filming, and quiet hours are from 23:00–07:00.'
});

const PROPERTY_SLUGS = Object.freeze({
  'legacy-suiderstrand': 'legacy',
  'kalay-ridge-villa-struisbaai': 'kalaya',
  'the-pearl-beach-villa-agulhas': 'pearl'
});

export class GuestMessageRenderError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'GuestMessageRenderError';
    this.code = code;
  }
}

function clean(value) {
  return String(value ?? '').trim();
}

function getPropertyKey(booking = {}) {
  const direct = clean(booking.property_key || booking.propertyKey).toLowerCase();
  if (direct && PROPERTIES[direct]) return direct;

  const slug = clean(booking.property_slug || booking.propertySlug).toLowerCase();
  if (PROPERTY_SLUGS[slug]) return PROPERTY_SLUGS[slug];

  throw new GuestMessageRenderError('unknown_property');
}

function getFirstName(booking = {}) {
  const direct = clean(booking.guest_first_name || booking.guestFirstName);
  if (direct) return direct;

  const name = clean(booking.guest_name || booking.guestName);
  if (!name) throw new GuestMessageRenderError('guest_name_missing');
  return name.split(/\s+/)[0];
}

function getGuestCount(booking = {}) {
  const explicit = Number(booking.guest_count ?? booking.guestCount);
  if (Number.isSafeInteger(explicit) && explicit > 0) return explicit;

  const adults = Number(booking.adults ?? 0);
  const children = Number(booking.children ?? 0);
  const total = adults + children;
  if (Number.isSafeInteger(total) && total > 0) return total;

  throw new GuestMessageRenderError('guest_count_missing');
}

function requireDate(value, code) {
  const result = clean(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) {
    throw new GuestMessageRenderError(code);
  }
  return result;
}

function getWifi(property, env) {
  const network = clean(env[property.wifiNetworkEnv]);
  const password = clean(env[property.wifiPasswordEnv]);
  if (!network || !password) {
    throw new GuestMessageRenderError('wifi_secret_missing');
  }
  return { network, password };
}

function buildMessages(booking, env) {
  const property = PROPERTIES[getPropertyKey(booking)];
  const guestFirstName = getFirstName(booking);
  const arrivalDate = requireDate(booking.arrival || booking.arrivalDate, 'arrival_date_missing');
  const departureDate = requireDate(booking.departure || booking.departureDate, 'departure_date_missing');
  const gpsLine = property.gps ? '\n\nGPS coordinates: ' + property.gps : '';
  const commonContact = 'Bond: ' + CONFIG.bondPhone + '\nLeah: ' + CONFIG.leahPhone;

  const messages = {
    booking_confirmed: {
      subject: 'Your stay at ' + property.name + ' is confirmed 🌊',
      body:
        'Hi ' + guestFirstName + ',\n\n' +
        'We’re looking forward to welcoming you to ' + property.name + ' from ' + arrivalDate + ' to ' + departureDate + '.\n\n' +
        'Your reservation is confirmed for ' + getGuestCount(booking) + ' guests.\n\n' +
        'At Boutique Southern Tip Escapes, we personally welcome our guests to the property, show you around and make sure you’re comfortable before handing over the keys.\n\n' +
        'Check-in is between ' + CONFIG.checkInWindow + '. We’ll send you everything you need for your arrival a few days before your stay.\n\n' +
        'If you need anything in the meantime, you’re welcome to contact us:\n\n' +
        commonContact + '\n\n' +
        'We hope you’re looking forward to your time at the Southern Tip as much as we’re looking forward to having you.\n\n' +
        'Bond & Leah\nBoutique Southern Tip Escapes'
    },
    three_days_before: {
      subject: 'Your Southern Tip getaway is almost here 🌊',
      body:
        'Hi ' + guestFirstName + ',\n\n' +
        'Your stay at ' + property.name + ' is just a few days away, so here are a few details to make your arrival easy.\n\n' +
        'Check-in: ' + CONFIG.checkInWindow + '\n\n' +
        'Address: ' + property.address + gpsLine + '\n\n' +
        'Please send us a WhatsApp about 30 minutes before you arrive so that we can meet you at the house, show you around and hand over the keys.\n\n' +
        'Parking:\n' + property.parking + '\n\n' +
        property.shopping + '\n\n' +
        SHARED.starterPack + '\n\n' +
        SHARED.firewood + '\n\n' +
        SHARED.water + '\n\n' +
        'If you need anything before your arrival, you’re welcome to contact us:\n\n' +
        commonContact + '\n\n' +
        'Safe travels — we look forward to welcoming you soon.\n\n' +
        'Bond & Leah\nBoutique Southern Tip Escapes'
    },
    arrival_morning: {
      subject: 'We’re looking forward to welcoming you today 🌊',
      body:
        'Hi ' + guestFirstName + ',\n\n' +
        'Your stay at ' + property.name + ' starts today.\n\n' +
        'Check-in is between ' + CONFIG.checkInWindow + '.\n\n' +
        'The address is:\n\n' +
        property.address + gpsLine + '\n\n' +
        'Please send us a WhatsApp about 30 minutes before you arrive so that we can meet you at the house, show you around, explain anything you need to know and hand over the keys.\n\n' +
        'Parking:\n' + property.parking + '\n\n' +
        'If you’re still doing some last-minute shopping, Pick n Pay and OK in Struisbaai are both well stocked.\n\n' +
        'If you need us at any stage today:\n\n' +
        commonContact + '\n\n' +
        'Safe travels — see you soon.\n\n' +
        'Bond & Leah\nBoutique Southern Tip Escapes'
    },
    day_before_departure: {
      subject: 'We hope you’ve enjoyed your stay 🌊',
      body:
        'Hi ' + guestFirstName + ',\n\n' +
        'We hope you’ve had a wonderful time at ' + property.name + '.\n\n' +
        'Just a quick note ahead of tomorrow’s departure.\n\n' +
        'Check-out is between ' + property.checkOutWindow + '.\n\n' +
        'Please send us a WhatsApp about 30 minutes before you’re ready to leave. We’ll come over to say goodbye, help with loading if needed and collect the keys.\n\n' +
        'Before you leave, we’d really appreciate it if you could:\n\n' +
        '• Gather all used towels and leave them together in the bathroom or bathtub.\n\n' +
        '• Place dirty dishes in the dishwasher and switch it on.\n\n' +
        '• Place your rubbish in ' + property.garbage + '.\n\n' +
        '• Make sure all windows and doors are closed.\n\n' +
        'If you need anything before tomorrow:\n\n' +
        commonContact + '\n\n' +
        'Enjoy your last evening at the Southern Tip.\n\n' +
        'Bond & Leah\nBoutique Southern Tip Escapes'
    },
    checkout_morning: {
      subject: 'Good morning from the Southern Tip 🌊',
      body:
        'Hi ' + guestFirstName + ',\n\n' +
        'We hope you’ve enjoyed your stay at ' + property.name + '.\n\n' +
        'Just a reminder that check-out is between ' + property.checkOutWindow + ' today.\n\n' +
        'Please send us a WhatsApp about 30 minutes before you’re ready to leave so that we can come over, say goodbye and collect the keys.\n\n' +
        'Before leaving, please make sure the dishwasher has been switched on, used towels are together in the bathroom or bathtub, rubbish has been placed in the correct bin area, and all windows and doors are closed.\n\n' +
        'If you need us:\n\n' +
        commonContact + '\n\n' +
        'See you shortly.\n\n' +
        'Bond & Leah\nBoutique Southern Tip Escapes'
    },
    post_stay: {
      subject: 'Thank you for staying with us 🌊',
      body:
        'Hi ' + guestFirstName + ',\n\n' +
        'Thank you for choosing ' + property.name + ' for your stay at the Southern Tip.\n\n' +
        'It was a pleasure having you, and we hope you leave with some wonderful memories of your time here.\n\n' +
        'If you enjoyed your stay, we’d really appreciate you taking a moment to leave us a review on the platform you booked through. Reviews make a huge difference to a small local business like ours and help future guests feel confident booking their stay.\n\n' +
        'Planning another Southern Tip getaway?\n\n' +
        'Next time, you’re welcome to book directly with us at ' + CONFIG.website + '.\n\n' +
        'Boutique Southern Tip Escapes has a growing portfolio of carefully selected luxury homes across Struisbaai, Agulhas and Suiderstrand, so whether you return to the same home or would like to experience somewhere new, we’d love to help you find the right stay.\n\n' +
        'Booking directly also means you’re dealing with Bond and Leah personally, from choosing your home right through to your arrival.\n\n' +
        'We’d love to welcome you back.\n\n' +
        'Safe travels home.\n\n' +
        'Bond & Leah\nBoutique Southern Tip Escapes\n' +
        CONFIG.website
    }
  };

  Object.defineProperty(messages, 'house_essentials', {
    enumerable: true,
    get() {
      const wifi = getWifi(property, env);
      return {
        subject: 'A few house essentials for your stay 🌿',
        body:
          'Hi ' + guestFirstName + ',\n\n' +
          'We hope you’re settling in nicely at ' + property.name + '.\n\n' +
          'Here are a few useful details to keep handy during your stay.\n\n' +
          'Wi-Fi\nNetwork: ' + wifi.network + '\nPassword: ' + wifi.password + '\n\n' +
          property.smartTv + '\n\n' +
          SHARED.security + '\n\n' +
          SHARED.waterWise + '\n\n' +
          SHARED.towels + '\n\n' +
          SHARED.linen + '\n\n' +
          SHARED.fire + '\n\n' +
          SHARED.rules + '\n\n' +
          property.importantNote + '\n\n' +
          'If you need anything at all during your stay:\n\n' +
          commonContact + '\n\n' +
          'Enjoy your stay. 🌊\n\n' +
          'Bond & Leah\nBoutique Southern Tip Escapes'
      };
    }
  });

  return messages;
}

export function renderGuestCommunication({
  booking,
  communication,
  env = process.env
}) {
  if (!booking || typeof booking !== 'object') {
    throw new GuestMessageRenderError('booking_required');
  }
  if (!communication || typeof communication !== 'object') {
    throw new GuestMessageRenderError('communication_required');
  }

  const queueKey = clean(communication.message_key);
  const templateKey = QUEUE_TO_TEMPLATE_KEY[queueKey];
  if (!templateKey) {
    throw new GuestMessageRenderError('unsupported_message_key');
  }

  const message = buildMessages(booking, env)[templateKey];
  if (!message) {
    throw new GuestMessageRenderError('message_template_missing');
  }

  return Object.freeze({
    message_key: queueKey,
    template_key: templateKey,
    property_key: getPropertyKey(booking),
    subject: message.subject,
    body: message.body
  });
}
