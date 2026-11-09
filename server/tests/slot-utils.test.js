const assert = require('assert');
const { _test } = require('../routes/turfs');
const { computeOwnerMarkup } = require('../utils/pricing');

const {
  parseMinutes,
  formatSlotClock,
  generateSlots,
  resolveSlotPrice,
  sortSlotsInSection
} = _test;

const SLOT_SECTIONS = [
  { key: 'early-morning', start_time: '00:00', end_time: '06:00' },
  { key: 'morning', start_time: '06:00', end_time: '12:00' },
  { key: 'afternoon', start_time: '12:00', end_time: '18:00' },
  { key: 'evening-night', start_time: '18:00', end_time: '24:00' }
];

function getSlotSection(slotTime, sections) {
  if (!sections || !Array.isArray(sections)) return 'evening-night';
  const [start] = String(slotTime).split(' - ');
  const startMins = parseMinutes(start || slotTime);

  for (const section of sections) {
    const sStart = parseMinutes(section.start_time);
    const sEnd = parseMinutes(section.end_time);
    if (sStart > sEnd) {
      if (startMins >= sStart || startMins < sEnd) {
        return section.key;
      }
    } else {
      if (startMins >= sStart && startMins < sEnd) {
        return section.key;
      }
    }
  }
  return 'evening-night';
}

console.log('Running slot-utils regression tests...');

assert.strictEqual(parseMinutes('24:00'), 1440, '24:00 should parse to 1440 minutes');
assert.strictEqual(parseMinutes('00:00'), 0, '00:00 should parse to 0 minutes');
assert.strictEqual(parseMinutes('12:00 PM'), 720, '12:00 PM should parse to 720 minutes');
assert.strictEqual(parseMinutes('12:00 AM'), 0, '12:00 AM should parse to 0 minutes');

const fullDaySlots = generateSlots('00:00', '00:00', 60, '24h');
assert.strictEqual(fullDaySlots.length, 24, 'Full day open/close 00:00-00:00 should generate 24 hourly slots');
assert.strictEqual(fullDaySlots[0], '00:00 - 01:00');
assert.strictEqual(fullDaySlots[23], '23:00 - 00:00');

const fullDayHalfHourSlots = generateSlots('00:00', '00:00', 30, '24h');
assert.strictEqual(fullDayHalfHourSlots.length, 48, 'Full day open/close 00:00-00:00 should generate 48 half-hour slots');
assert.strictEqual(fullDayHalfHourSlots[0], '00:00 - 00:30');
assert.strictEqual(fullDayHalfHourSlots[1], '00:30 - 01:00');
assert.strictEqual(fullDayHalfHourSlots[47], '23:30 - 00:00');

const almostFullDay = generateSlots('00:00', '23:59', 60, '24h');
assert.strictEqual(almostFullDay.length, 24, '00:00-23:59 should still be treated as a full 24-hour day');
assert.strictEqual(almostFullDay[23], '23:00 - 00:00');

const wrapSlots = generateSlots('18:00', '06:00', 60, '24h');
assert.strictEqual(wrapSlots.length, 12, 'Wrap-around schedule 18:00-06:00 should generate 12 hourly slots');
assert.strictEqual(wrapSlots[0], '18:00 - 19:00');
assert.strictEqual(wrapSlots[11], '05:00 - 06:00');

assert.strictEqual(getSlotSection('00:00 - 01:00', SLOT_SECTIONS), 'early-morning');
assert.strictEqual(getSlotSection('05:00 - 06:00', SLOT_SECTIONS), 'early-morning');
assert.strictEqual(getSlotSection('06:00 - 07:00', SLOT_SECTIONS), 'morning');
assert.strictEqual(getSlotSection('12:00 - 13:00', SLOT_SECTIONS), 'afternoon');
assert.strictEqual(getSlotSection('18:00 - 19:00', SLOT_SECTIONS), 'evening-night');
assert.strictEqual(getSlotSection('23:00 - 00:00', SLOT_SECTIONS), 'evening-night');

const NIGHT_SECTION = { key: 'night', start_time: '21:00', end_time: '06:00' };
const MORNING_SECTION = { key: 'morning', start_time: '06:00', end_time: '12:00' };
const unsortedNightSlots = [
  '12:00 AM - 12:30 AM',
  '9:00 PM - 9:30 PM',
  '1:00 AM - 1:30 AM',
  '11:30 PM - 12:00 AM',
  '5:30 AM - 6:00 AM'
];
const sortedNightSlots = sortSlotsInSection(unsortedNightSlots, NIGHT_SECTION);
assert.deepStrictEqual(sortedNightSlots, [
  '9:00 PM - 9:30 PM',
  '11:30 PM - 12:00 AM',
  '12:00 AM - 12:30 AM',
  '1:00 AM - 1:30 AM',
  '5:30 AM - 6:00 AM'
], 'Night slots should sort from period start (9 PM) through midnight to 6 AM');

const unsortedMorningSlots = ['8:00 AM - 9:00 AM', '6:30 AM - 7:30 AM', '7:00 AM - 8:00 AM'];
const sortedMorningSlots = sortSlotsInSection(unsortedMorningSlots, MORNING_SECTION);
assert.deepStrictEqual(sortedMorningSlots, [
  '6:30 AM - 7:30 AM',
  '7:00 AM - 8:00 AM',
  '8:00 AM - 9:00 AM'
], 'Normal periods should still sort by clock time');

const entity = {
  early_morning_price: '120',
  morning_price: '180',
  afternoon_price: '240',
  evening_price: '300',
  default_price: '200'
};
assert.strictEqual(resolveSlotPrice(30, entity), 120, 'Early morning slot should use early_morning_price');
assert.strictEqual(resolveSlotPrice(360, entity), 180, 'Morning slot should use morning_price');
assert.strictEqual(resolveSlotPrice(720, entity), 240, 'Afternoon slot should use afternoon_price');
assert.strictEqual(resolveSlotPrice(1080, entity), 300, 'Evening slot should use evening_price');
assert.strictEqual(resolveSlotPrice(1439, entity), 300, 'Late night slot should still use evening_price');

const fallbackEntity = { default_price: '250' };
assert.strictEqual(resolveSlotPrice(30, fallbackEntity), 250, 'Missing early_morning_price should fallback to default_price');

assert.strictEqual(computeOwnerMarkup(2000, 'fixed', 0).markupAmount, 0, 'Zero markup value should not add display markup');
assert.strictEqual(computeOwnerMarkup(2000, 'fixed', 0).displayPrice, 2000, 'Zero markup value should keep display price exact');
assert.strictEqual(computeOwnerMarkup(2000, 'fixed', 0).displayPrice, computeOwnerMarkup(2000, 'fixed', 0).displayPrice - computeOwnerMarkup(2000, 'fixed', 0).markupAmount, 'Disabled markup should not alter payable price');
assert.strictEqual(computeOwnerMarkup(2000, 'fixed', 200, 1).markupAmount, 200, 'Enabled fixed markup should apply owner value');
assert.strictEqual(computeOwnerMarkup(2000, 'fixed', 200, 1).displayPrice, 2200, 'Enabled fixed markup should inflate display price only');
assert.strictEqual(computeOwnerMarkup(2000, 'percentage', 0.25, 1).markupAmount, 5, 'Percentage markup should not force a minimum discount');
assert.strictEqual(resolveSlotPrice(360, { morning_price: '2000', default_price: '1500' }), 2000, 'Manual period price should resolve exactly as saved');

console.log('All slot-utils regression tests passed.');
