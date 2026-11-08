// Find Players cost sharing, in ONE place so the booking, the price preview, the join link and the receipt can never disagree.
//
//   participants = host + players still needed          (host is never counted twice)
//   each share   = FINAL payable booking amount / participants   (after the coupon, never the advance, never the pre-coupon price)
//
// Money is split in MINOR units (paise/cents) so the shares add up to the total EXACTLY. Every joining player pays the same
// base share (floor), and the host — who pays first, online, in full — takes the few leftover minor units. The difference between
// any two shares is therefore at most (participants - 1) minor units, never rupees.
const { toMinor, fromMinor } = require('../utils/money');

const MAX_PLAYERS = 50;

function splitAmount({ totalMajor, playersNeeded, currency = 'INR' }) {
  const players = Math.max(0, Math.min(MAX_PLAYERS, parseInt(playersNeeded, 10) || 0));
  const totalMinor = Math.max(0, toMinor(Number(totalMajor) || 0, currency));
  if (players < 1) return { active: false, participants: 1, players: 0, totalMinor, playerShareMinor: 0, hostShareMinor: totalMinor, playerShare: 0, hostShare: fromMinor(totalMinor, currency), total: fromMinor(totalMinor, currency) };
  const participants = players + 1;
  const playerShareMinor = Math.floor(totalMinor / participants);
  const hostShareMinor = totalMinor - playerShareMinor * players;      // = base share + the remainder
  return {
    active: true, participants, players, totalMinor, playerShareMinor, hostShareMinor,
    playerShare: fromMinor(playerShareMinor, currency), hostShare: fromMinor(hostShareMinor, currency), total: fromMinor(totalMinor, currency),
  };
}

module.exports = { splitAmount, MAX_PLAYERS };
