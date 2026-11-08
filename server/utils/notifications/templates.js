// Centralized notification copy. Controllers and event handlers never write messages themselves: they hand this file the
// facts (loaded from the database) and get back { title, message, entityType, entityId, deepLink, imageUrl, metadata }.
//
// Rules for every template: short, plain text, no emoji, and NO sensitive data - no amounts, card details, phone numbers or
// email addresses (push previews are visible on lock screens).

const clip = (s, n) => { const v = String(s == null ? '' : s).trim(); return v.length > n ? `${v.slice(0, n - 1)}…` : v; };
const name = (v, fallback) => clip(v, 60) || fallback;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---- deep links: real Book Arena routes, chosen by who receives the notification ------------------------------
const links = {
  booking: (id, r = 'user') => (r === 'owner' ? `/(owner)/booking/${id}` : `/booking-receipt?id=${id}`),
  subscription: (id, r = 'user') => (r === 'owner' ? '/(owner)/monthly-plans' : `/subscription/${id}`),
  tournament: (slug) => `/tournament/${slug}`,
  liveMatch: (matchId) => `/tournament/live/${matchId}`,
  hostTournament: (id, hostType) => (hostType === 'owner' ? `/(owner)/my-tournaments/${id}` : hostType === 'admin' ? `/(admin)/manage-tournaments/${id}` : `/host/${id}`),
  myMatches: () => '/my-matches',
  findPlayers: () => '/find-players',
  center: (r = 'user') => (r === 'owner' ? '/(owner)/notifications' : '/inbox'),
  adminOwners: () => '/(admin)/owners',
  adminBookings: () => '/(admin)/bookings',
  activityTicket: (bookingId, r = 'user') => (r === 'owner' ? `/(owner)/activity-bookings/${bookingId}` : `/my-tickets/${bookingId}`),
  activityDetail: (slug) => `/activities/${slug}`,
  adminActivities: () => '/(admin)/activities',
};

const refundLink = (d) => (d.bookingType === 'activity' ? links.activityTicket(d.bookingId) : d.bookingType === 'subscription' ? links.subscription(d.bookingId) : links.booking(d.bookingId));
const base = (o) => ({ imageUrl: null, metadata: {}, ...o });

