// Single registry of notification categories and types. Nothing else in the app hardcodes a type string or category.
//
//   category      groups types for user preferences and for the Notification Center
//   audience      who receives it: 'user' | 'owner' | 'admin'
//   push          false = in-app only (used where a push would just repeat another notification sent at the same moment)
//   transactional true = the direct result of something the recipient did / paid for: never suppressed by preferences
//   wired         true = a real backend event emits it today. false = defined for later, deliberately NOT emitted
//                 (Book Arena has no such flow yet - we do not fake one)

const CATEGORIES = {
  BOOKINGS: { label: 'Bookings', description: 'Booking confirmations, changes and cancellations', locked: true },
  PAYMENTS: { label: 'Payments', description: 'Payment results and refunds', locked: true },
  SUBSCRIPTIONS: { label: 'Subscriptions', description: 'Sport and activity subscription status', locked: true },
  TOURNAMENTS: { label: 'Tournaments', description: 'New tournaments, live matches and results', locked: false },
  FIND_PLAYERS: { label: 'Find Players', description: 'Match requests, join requests and approvals', locked: false },
  REMINDERS: { label: 'Reminders', description: 'Upcoming bookings, matches and subscription renewals', locked: false },
  PROMOTIONS: { label: 'Offers and promotions', description: 'Offers, featured venues and campaigns', locked: false },
  SYSTEM: { label: 'Account and system', description: 'Security alerts and important announcements', locked: true },
  ACTIVITIES: { label: 'Activities & tickets', description: 'Ticket bookings, QR tickets and entry updates', locked: true },
};

const t = (category, audience, opts = {}) => ({ category, audience, push: true, transactional: false, wired: true, ...opts });

