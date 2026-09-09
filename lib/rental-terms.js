import crypto from 'crypto';

export const RENTAL_TERMS_VERSION = 'BSTE-STR-2026-09-09-v1';

export const RENTAL_TERMS_SECTIONS = [
  {
    number:'1',
    title:'Definitions and booking particulars',
    body:[
      '“Property” means the accommodation identified in the booking summary. “Booking Summary” means the confirmed property, dates, guest numbers, price and renter details shown during checkout.',
      'If the Booking Summary and this Agreement differ on property, dates, guest numbers or price, the Booking Summary prevails. Any special written variation confirmed by Boutique Southern Tip Escapes also prevails for that specific booking.'
    ]
  },
  {
    number:'2',
    title:'Parties and authority',
    body:[
      'Agent/Manager: Boutique Southern Tip Escapes, acting on behalf of blfStudios Pty Ltd.',
      'Owner: the legal owner of the Property.',
      'Renter: the person making the booking and accepting this Agreement. The Renter confirms that they are at least 18 years old, have legal capacity to contract, and accept responsibility for all members of their party.'
    ]
  },
  {
    number:'3',
    title:'Booking and payment',
    body:[
      'A booking is not finally confirmed until the required payment has been successfully received and this Agreement has been electronically accepted.',
      'A 50% deposit is required to secure a booking. The remaining 50% is due 7 days before Check-In. If a booking is made within 7 days of Check-In, the full amount is due immediately.',
      'All amounts are payable in South African Rand (ZAR). The Renter is responsible for bank, foreign-exchange and transfer charges so that Boutique Southern Tip Escapes receives the full amount due.',
      'If any balance remains unpaid after the due date, the Agent/Manager may cancel the booking after reasonable notice to the Renter.'
    ]
  },
  {
    number:'4',
    title:'Cancellation and changes',
    emphasis:true,
    body:[
      'The 50% deposit is an advance deposit and may be applied toward a reasonable cancellation charge. It is not automatically refundable when the Renter cancels.',
      'Where the Consumer Protection Act 68 of 2008 applies, any cancellation charge will be reasonable in the circumstances, taking into account the nature of the booking, the length of notice, the likelihood of re-booking the Property, and other relevant factors.',
      'If the Renter cancels, shortens the stay or does not arrive, the Agent/Manager may retain amounts reasonably due under the cancellation policy and applicable law. If cancelled dates are successfully re-booked, the Agent/Manager may credit or refund an appropriate amount after deducting reasonable costs.',
      'Changes to dates, guest numbers or the Property are subject to availability and written approval and may change the price.'
    ]
  },
  {
    number:'5',
    title:'Check-in and check-out',
    body:[
      'Check-In is between 14:00 and 16:00 on the Arrival Date unless otherwise agreed in writing.',
      'Check-Out is between 10:00 and 11:00 on the Departure Date unless otherwise agreed in writing.',
      'Late departure, lost keys, remotes or access devices may result in reasonable additional charges where they cause loss, replacement cost or delayed turnover.'
    ]
  },
  {
    number:'6',
    title:'Occupancy, visitors and house rules',
    body:[
      'Only the persons included in the booking may stay overnight, and the maximum occupancy for the Property may not be exceeded.',
      'The Renter may not sublet, assign or transfer the booking, or permit any event, party, function, commercial activity or gathering beyond the agreed occupancy without prior written approval.',
      'Quiet hours are 23:00 to 07:00. Noise must be kept at a considerate level at all times and the Renter must respect neighbours, estate rules and local regulations.',
      'Smoking indoors is prohibited. Pets are prohibited unless the specific Property listing or written confirmation expressly allows them.',
      'Illegal activity, dangerous conduct, tampering with security systems, or conduct that materially disturbs neighbours may result in immediate termination of the stay without refund, subject to applicable law.',
      'The Renter is responsible for ensuring that every guest and visitor complies with this Agreement and any property-specific house rules provided before or at Check-In.'
    ]
  },
  {
    number:'7',
    title:'Care of the Property, damage and extraordinary cleaning',
    emphasis:true,
    body:[
      'The Renter must take reasonable care of the Property, its furniture, fixtures, appliances, linen, outdoor areas and equipment.',
      'The Renter is responsible for damage, breakage, loss or extraordinary cleaning reasonably attributable to the acts or omissions of the Renter, their guests or visitors, excluding fair wear and tear.',
      'This includes, where applicable, stains, burns, smoke or odour treatment, damaged linen or upholstery, broken fittings, damage to landscaping, missing items, lost keys or remotes, and cleaning materially beyond a normal turnover clean.',
      'Where a security deposit applies, reasonable amounts may be deducted from it. Otherwise, substantiated charges may be invoiced to the Renter and are payable on presentation of supporting details. PayFast or another payment provider will not be treated as an unrestricted authority to charge a card without the Renter’s lawful authorisation.'
    ]
  },
  {
    number:'8',
    title:'Safety notice and use of amenities',
    emphasis:true,
    body:[
      'COASTAL HOMES AND HOLIDAY PROPERTIES MAY INCLUDE STAIRS, BALCONIES, SLIPPERY SURFACES, BRAAIS, FIREPLACES, GAS APPLIANCES, POOLS OR WATER FEATURES, AND MAY BE CLOSE TO THE OCEAN OR OTHER NATURAL HAZARDS.',
      'The Renter must use all facilities responsibly, follow safety instructions, supervise children and vulnerable guests, and take particular care around water, fire, balconies, stairs and outdoor areas.',
      'The Renter acknowledges these ordinary holiday-home and coastal risks and accepts responsibility for reasonable personal precautions. Nothing in this Agreement excludes or limits liability that may not lawfully be excluded, including liability for gross negligence where applicable.'
    ]
  },
  {
    number:'9',
    title:'Access, maintenance and emergencies',
    body:[
      'The Agent/Manager, Owner or authorised service provider may enter the Property where reasonably necessary for an emergency, urgent repair, safety or security issue, or to prevent material damage. Where practicable, reasonable notice will be given.',
      'The Renter must promptly report material damage, leaks, faults, security incidents or safety concerns and must not arrange major repairs or alterations without approval except where immediately necessary to prevent serious harm.'
    ]
  },
  {
    number:'10',
    title:'Utilities, internet and third-party services',
    body:[
      'Electricity, water, internet, mobile reception and other third-party services can be interrupted for reasons outside the reasonable control of the Agent/Manager or Owner.',
      'The Agent/Manager will take reasonable steps to assist with material service failures but does not guarantee uninterrupted third-party utilities or connectivity. A temporary interruption does not automatically entitle the Renter to a refund unless required by applicable law or the failure materially prevents use of the Property.'
    ]
  },
  {
    number:'11',
    title:'Liability and insurance',
    emphasis:true,
    body:[
      'Guests use the Property and its amenities with reasonable care and at their own risk to the extent permitted by law.',
      'The Agent/Manager and Owner are not liable for loss, theft, injury or damage caused by the Renter, other guests, third parties, criminal acts, natural conditions or events outside their reasonable control.',
      'Nothing in this Agreement excludes or limits liability that cannot lawfully be excluded or limited, including liability for gross negligence where applicable.',
      'The Renter is strongly encouraged to maintain appropriate travel, medical, personal-property and cancellation insurance.'
    ]
  },
  {
    number:'12',
    title:'Complaints and opportunity to remedy',
    body:[
      'Any material problem affecting the stay should be reported to Boutique Southern Tip Escapes as soon as reasonably possible so that there is an opportunity to investigate and remedy it.',
      'A complaint first raised only after departure may be harder to investigate, but this clause does not remove any statutory consumer right.'
    ]
  },
  {
    number:'13',
    title:'Force majeure and Property unavailability',
    body:[
      'Neither party is liable for delay or failure caused by circumstances beyond reasonable control, provided reasonable steps are taken to reduce the impact.',
      'If the Property becomes materially unavailable or uninhabitable before or during the stay for reasons not caused by the Renter, the Agent/Manager may offer a reasonably comparable alternative. If no suitable alternative is accepted or available, amounts paid for accommodation that cannot be supplied will be dealt with fairly and in accordance with applicable law.'
    ]
  },
  {
    number:'14',
    title:'Privacy and personal information',
    body:[
      'Boutique Southern Tip Escapes processes personal information for booking administration, payment, guest communication, legal and safety purposes, and to perform the accommodation contract.',
      'Personal information will be handled in accordance with the Protection of Personal Information Act 4 of 2013 (POPIA) and other applicable law. Only information reasonably necessary for these purposes should be collected and retained.',
      'Information may be shared where reasonably necessary with the Owner, payment providers, channel managers, booking platforms and service providers involved in delivering the stay, subject to appropriate safeguards.',
      'Marketing consent is separate from acceptance of this Agreement. The Renter is not required to agree to marketing in order to book.'
    ]
  },
  {
    number:'15',
    title:'Electronic acceptance and records',
    body:[
      'The Renter agrees that this Agreement may be accepted electronically. Typing the Renter’s full name, actively confirming acceptance and proceeding to payment are intended to identify the Renter and record approval of these terms.',
      'Boutique Southern Tip Escapes may retain the Agreement version, acceptance timestamp and associated booking record as evidence of acceptance, subject to applicable privacy law.',
      'A free electronic copy of the terms applicable to the booking will remain available to the Renter.'
    ]
  },
  {
    number:'16',
    title:'Governing law and consumer rights',
    body:[
      'This Agreement is governed by the laws of South Africa.',
      'Nothing in this Agreement waives or limits any right or remedy that the Renter has under the Consumer Protection Act 68 of 2008 or other applicable law.',
      'The parties submit disputes to the competent courts or other lawful consumer dispute-resolution bodies in South Africa, without limiting any statutory right to approach a regulator, tribunal or other forum.'
    ]
  },
  {
    number:'17',
    title:'General',
    body:[
      'This Agreement, the Booking Summary, property-specific house rules and any written special conditions accepted by both parties form the agreement for the stay.',
      'If any provision is found invalid or unenforceable, the remaining provisions continue to apply.',
      'Any waiver or variation must be confirmed in writing. A failure to enforce a provision on one occasion does not permanently waive that provision.'
    ]
  }
];

export function rentalTermsDigest() {
  const canonical = JSON.stringify({
    version:RENTAL_TERMS_VERSION,
    sections:RENTAL_TERMS_SECTIONS
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}