const templates = {
  // ================= bookings =================
  bookingConfirmed: (d) => base({
    title: 'Booking confirmed',
    message: `Your booking at ${name(d.turfName, 'the venue')} is confirmed for ${d.when}.`,
    entityType: 'booking', entityId: d.bookingId, deepLink: links.booking(d.bookingId), imageUrl: d.image,
    metadata: { turf: d.turfName, when: d.when },
  }),
  bookingCancelled: (d) => base({
    title: 'Booking cancelled',
    message: d.reason === 'slot_unavailable'
      ? `Your booking at ${name(d.turfName, 'the venue')} could not be confirmed because the slot is no longer available.`
      : `Your booking at ${name(d.turfName, 'the venue')} for ${d.when} has been cancelled.`,
    entityType: 'booking', entityId: d.bookingId, deepLink: links.booking(d.bookingId), imageUrl: d.image,
  }),
  bookingReminder: (d) => base({
    title: d.hoursBefore >= 24 ? 'Booking tomorrow' : 'Booking reminder',
    message: d.hoursBefore >= 24
      ? `Your booking at ${name(d.turfName, 'the venue')} is ${d.when}.`
      : `Your booking at ${name(d.turfName, 'the venue')} starts in ${d.hoursBefore >= 1 ? plural(Math.round(d.hoursBefore), 'hour') : plural(Math.round(d.hoursBefore * 60), 'minute')} (${d.timeLabel}).`,
    entityType: 'booking', entityId: d.bookingId, deepLink: links.booking(d.bookingId), imageUrl: d.image,
  }),
  ownerNewBooking: (d) => base({
    title: 'New booking',
    message: `${name(d.turfName, 'Your venue')} has a new booking for ${d.when}.`,
    entityType: 'booking', entityId: d.bookingId, deepLink: links.booking(d.bookingId, 'owner'),
  }),
  ownerBookingCancelled: (d) => base({
    title: 'Booking cancelled',
    message: `A booking at ${name(d.turfName, 'your venue')} for ${d.when} was cancelled.`,
    entityType: 'booking', entityId: d.bookingId, deepLink: links.booking(d.bookingId, 'owner'),
  }),
  ownerPaymentReceived: (d) => base({
    title: 'Payment received',
    message: `Payment received for a booking at ${name(d.turfName, 'your venue')}.`,
    entityType: 'booking', entityId: d.bookingId, deepLink: links.booking(d.bookingId, 'owner'),
  }),

  // ================= payments =================
  paymentInitiated: (d) => base({
    title: 'Payment started',
    message: `Payment has been initiated for your booking at ${name(d.turfName, 'the venue')}.`,
    entityType: 'booking', entityId: d.bookingId, deepLink: links.booking(d.bookingId),
  }),
  paymentSuccess: (d) => base({
    title: 'Payment successful',
    message: `Your payment for ${name(d.subject, 'your booking')} was successful.`,
    entityType: d.entityType, entityId: d.entityId, deepLink: d.deepLink,
  }),
  paymentFailed: (d) => base({
    title: 'Payment failed',
    message: `Your payment for ${name(d.subject, 'your booking')} could not be completed.`,
    entityType: d.entityType || 'booking', entityId: d.entityId, deepLink: d.deepLink,
  }),
  paymentRefunded: (d) => base({
    title: 'Refund processed', message: 'Your refund has been processed.',
    entityType: 'booking', entityId: d.bookingId, deepLink: links.booking(d.bookingId),
  }),

  // ================= sport / activity subscriptions =================
  // "plan" is the real plan name from the database, "venue" the real venue, dates come from the subscription row.
  subscriptionActivated: (d) => base({
    title: 'Subscription activated',
    message: `Your ${name(d.plan, 'subscription')} subscription at ${name(d.venue, 'the venue')}${d.sport ? ` (${name(d.sport, '')}${d.court ? `, ${name(d.court, '')}` : ''})` : ''} is active${d.schedule ? `: ${d.schedule}` : ''}. Valid ${d.from} to ${d.until}.${d.amountText ? ` Paid ${d.amountText}.` : ''}`,
    entityType: 'subscription', entityId: d.subscriptionId, deepLink: links.subscription(d.subscriptionId),
    metadata: { plan: d.plan, venue: d.venue, sport: d.sport, start: d.start, end: d.end },
  }),
  subscriptionRenewed: (d) => base({
    title: 'Subscription renewed',
    message: `Your ${name(d.plan, 'subscription')} subscription at ${name(d.venue, 'the venue')} has been renewed. Valid until ${d.until}.${d.amountText ? ` Paid ${d.amountText}.` : ''}`,
    entityType: 'subscription', entityId: d.subscriptionId, deepLink: links.subscription(d.subscriptionId),
    metadata: { plan: d.plan, venue: d.venue, sport: d.sport, start: d.start, end: d.end },
  }),
  subscriptionPaymentSuccess: (d) => base({
    title: 'Subscription payment successful',
    message: `Your payment for ${name(d.plan, 'your subscription')} was successful.`,
    entityType: 'subscription', entityId: d.subscriptionId, deepLink: links.subscription(d.subscriptionId),
  }),
  subscriptionPaymentFailed: (d) => base({
    title: 'Subscription payment failed',
    message: d.reason === 'slot_conflict'
      ? `Your payment for ${name(d.plan, 'your subscription')} went through, but a slot was taken just before it completed, so the subscription was not activated. Your payment is being refunded.`
      : `Your payment for ${name(d.plan, 'your subscription')} could not be completed.`,
    entityType: 'subscription', entityId: d.subscriptionId, deepLink: links.subscription(d.subscriptionId),
  }),
  subscriptionRenewalReminder: (d) => base({
    title: 'Renew your subscription',
    message: `Your ${name(d.plan, 'subscription')} subscription at ${name(d.venue, 'the venue')} expires in ${plural(d.daysLeft, 'day')}.`,
    entityType: 'subscription', entityId: d.subscriptionId, deepLink: links.subscription(d.subscriptionId),
  }),
  subscriptionExpiring: (d) => base({
    title: 'Subscription expiring soon',
    message: d.daysLeft <= 1
      ? `Your ${name(d.plan, 'subscription')} subscription at ${name(d.venue, 'the venue')} expires ${d.daysLeft === 0 ? 'today' : 'tomorrow'}.`
      : `Your ${name(d.plan, 'subscription')} subscription at ${name(d.venue, 'the venue')} is expiring soon (${plural(d.daysLeft, 'day')} left).`,
    entityType: 'subscription', entityId: d.subscriptionId, deepLink: links.subscription(d.subscriptionId),
  }),
  subscriptionRenewalFailed: (d) => base({
    title: 'Renewal payment failed',
    message: `We could not renew your ${name(d.plan, 'subscription')} subscription at ${name(d.venue, 'the venue')}. It stays valid until ${d.until}. Renew before then to keep your slots.`,
    entityType: 'subscription', entityId: d.subscriptionId, deepLink: links.subscription(d.subscriptionId),
  }),
  subscriptionManualAdded: (d) => base({
    title: 'You have a membership',
    message: `${name(d.venue, 'The venue')} added you to ${name(d.plan, 'a subscription')}${d.schedule ? ': ' + d.schedule : ''}. Valid ${d.from} to ${d.until}.`,
    entityType: 'subscription', entityId: d.subscriptionId, deepLink: links.subscription(d.subscriptionId),
  }),
  subscriptionSuspended: (d) => base({
    title: 'Subscription suspended',
    message: `Your ${name(d.plan, 'subscription')} subscription at ${name(d.venue, 'the venue')} has been suspended. Contact the venue for details.`,
    entityType: 'subscription', entityId: d.subscriptionId, deepLink: links.subscription(d.subscriptionId),
  }),
  subscriptionExpired: (d) => base({
    title: 'Subscription expired',
    message: `Your ${name(d.plan, 'subscription')} subscription has expired.`,
    entityType: 'subscription', entityId: d.subscriptionId, deepLink: links.subscription(d.subscriptionId),
  }),
  subscriptionCancelled: (d) => base({
    title: 'Subscription cancelled',
    message: d.cancelledBy === 'owner' ? `${name(d.venue, 'The venue')} cancelled your ${name(d.plan, 'subscription')} subscription. Any refund due is on its way.`
      : d.cancelledBy === 'admin' ? `Your ${name(d.plan, 'subscription')} subscription at ${name(d.venue, 'the venue')} was cancelled by Book Arena. Any refund due is on its way.`
      : `Your ${name(d.plan, 'subscription')} subscription has been cancelled.`,
    entityType: 'subscription', entityId: d.subscriptionId, deepLink: links.subscription(d.subscriptionId),
  }),
  ownerNewSubscription: (d) => base({
    title: 'New subscriber',
    message: `A customer subscribed to ${name(d.plan, 'a plan')} at ${name(d.venue, 'your venue')}${d.schedule ? ` (${d.schedule})` : ''}.`,
    entityType: 'subscription', entityId: d.subscriptionId, deepLink: links.subscription(d.subscriptionId, 'owner'),
  }),
  ownerSubscriptionPaymentReceived: (d) => base({
    title: 'Subscription payment received',
    message: `Subscription payment received for ${name(d.plan, 'a plan')}.`,
    entityType: 'subscription', entityId: d.subscriptionId, deepLink: links.subscription(d.subscriptionId, 'owner'),
  }),
  ownerBillingNotice: (d) => {
    const titles = {
      NEW_SUBSCRIPTION_ASSIGNED: 'Venue subscription assigned',
      PAYMENT_DUE_SOON: 'Venue payment due soon',
      PAYMENT_OVERDUE: 'Venue payment overdue',
      PAYMENT_FAILED: 'Venue payment needs attention',
      SUBSCRIPTION_EXPIRING: 'Venue subscription expiring soon',
      ACCOUNT_RESTRICTION_WARNING: 'Venue account restriction warning',
      BOOKING_RESTRICTION_APPLIED: 'New bookings temporarily restricted',
      BOOKING_RESTRICTION_REMOVED: 'New bookings are available again',
      PAYMENT_RECEIVED: 'Venue payment received',
    };
    const venue = name(d.venue, 'Your venue');
    const plan = name(d.plan, 'Venue billing');
    const restrictionMessage = d.noticeKind === 'BOOKING_RESTRICTION_APPLIED'
      ? `${venue}: New bookings are temporarily blocked because of an overdue billing cycle${d.reason ? ` (${d.reason})` : ''}. Existing and confirmed bookings, your owner panel, billing, and history remain available.`
      : d.noticeKind === 'BOOKING_RESTRICTION_REMOVED'
        ? `${venue}: The new-bookings restriction has been removed. New bookings are available again. Existing bookings remain unchanged.`
        : null;
    return base({
      title: titles[d.noticeKind] || 'Venue billing update',
      message: restrictionMessage || `${venue}: ${plan}. Open Venue Billing to review the amount, due date, and next steps.`,
      entityType: 'venue_billing', entityId: d.turfId,
      deepLink: `/(owner)/venue-billing?turf_id=${encodeURIComponent(d.turfId || '')}`,
      metadata: { notice_kind: d.noticeKind, amount_minor: d.amountMinor ?? null, currency: d.currency || null, due_date: d.dueDate || null, reason: d.reason || null, expected_impact: d.expectedImpact || null },
    });
  },
  // the owner's OWN Book Arena platform plan (owner_subscriptions) - not a customer subscription
  ownerPlatformExpiring: (d) => base({
    title: 'Your Book Arena plan is expiring',
    message: `Your Book Arena ${name(d.plan, '')} plan ${d.daysLeft <= 0 ? 'expires today' : `expires in ${plural(d.daysLeft, 'day')}`}.`.replace('  ', ' '),
    entityType: 'owner_subscription', entityId: d.subscriptionId, deepLink: '/(owner)/earnings',
  }),
  ownerPlatformExpired: (d) => base({
    title: 'Your Book Arena plan has expired',
    message: `Your Book Arena ${name(d.plan, '')} plan has expired.`.replace('  ', ' '),
    entityType: 'owner_subscription', entityId: d.subscriptionId, deepLink: '/(owner)/earnings',
  }),

  // ================= tournaments =================
  tournamentCreated: (d) => base({
    title: `New ${name(d.sport, 'sports')} tournament${d.nearby ? ' near you' : ''}`,
    message: `${name(d.name, 'A tournament')} is now open for registration.`,
    entityType: 'tournament', entityId: d.tournamentId, deepLink: links.tournament(d.slug), imageUrl: d.image,
  }),
  tournamentRegistrationOpen: (d) => base({
    title: 'Registration is open',
    message: `Registration for ${name(d.name, 'the tournament')} is open again.`,
    entityType: 'tournament', entityId: d.tournamentId, deepLink: links.tournament(d.slug),
  }),
  tournamentJoinRequest: (d) => base({
    title: 'New tournament join request',
    message: `${name(d.playerName, 'A player')} asked to join ${name(d.name, 'your tournament')}.`,
    entityType: 'tournament', entityId: d.tournamentId, deepLink: links.hostTournament(d.tournamentId, d.hostType),
  }),
  newTournamentRegistration: (d) => base({
    title: 'New team registered',
    message: `A team registered for ${name(d.name, 'your tournament')}.`,
    entityType: 'tournament', entityId: d.tournamentId, deepLink: links.hostTournament(d.tournamentId, d.hostType),
  }),
  tournamentJoinApproved: (d) => base({
    title: 'You are in',
    message: `You're approved for ${name(d.name, 'the tournament')}.`,
    entityType: 'tournament', entityId: d.tournamentId, deepLink: links.tournament(d.slug),
  }),
  tournamentJoinRejected: (d) => base({
    title: 'Join request update',
    message: `Your request to join ${name(d.name, 'the tournament')} was not approved.`,
    entityType: 'tournament', entityId: d.tournamentId, deepLink: links.tournament(d.slug),
  }),
  tournamentTeamAssigned: (d) => base({
    title: 'Team assigned',
    message: `You've been added to ${name(d.teamName, 'a team')} in ${name(d.name, 'the tournament')}.`,
    entityType: 'tournament', entityId: d.tournamentId, deepLink: links.tournament(d.slug),
  }),
  tournamentMatchScheduled: (d) => base({
    title: 'Match scheduled',
    message: `${name(d.teamA, 'Team A')} vs ${name(d.teamB, 'Team B')}${d.when ? ` on ${d.when}` : ''} in ${name(d.name, 'the tournament')}.`,
    entityType: 'match', entityId: d.matchId, deepLink: links.tournament(d.slug),
  }),
  tournamentMatchReminder: (d) => base({
    title: 'Match reminder',
    message: `${name(d.teamA, 'Team A')} vs ${name(d.teamB, 'Team B')} starts ${d.hoursBefore >= 24 ? 'tomorrow' : `in ${d.hoursBefore >= 1 ? plural(Math.round(d.hoursBefore), 'hour') : plural(Math.round(d.hoursBefore * 60), 'minute')}`}${d.timeLabel ? ` (${d.timeLabel})` : ''}.`,
    entityType: 'match', entityId: d.matchId, deepLink: links.liveMatch(d.matchId),
  }),
  tournamentMatchLive: (d) => base({
    title: `${name(d.name, 'Tournament')} is LIVE`,
    message: `${name(d.teamA, 'Team A')} vs ${name(d.teamB, 'Team B')} has started.`,
    entityType: 'match', entityId: d.matchId, deepLink: links.liveMatch(d.matchId),
  }),
  tournamentMatchCompleted: (d) => base({
    title: 'Match finished',
    message: `${name(d.teamA, 'Team A')} ${d.scoreA} - ${d.scoreB} ${name(d.teamB, 'Team B')} · ${name(d.name, 'Tournament')}.`,
    entityType: 'match', entityId: d.matchId, deepLink: links.liveMatch(d.matchId),
  }),
  tournamentCompleted: (d) => base({
    title: 'Tournament completed',
    message: `${name(d.name, 'The tournament')} has finished. See the final results.`,
    entityType: 'tournament', entityId: d.tournamentId, deepLink: links.tournament(d.slug),
  }),
  tournamentAnnouncement: (d) => base({
    title: name(d.title, 'Tournament announcement'),
    message: `${name(d.name, 'Tournament')}: ${clip(d.content, 200)}`,
    entityType: 'tournament', entityId: d.tournamentId, deepLink: links.tournament(d.slug),
  }),

  // ================= find players =================
  matchRequestCreated: (d) => base({
    title: d.sport ? `🏏 ${name(d.sport, 'Sports')} match needs players!` : '🏏 Players Needed!',
    message: `A ${name(d.sport, '')} match at ${name(d.turfName, 'a venue')} needs ${d.needed ? `${d.needed} more ` : ''}players. ${d.when ? `${d.when} • ` : ''}${d.contributionAmount ? `Approx. ₹${d.contributionAmount}/person. ` : ''}Tap to join.`,
    entityType: 'match_request', entityId: d.matchRequestId, deepLink: links.findPlayers(),
  }),
  matchJoinRequest: (d) => base({
    title: d.joined ? 'Player joined your match' : 'New join request',
    message: d.joined
      ? `${name(d.playerName, 'A player')} joined your match at ${name(d.turfName, 'the venue')}.`
      : `${name(d.playerName, 'A player')} wants to join your match at ${name(d.turfName, 'the venue')}.`,
    entityType: 'match_request', entityId: d.matchRequestId, deepLink: links.myMatches(),
  }),
  matchJoinApproved: (d) => base({
    title: 'Request approved',
    message: `Your request to join the match at ${name(d.turfName, 'the venue')} was approved.`,
    entityType: 'match_request', entityId: d.matchRequestId, deepLink: links.myMatches(),
  }),
  matchJoinRejected: (d) => base({
    title: 'Request not approved',
    message: `Your request to join the match at ${name(d.turfName, 'the venue')} was rejected.`,
    entityType: 'match_request', entityId: d.matchRequestId, deepLink: links.myMatches(),
  }),
  matchCancelled: (d) => base({
    title: 'Match cancelled',
    message: `The match at ${name(d.turfName, 'the venue')}${d.when ? ` (${d.when})` : ''} has been cancelled.`,
    entityType: 'match_request', entityId: d.matchRequestId, deepLink: links.myMatches(),
  }),
  matchReminder: (d) => base({
    title: 'Match reminder',
    message: `Your match at ${name(d.turfName, 'the venue')} starts in ${plural(Math.round(d.hoursBefore), 'hour')} (${d.timeLabel}).`,
    entityType: 'match_request', entityId: d.matchRequestId, deepLink: links.myMatches(),
  }),

  // ================= admin / system =================
  adminNewOwner: (d) => base({
    title: 'New owner registration',
    message: `${name(d.ownerName, 'An owner')} registered${d.pending ? ' and is waiting for approval' : ''}.`,
    entityType: 'owner', entityId: d.ownerId, deepLink: links.adminOwners(),
  }),
  adminPaymentIssue: (d) => base({
    title: 'Payment issue needs attention',
    message: clip(d.summary || 'A payment transfer failed.', 200),
    entityType: d.entityType || 'payment', entityId: d.entityId, deepLink: '/(admin)/payouts',
  }),
  systemAnnouncement: (d) => base({
    title: name(d.title, 'Announcement'), message: clip(d.message, 400),
    entityType: d.entityType || 'system', entityId: d.entityId, deepLink: d.deepLink || links.center(d.recipientType),
  }),
  securityAlert: (d) => base({
    title: name(d.title, 'Security alert'), message: clip(d.message, 300),
    entityType: 'security', deepLink: links.center(d.recipientType),
  }),
  promotion: (d) => base({
    title: name(d.title, 'Offer'), message: clip(d.message, 400),
    entityType: 'promotion', deepLink: d.deepLink || links.center(d.recipientType),
  }),

  // ================= activities (ticket-booking engine) =================
  activityBookingConfirmed: (d) => base({
    title: 'Tickets confirmed',
    message: `Your tickets for ${name(d.activityName, 'your activity')} on ${d.when} are confirmed. Booking ${d.bookingCode}.`,
    entityType: 'activity_booking', entityId: d.bookingId, deepLink: links.activityTicket(d.bookingId), imageUrl: d.image,
  }),
  activityBookingCancelled: (d) => base({
    title: 'Booking cancelled',
    message: d.reason === 'sold_out'
      ? `Your booking for ${name(d.activityName, 'the activity')} could not be confirmed because it sold out. You will be refunded.`
      : `Your booking for ${name(d.activityName, 'the activity')} (${d.bookingCode}) was cancelled.`,
    entityType: 'activity_booking', entityId: d.bookingId, deepLink: links.activityTicket(d.bookingId),
  }),
  activityPaymentFailed: (d) => base({
    title: 'Payment failed',
    message: `Your payment for ${name(d.activityName, 'your activity booking')} could not be completed.`,
    entityType: 'activity_booking', entityId: d.bookingId, deepLink: links.activityTicket(d.bookingId),
  }),
  activityReminder: (d) => base({
    title: Number(d.hoursBefore) <= 6 ? 'Activity today' : 'Activity tomorrow',
    message: Number(d.hoursBefore) <= 6
      ? `${name(d.activityName, 'Your activity')} starts soon. Keep your QR ticket handy.`
      : `Your ${name(d.activityName, 'activity')} booking is tomorrow (${d.when}). Keep your QR ticket handy.`,
    entityType: 'activity_booking', entityId: d.bookingId, deepLink: links.activityTicket(d.bookingId),
  }),
  // Refund copy states the amount in the booking's own currency (product requirement; the customer asked for it by name).
  refundInitiated: (d) => base({
    title: 'Refund initiated',
    message: `Refund of ${d.amountText} has been initiated. It may take 4–5 business days to reach your original payment method, depending on your bank/payment provider.`,
    entityType: 'refund', entityId: d.refundId, deepLink: refundLink(d),
  }),
  refundCompleted: (d) => base({
    title: 'Refund processed',
    message: `Your refund of ${d.amountText} has been processed. It may take 4–5 business days to appear in your account.`,
    entityType: 'refund', entityId: d.refundId, deepLink: refundLink(d),
  }),
  refundFailed: (d) => base({
    title: 'Refund delayed',
    message: "We couldn't complete your refund automatically. Our team is processing it.",
    entityType: 'refund', entityId: d.refundId, deepLink: refundLink(d),
  }),
  activityTicketRedeemed: (d) => base({
    title: 'Entry confirmed',
    message: `Your ticket for ${name(d.activityName, 'the activity')} has been redeemed. Enjoy!`,
    entityType: 'activity_booking', entityId: d.bookingId, deepLink: links.activityTicket(d.bookingId),
  }),
  activityRefundProcessed: (d) => base({
    title: 'Refund processed',
    message: `Your refund of ₹${d.amount} for ${name(d.activityName, 'your activity booking')} (${d.bookingCode}) has been processed.`,
    entityType: 'activity_booking', entityId: d.bookingId, deepLink: links.activityTicket(d.bookingId),
  }),
  ownerActivityDailySummary: (d) => base({
    title: 'Today at your activities',
    message: `${d.bookings} booking${d.bookings === 1 ? '' : 's'} for today, ${d.entries}/${d.tickets} guests entered, ₹${d.revenue} in sales.`,
    entityType: 'activity', entityId: d.ownerId, deepLink: '/(owner)/activities',
  }),
  ownerActivityRefundDue: (d) => base({
    title: 'Refund to process',
    message: `${d.bookingCode} at ${name(d.activityName, 'your activity')} was cancelled. A refund of ₹${d.amount} is pending.`,
    entityType: 'activity_booking', entityId: d.bookingId, deepLink: links.activityTicket(d.bookingId, 'owner'),
  }),
  ownerNewActivityBooking: (d) => base({
    title: d.guests >= 10 ? 'Large group booking' : 'New ticket booking',
    message: `${name(d.activityName, 'Your activity')} has a new ${d.guests >= 10 ? `group booking (${d.guests} guests)` : 'booking'} for ${d.when}.`,
    entityType: 'activity_booking', entityId: d.bookingId, deepLink: links.activityTicket(d.bookingId, 'owner'),
  }),
  ownerActivityBookingCancelled: (d) => base({
    title: 'Booking cancelled',
    message: `A booking at ${name(d.activityName, 'your activity')} (${d.bookingCode}) was cancelled.`,
    entityType: 'activity_booking', entityId: d.bookingId, deepLink: links.activityTicket(d.bookingId, 'owner'),
  }),
  ownerActivityDecided: (d) => base({
    title: d.decision === 'approved' ? 'Activity approved' : d.decision === 'rejected' ? 'Activity not approved' : 'Activity suspended',
    message: d.decision === 'approved' ? `${name(d.activityName, 'Your activity')} is now live and bookable.`
      : d.decision === 'rejected' ? `${name(d.activityName, 'Your activity')} was not approved. Contact support for details.`
      : `${name(d.activityName, 'Your activity')} has been suspended.`,
    entityType: 'activity', entityId: d.activityId, deepLink: '/(owner)/activities',
  }),
  adminNewActivity: (d) => base({
    title: 'New activity awaiting review',
    message: `${name(d.ownerName, 'An owner')} submitted ${name(d.activityName, 'a new activity')} for approval.`,
    entityType: 'activity', entityId: d.activityId, deepLink: links.adminActivities(),
  }),
};