const TYPES = {
  // ---- bookings (customer)
  BOOKING_CREATED: t('BOOKINGS', 'user', { wired: false }),               // a booking row exists but is unpaid: nothing to announce
  BOOKING_CONFIRMED: t('BOOKINGS', 'user', { transactional: true }),
  BOOKING_CANCELLED: t('BOOKINGS', 'user', { transactional: true }),
  BOOKING_RESCHEDULED: t('BOOKINGS', 'user', { wired: false }),          // no reschedule flow exists yet
  BOOKING_REMINDER: t('REMINDERS', 'user'),

  // ---- payments (customer)
  PAYMENT_INITIATED: t('PAYMENTS', 'user', { push: false }),
  PAYMENT_SUCCESS: t('PAYMENTS', 'user', { push: false }),                // the booking/subscription notification carries the push
  PAYMENT_FAILED: t('PAYMENTS', 'user', { transactional: true }),
  PAYMENT_REFUNDED: t('PAYMENTS', 'user', { wired: false }),             // no refund flow exists yet
  REFUND_INITIATED: t('PAYMENTS', 'user', { wired: false }),
  REFUND_COMPLETED: t('PAYMENTS', 'user', { wired: false }),

  // ---- sport / activity subscriptions (customer)
  SUBSCRIPTION_CREATED: t('SUBSCRIPTIONS', 'user', { wired: false }),    // creation and activation are one verified moment here
  SUBSCRIPTION_ACTIVATED: t('SUBSCRIPTIONS', 'user', { transactional: true }),
  SUBSCRIPTION_PAYMENT_SUCCESS: t('SUBSCRIPTIONS', 'user', { push: false }),
  SUBSCRIPTION_PAYMENT_FAILED: t('SUBSCRIPTIONS', 'user', { transactional: true }),
  SUBSCRIPTION_RENEWAL_REMINDER: t('REMINDERS', 'user'),
  SUBSCRIPTION_EXPIRING: t('REMINDERS', 'user'),
  SUBSCRIPTION_EXPIRED: t('SUBSCRIPTIONS', 'user', { transactional: true }),
  SUBSCRIPTION_CANCELLED: t('SUBSCRIPTIONS', 'user', { transactional: true }),
  SUBSCRIPTION_RENEWED: t('SUBSCRIPTIONS', 'user', { transactional: true }),
  SUBSCRIPTION_RENEWAL_FAILED: t('SUBSCRIPTIONS', 'user', { transactional: true }),
  SUBSCRIPTION_MANUAL_ADDED: t('SUBSCRIPTIONS', 'user', { transactional: true }),   // the venue added the customer as a member
  SUBSCRIPTION_SUSPENDED: t('SUBSCRIPTIONS', 'user', { transactional: true }),

  // ---- tournaments
  TOURNAMENT_CREATED: t('TOURNAMENTS', 'user'),
  TOURNAMENT_REGISTRATION_OPEN: t('TOURNAMENTS', 'user'),
  TOURNAMENT_JOIN_REQUEST: t('TOURNAMENTS', 'any', { transactional: true }),     // to the host (user, owner or admin)
  TOURNAMENT_JOIN_APPROVED: t('TOURNAMENTS', 'user', { transactional: true }),
  TOURNAMENT_JOIN_REJECTED: t('TOURNAMENTS', 'user', { transactional: true }),
  TOURNAMENT_TEAM_ASSIGNED: t('TOURNAMENTS', 'user', { transactional: true }),
  TOURNAMENT_MATCH_SCHEDULED: t('TOURNAMENTS', 'user'),
  TOURNAMENT_MATCH_REMINDER: t('REMINDERS', 'user'),
  TOURNAMENT_MATCH_LIVE: t('TOURNAMENTS', 'user'),
  TOURNAMENT_MATCH_COMPLETED: t('TOURNAMENTS', 'user'),
  TOURNAMENT_COMPLETED: t('TOURNAMENTS', 'user'),
  TOURNAMENT_ANNOUNCEMENT: t('TOURNAMENTS', 'user'),

  // ---- teams (a tournament team is created by the host; players join through the tournament)
  TEAM_CREATED: t('TOURNAMENTS', 'user', { wired: false }),
  TEAM_JOIN_REQUEST: t('TOURNAMENTS', 'user', { wired: false }),
  TEAM_JOIN_APPROVED: t('TOURNAMENTS', 'user', { wired: false }),
  TEAM_JOIN_REJECTED: t('TOURNAMENTS', 'user', { wired: false }),

  // ---- find players (real matches created from bookings)
  MATCH_SCHEDULED: t('FIND_PLAYERS', 'user', { wired: false }),
  MATCH_REMINDER: t('REMINDERS', 'user'),
  MATCH_STARTED: t('FIND_PLAYERS', 'user', { wired: false }),
  MATCH_COMPLETED: t('FIND_PLAYERS', 'user', { wired: false }),
  MATCH_REQUEST_CREATED: t('FIND_PLAYERS', 'user'),
  MATCH_JOIN_REQUEST: t('FIND_PLAYERS', 'user', { transactional: true }),
  MATCH_JOIN_APPROVED: t('FIND_PLAYERS', 'user', { transactional: true }),
  MATCH_JOIN_REJECTED: t('FIND_PLAYERS', 'user', { transactional: true }),
  MATCH_CANCELLED: t('FIND_PLAYERS', 'user', { transactional: true }),

  // ---- owner
  OWNER_NEW_BOOKING: t('BOOKINGS', 'owner', { transactional: true }),
  OWNER_BOOKING_CANCELLED: t('BOOKINGS', 'owner', { transactional: true }),
  OWNER_PAYMENT_RECEIVED: t('PAYMENTS', 'owner', { push: false }),
  OWNER_NEW_SUBSCRIPTION: t('SUBSCRIPTIONS', 'owner', { transactional: true }),
  OWNER_SUBSCRIPTION_PAYMENT_RECEIVED: t('SUBSCRIPTIONS', 'owner', { push: false }),
  OWNER_SUBSCRIPTION_EXPIRING: t('REMINDERS', 'owner'),                   // the owner's own Book Arena plan
  OWNER_SUBSCRIPTION_EXPIRED: t('SUBSCRIPTIONS', 'owner', { transactional: true }),
  OWNER_BILLING_NOTICE: t('PAYMENTS', 'owner', { transactional: true }),
  NEW_TOURNAMENT_REGISTRATION: t('TOURNAMENTS', 'any', { transactional: true }),

  // ---- admin
  ADMIN_NEW_OWNER: t('SYSTEM', 'admin'),
  ADMIN_PAYMENT_ISSUE: t('SYSTEM', 'admin'),

  // ---- system
  SYSTEM_ANNOUNCEMENT: t('SYSTEM', 'user', { transactional: true }),
  SECURITY_ALERT: t('SYSTEM', 'user', { transactional: true }),
  PROMOTION: t('PROMOTIONS', 'user'),

  // ---- activities (ticket-booking engine) — customer
  ACTIVITY_BOOKING_CONFIRMED: t('ACTIVITIES', 'user', { transactional: true }),
  ACTIVITY_BOOKING_CANCELLED: t('ACTIVITIES', 'user', { transactional: true }),
  ACTIVITY_PAYMENT_FAILED: t('ACTIVITIES', 'user', { transactional: true }),
  ACTIVITY_REMINDER: t('REMINDERS', 'user'),
  ACTIVITY_TICKET_REDEEMED: t('ACTIVITIES', 'user', { transactional: true }),
  ACTIVITY_REFUND_PROCESSED: t('PAYMENTS', 'user', { transactional: true }),
  REFUND_INITIATED: t('PAYMENTS', 'user', { transactional: true }),
  REFUND_COMPLETED: t('PAYMENTS', 'user', { transactional: true }),
  REFUND_FAILED: t('PAYMENTS', 'user', { transactional: true }),

  // ---- activities — owner
  OWNER_NEW_ACTIVITY_BOOKING: t('ACTIVITIES', 'owner', { transactional: true }),
  OWNER_ACTIVITY_BOOKING_CANCELLED: t('ACTIVITIES', 'owner', { transactional: true }),
  OWNER_ACTIVITY_DAILY_SUMMARY: t('ACTIVITIES', 'owner', { transactional: true }),
  OWNER_ACTIVITY_REFUND_DUE: t('PAYMENTS', 'owner', { transactional: true }),
  OWNER_ACTIVITY_DECIDED: t('SYSTEM', 'owner', { transactional: true }), // admin approved/rejected/suspended an activity

  // ---- activities — admin
  ADMIN_NEW_ACTIVITY: t('SYSTEM', 'admin'),
};

// Values for filtering / display. Types are exposed as strings equal to their keys.
const TYPE_NAMES = Object.keys(TYPES).reduce((acc, k) => { acc[k] = k; return acc; }, {});

const RECIPIENT_TYPES = ['user', 'owner', 'admin'];

// Optional categories a person can switch off. Locked ones are always on (payments, bookings, security...).
const OPTIONAL_CATEGORIES = Object.keys(CATEGORIES).filter((c) => !CATEGORIES[c].locked);

// A notification ignores the person's preferences when its category is locked or the type is transactional.
function isMandatory(type) {
  const meta = TYPES[type];
  return !!meta && (CATEGORIES[meta.category].locked || meta.transactional);
}

module.exports = { CATEGORIES, TYPES, TYPE_NAMES, RECIPIENT_TYPES, OPTIONAL_CATEGORIES, isMandatory };
