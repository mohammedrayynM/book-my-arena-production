// Pure tests of the slot generator and slot-time math (no database).
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../services/slotSchedule');

test('24-hour venue: 24 hourly / 48 half-hour slots, midnight and noon labelled correctly, no duplicates', () => {
  const h = S.generateDaySlots({ is_24_hours: 1, open_time: '09:00', close_time: '17:00' }, { duration: 60 }); // stale hours are ignored
  assert.equal(h.length, 24); assert.equal(h[0].label, '12:00 AM - 1:00 AM'); assert.equal(h[12].label, '12:00 PM - 1:00 PM'); assert.equal(h[23].label, '11:00 PM - 12:00 AM');
  assert.equal(new Set(h.map((x) => x.label)).size, 24);
  assert.equal(S.generateDaySlots({ is_24_hours: true }, { duration: 30 }).length, 48);
});
test('limited hours: only inside the window, every slot ends by closing time', () => {
  const s = S.generateDaySlots({ open_time: '06:00', close_time: '22:30' }, { duration: 60 });
  assert.equal(s[0].label, '6:00 AM - 7:00 AM'); assert.equal(s.at(-1).label, '9:00 PM - 10:00 PM'); assert.equal(s.length, 16, 'a slot that would end after 22:30 is not offered');
  assert.equal(S.generateDaySlots({ open_time: '06:00', close_time: '22:30' }, { duration: 30 }).at(-1).label, '10:00 PM - 10:30 PM');
});
test('closing at 00:00 is a real midnight boundary, not "missing"', () => {
  const s = S.generateDaySlots({ open_time: '06:00', close_time: '00:00' }, { duration: 60 });
  assert.equal(s.length, 18); assert.equal(s.at(-1).label, '11:00 PM - 12:00 AM'); assert.equal(s.at(-1).endMin, 1440);
});
test('overnight window runs past midnight on the same operating day', () => {
  const s = S.generateDaySlots({ open_time: '18:00', close_time: '02:00' }, { duration: 60 });
  assert.equal(s.length, 8); assert.equal(s[5].label, '11:00 PM - 12:00 AM'); assert.equal(s[6].label, '12:00 AM - 1:00 AM'); assert.equal(s[6].startMin, 1440);
});
test('legacy rows keep their meaning: 00:00-00:00 stays all-day; invalid configs are errors', () => {
  assert.equal(S.resolveWindow({ open_time: '00:00:00', close_time: '00:00:00' }).is24, true);
  assert.ok(S.resolveWindow({ open_time: '06:00', close_time: '06:00' }).error);
  assert.ok(S.resolveWindow({ open_time: 'abc', close_time: '06:00' }).error);
  assert.ok(S.validateSchedule({ open_time: '06:00', close_time: '06:00', slot_duration: 60 }));
  assert.equal(S.validateSchedule({ is_24_hours: true, slot_duration: 30 }), null);
  assert.ok(S.validateSchedule({ open_time: '06:00', close_time: '07:00', slot_duration: 45 }));
  assert.ok(S.validateSchedule({ open_time: '06:00', close_time: '06:30', slot_duration: 60 }), 'window shorter than a slot');
});
test('conflicts are decided on time ranges, not label text', () => {
  const w = S.resolveWindow({ open_time: '06:00', close_time: '23:00' });
  assert.ok(S.labelsOverlap('6:00 PM - 7:00 PM', '18:00 - 19:00', w), '12h vs 24h label of the same hour');
  assert.ok(S.labelsOverlap('6:00 PM - 7:00 PM', '6:30 PM - 7:00 PM', w), '60-min slot vs 30-min slot inside it');
  assert.ok(!S.labelsOverlap('6:00 PM - 7:00 PM', '7:00 PM - 8:00 PM', w), 'back-to-back slots do not clash');
  const night = S.resolveWindow({ open_time: '18:00', close_time: '02:00' });
  assert.ok(!S.labelsOverlap('11:00 PM - 12:00 AM', '12:00 AM - 1:00 AM', night));
  assert.ok(S.labelsOverlap('12:00 AM - 1:00 AM', '12:30 AM - 1:30 AM', night));
  assert.ok(!S.labelsOverlap('7:00 PM - 8:00 PM', '1:00 AM - 2:00 AM', night), 'evening vs after-midnight never clash');
});
test('past-slot check uses the venue timezone and the operating-day offset', () => {
  const dubaiNow = Date.UTC(2026, 9, 18, 15, 0); // 19:00 in Asia/Dubai (UTC+4)
  const slots = S.generateDaySlots({ is_24_hours: 1 }, { duration: 60 });
  const future = slots.filter((s) => S.isFutureSlot('2026-10-18', s, 'Asia/Dubai', dubaiNow));
  assert.equal(future[0].label, '8:00 PM - 9:00 PM'); assert.equal(future.length, 4);
  const night = S.generateDaySlots({ open_time: '18:00', close_time: '02:00' }, { duration: 60 });
  const f2 = night.filter((s) => S.isFutureSlot('2026-10-18', s, 'Asia/Dubai', dubaiNow));
  assert.equal(f2.length, 6, 'after-midnight slots of tonight are still in the future at 7 PM');
});
test('DST: a wall-clock time skipped by spring-forward does not exist', () => {
  // America/New_York 2026-03-08: 02:00-03:00 does not exist
  assert.ok(Number.isNaN(S.slotStartEpoch('2026-03-08', 2 * 60, 'America/New_York')));
  assert.ok(Number.isFinite(S.slotStartEpoch('2026-03-08', 3 * 60, 'America/New_York')));
  assert.ok(Number.isFinite(S.slotStartEpoch('2026-03-09', 2 * 60, 'America/New_York')));
});