// notification type -> template
const BY_TYPE = {
  BOOKING_CONFIRMED: templates.bookingConfirmed,
  BOOKING_CANCELLED: templates.bookingCancelled,
  BOOKING_REMINDER: templates.bookingReminder,
  OWNER_NEW_BOOKING: templates.ownerNewBooking,
  OWNER_BOOKING_CANCELLED: templates.ownerBookingCancelled,
  OWNER_PAYMENT_RECEIVED: templates.ownerPaymentReceived,
  PAYMENT_INITIATED: templates.paymentInitiated,
  PAYMENT_SUCCESS: templates.paymentSuccess,
  PAYMENT_FAILED: templates.paymentFailed,
  PAYMENT_REFUNDED: templates.paymentRefunded,
  SUBSCRIPTION_ACTIVATED: templates.subscriptionActivated,
  SUBSCRIPTION_RENEWED: templates.subscriptionRenewed,
  SUBSCRIPTION_RENEWAL_FAILED: templates.subscriptionRenewalFailed,
  SUBSCRIPTION_MANUAL_ADDED: templates.subscriptionManualAdded,
  SUBSCRIPTION_SUSPENDED: templates.subscriptionSuspended,
  SUBSCRIPTION_PAYMENT_SUCCESS: templates.subscriptionPaymentSuccess,
  SUBSCRIPTION_PAYMENT_FAILED: templates.subscriptionPaymentFailed,
  SUBSCRIPTION_RENEWAL_REMINDER: templates.subscriptionRenewalReminder,
  SUBSCRIPTION_EXPIRING: templates.subscriptionExpiring,
  SUBSCRIPTION_EXPIRED: templates.subscriptionExpired,
  SUBSCRIPTION_CANCELLED: templates.subscriptionCancelled,
  OWNER_NEW_SUBSCRIPTION: templates.ownerNewSubscription,
  OWNER_SUBSCRIPTION_PAYMENT_RECEIVED: templates.ownerSubscriptionPaymentReceived,
  OWNER_SUBSCRIPTION_EXPIRING: templates.ownerPlatformExpiring,
  OWNER_SUBSCRIPTION_EXPIRED: templates.ownerPlatformExpired,
  OWNER_BILLING_NOTICE: templates.ownerBillingNotice,
  TOURNAMENT_CREATED: templates.tournamentCreated,
  TOURNAMENT_REGISTRATION_OPEN: templates.tournamentRegistrationOpen,
  TOURNAMENT_JOIN_REQUEST: templates.tournamentJoinRequest,
  NEW_TOURNAMENT_REGISTRATION: templates.newTournamentRegistration,
  TOURNAMENT_JOIN_APPROVED: templates.tournamentJoinApproved,
  TOURNAMENT_JOIN_REJECTED: templates.tournamentJoinRejected,
  TOURNAMENT_TEAM_ASSIGNED: templates.tournamentTeamAssigned,
  TOURNAMENT_MATCH_SCHEDULED: templates.tournamentMatchScheduled,
  TOURNAMENT_MATCH_REMINDER: templates.tournamentMatchReminder,
  TOURNAMENT_MATCH_LIVE: templates.tournamentMatchLive,
  TOURNAMENT_MATCH_COMPLETED: templates.tournamentMatchCompleted,
  TOURNAMENT_COMPLETED: templates.tournamentCompleted,
  TOURNAMENT_ANNOUNCEMENT: templates.tournamentAnnouncement,
  MATCH_REQUEST_CREATED: templates.matchRequestCreated,
  MATCH_JOIN_REQUEST: templates.matchJoinRequest,
  MATCH_JOIN_APPROVED: templates.matchJoinApproved,
  MATCH_JOIN_REJECTED: templates.matchJoinRejected,
  MATCH_CANCELLED: templates.matchCancelled,
  MATCH_REMINDER: templates.matchReminder,
  ADMIN_NEW_OWNER: templates.adminNewOwner,
  ADMIN_PAYMENT_ISSUE: templates.adminPaymentIssue,
  SYSTEM_ANNOUNCEMENT: templates.systemAnnouncement,
  SECURITY_ALERT: templates.securityAlert,
  PROMOTION: templates.promotion,
  ACTIVITY_BOOKING_CONFIRMED: templates.activityBookingConfirmed,
  ACTIVITY_BOOKING_CANCELLED: templates.activityBookingCancelled,
  ACTIVITY_PAYMENT_FAILED: templates.activityPaymentFailed,
  ACTIVITY_REMINDER: templates.activityReminder,
  ACTIVITY_TICKET_REDEEMED: templates.activityTicketRedeemed,
  ACTIVITY_REFUND_PROCESSED: templates.activityRefundProcessed,
  REFUND_INITIATED: templates.refundInitiated,
  REFUND_COMPLETED: templates.refundCompleted,
  REFUND_FAILED: templates.refundFailed,
  OWNER_ACTIVITY_DAILY_SUMMARY: templates.ownerActivityDailySummary,
  OWNER_ACTIVITY_REFUND_DUE: templates.ownerActivityRefundDue,
  OWNER_NEW_ACTIVITY_BOOKING: templates.ownerNewActivityBooking,
  OWNER_ACTIVITY_BOOKING_CANCELLED: templates.ownerActivityBookingCancelled,
  OWNER_ACTIVITY_DECIDED: templates.ownerActivityDecided,
  ADMIN_NEW_ACTIVITY: templates.adminNewActivity,
};

function render(type, data) {
  const fn = BY_TYPE[type];
  if (!fn) throw new Error(`No notification template for type ${type}`);
  return fn(data || {});
}

module.exports = { templates, links, render, BY_TYPE };
