// Request G priorities 4/5: the cricket rules themselves. Pure replay, no database — so every rule is
// checked directly and an undo is simply "replay without that event".
const test = require('node:test');
const assert = require('node:assert/strict');
const { replay, availableBatters, bowlerEligibility, oversFromBalls } = require('../utils/cricket');

const A = 10, B = 20;                       // teams
const P = { rayyan: 1, hamdan: 2, vikram: 3, sameer: 4, bowl1: 11, bowl2: 12 };

let seq = 0;
const reset = () => { seq = 0; };
/** One delivery. `meta` carries bowler, non-striker and anything the event needs. */
const ball = (type, value, striker, meta = {}) => ({
  id: ++seq, event_type: type, team_id: A, player_id: striker, value,
  metadata: { innings: 1, bowler_id: P.bowl1, non_striker_id: P.hamdan, bowling_team_id: B, ...meta },
});
const run = (v, striker = P.rayyan, meta) => ball('RUN', v, striker, meta);
const state = (events, opts) => replay(events, opts);
const bat = (s, id) => s.current.batters[String(id)];
const bowl = (s, id) => s.current.bowlers[String(id)];

test.beforeEach(reset);

// ───────────────────────────── runs and the batter's card ─────────────────────────────
test('runs off the bat go to the striker, the team and the bowler', () => {
  const s = state([run(1), run(4), run(0), run(6), run(2)]);
  const b = bat(s, P.rayyan);
  assert.equal(s.current.runs, 13);
  assert.equal(b.runs, 13);
  assert.equal(b.balls, 5);
  assert.equal(b.fours, 1);
  assert.equal(b.sixes, 1);
  assert.equal(bowl(s, P.bowl1).runs, 13);
  assert.equal(bowl(s, P.bowl1).balls, 5);
});

test('strike rate is runs per hundred balls, and zero balls never divides by zero', () => {
  const s = state([run(4), run(1)]);
  // 5 runs off 2 balls = 250.00
  assert.equal(bat(s, P.rayyan).strike_rate, 250);
  const fresh = state([]);
  assert.equal(fresh.current.runs, 0);
  assert.equal(fresh.current.run_rate, 0);
});

test('an odd number of runs swaps the strike, an even number does not', () => {
  let s = state([run(1)]);
  assert.equal(s.current.striker_id, P.hamdan, 'a single should put the other batter on strike');
  assert.equal(s.current.non_striker_id, P.rayyan);

  reset();
  s = state([run(2)]);
  assert.equal(s.current.striker_id, P.rayyan, 'a two keeps the same batter on strike');

  reset();
  s = state([run(3)]);
  assert.equal(s.current.striker_id, P.hamdan);
});

test('the batters cross at the end of an over', () => {
  // six dot balls: the strike changes because the over ended
  const s = state([run(0), run(0), run(0), run(0), run(0), run(0)]);
  assert.equal(s.current.legal_balls, 6);
  assert.equal(s.current.overs, '1.0');
  assert.equal(s.current.striker_id, P.hamdan, 'ends of overs swap the strike');
});

test('a single off the last ball of an over leaves the same batter on strike', () => {
  // 5 dots then a single: the single swaps, the over-end swaps back
  const s = state([run(0), run(0), run(0), run(0), run(0), run(1)]);
  assert.equal(s.current.striker_id, P.rayyan);
});

// ───────────────────────────── extras ─────────────────────────────
test('a wide is not a legal ball, is not faced, and is charged to the bowler', () => {
  const s = state([ball('WIDE', 1, P.rayyan)]);
  assert.equal(s.current.runs, 1);
  assert.equal(s.current.extras.wides, 1);
  assert.equal(s.current.extras.total, 1);
  assert.equal(s.current.legal_balls, 0, 'a wide must be re-bowled');
  assert.equal(bat(s, P.rayyan).balls, 0, 'a wide is not faced');
  assert.equal(bat(s, P.rayyan).runs, 0);
  assert.equal(bowl(s, P.bowl1).runs, 1);
  assert.equal(bowl(s, P.bowl1).wides, 1);
  assert.equal(bowl(s, P.bowl1).balls, 0);
});

test('runs taken off a wide are extras, and an odd number of them swaps the strike', () => {
  const s = state([ball('WIDE', 3, P.rayyan)]);   // 1 wide + 2 run
  assert.equal(s.current.runs, 3);
  assert.equal(s.current.extras.wides, 3);
  assert.equal(bat(s, P.rayyan).runs, 0);
  assert.equal(s.current.striker_id, P.rayyan, 'two were run off the wide, an even number, so no swap');
});

test('a no-ball costs the bowler a penalty run, and runs off the bat still belong to the batter', () => {
  const s = state([ball('NO_BALL', 5, P.rayyan, { off_bat: 4 })]);  // 1 penalty + 4 off the bat
  assert.equal(s.current.runs, 5);
  assert.equal(s.current.extras.no_balls, 1);
  assert.equal(bat(s, P.rayyan).runs, 4);
  assert.equal(bat(s, P.rayyan).fours, 1);
  assert.equal(bat(s, P.rayyan).balls, 1, 'a no-ball is faced');
  assert.equal(s.current.legal_balls, 0, 'a no-ball must be re-bowled');
  assert.equal(bowl(s, P.bowl1).runs, 5);
  assert.equal(bowl(s, P.bowl1).no_balls, 1);
});

test('byes and leg byes are legal balls the batter faces, but never his runs or the bowler\'s', () => {
  const s = state([ball('BYE', 2, P.rayyan), ball('LEG_BYE', 1, P.rayyan)]);
  assert.equal(s.current.runs, 3);
  assert.equal(s.current.extras.byes, 2);
  assert.equal(s.current.extras.leg_byes, 1);
  assert.equal(bat(s, P.rayyan).runs, 0);
  assert.equal(bat(s, P.rayyan).balls, 2, 'two byes were run (even, no swap) so Rayyan faced both balls');
  assert.equal(s.current.legal_balls, 2);
  assert.equal(bowl(s, P.bowl1).runs, 0, 'byes are not charged to the bowler');
  assert.equal(bowl(s, P.bowl1).balls, 2);
});

test('the extras total adds up across every kind', () => {
  const s = state([
    ball('WIDE', 1, P.rayyan), ball('NO_BALL', 1, P.rayyan, { off_bat: 0 }),
    ball('BYE', 4, P.rayyan), ball('LEG_BYE', 1, P.rayyan),
  ]);
  assert.deepEqual(
    { w: s.current.extras.wides, nb: s.current.extras.no_balls, b: s.current.extras.byes, lb: s.current.extras.leg_byes },
    { w: 1, nb: 1, b: 4, lb: 1 });
  assert.equal(s.current.extras.total, 7);
  assert.equal(s.current.runs, 7);
});

// ───────────────────────────── wickets ─────────────────────────────
test('a bowled dismissal is the bowler\'s wicket and the next batter comes in', () => {
  const s = state([
    run(1),                                   // Hamdan now on strike
    ball('WICKET', 0, P.hamdan, { dismissal: 'bowled', out_player_id: P.hamdan, new_batter_id: P.vikram }),
  ]);
  assert.equal(s.current.wickets, 1);
  assert.equal(bat(s, P.hamdan).out, true);
  assert.equal(bat(s, P.hamdan).dismissal, 'bowled');
  assert.equal(bat(s, P.hamdan).bowler_id, P.bowl1);
  assert.equal(bowl(s, P.bowl1).wickets, 1);
  assert.equal(s.current.striker_id, P.vikram, 'the new batter takes the out batter\'s end');
  assert.equal(s.current.fall_of_wickets.length, 1);
  assert.equal(s.current.fall_of_wickets[0].runs, 1);
});

test('a run out is a wicket for the team but not for the bowler', () => {
  const s = state([
    ball('WICKET', 1, P.rayyan, { dismissal: 'run_out', out_player_id: P.hamdan, runs: 1, new_batter_id: P.vikram }),
  ]);
  assert.equal(s.current.wickets, 1);
  assert.equal(bowl(s, P.bowl1).wickets, 0, 'a run out is never the bowler\'s wicket');
  assert.equal(bat(s, P.hamdan).out, true);
  assert.equal(bat(s, P.hamdan).bowler_id, null);
  assert.equal(s.current.runs, 1, 'the run completed before the dismissal counts');
});

test('a retired-hurt batter is not out and may come back', () => {
  const s = state([
    run(4),
    ball('WICKET', 0, P.rayyan, { dismissal: 'retired_hurt', out_player_id: P.rayyan, new_batter_id: P.vikram }),
  ]);
  assert.equal(s.current.wickets, 0, 'retiring hurt does not cost a wicket');
  assert.equal(bat(s, P.rayyan).out, false);
  assert.equal(bat(s, P.rayyan).runs, 4, 'his runs are kept');
  const free = availableBatters(s.current, [P.rayyan, P.hamdan, P.vikram, P.sameer]);
  assert.ok(free.includes(P.rayyan), 'a retired-hurt batter can be sent in again');
});

test('a stumping off a wide is a wicket and a wide, but not a legal ball', () => {
  const s = state([
    ball('WICKET', 0, P.rayyan, { dismissal: 'stumped', out_player_id: P.rayyan, off_wide: true, new_batter_id: P.vikram }),
  ]);
  assert.equal(s.current.wickets, 1);
  assert.equal(s.current.extras.wides, 1);
  assert.equal(s.current.legal_balls, 0);
  assert.equal(bat(s, P.rayyan).balls, 0, 'a wide is never faced, even when a wicket falls');
  assert.equal(bowl(s, P.bowl1).wickets, 1, 'a stumping is the bowler\'s wicket');
});

test('a dismissed batter cannot be sent in again', () => {
  const s = state([
    ball('WICKET', 0, P.rayyan, { dismissal: 'bowled', out_player_id: P.rayyan, new_batter_id: P.vikram }),
  ]);
  const free = availableBatters(s.current, [P.rayyan, P.hamdan, P.vikram, P.sameer]);
  assert.ok(!free.includes(P.rayyan), 'an out batter must not be selectable');
  assert.ok(!free.includes(P.vikram), 'a batter already at the crease is not selectable');
  assert.ok(!free.includes(P.hamdan), 'the non-striker is not selectable');
  assert.deepEqual(free, [P.sameer]);
});

test('a dismissed batter keeps his statistics', () => {
  const s = state([
    run(4), run(2),
    ball('WICKET', 0, P.rayyan, { dismissal: 'caught', out_player_id: P.rayyan, fielder_id: P.bowl2, new_batter_id: P.vikram }),
  ]);
  const b = bat(s, P.rayyan);
  assert.equal(b.runs, 6);
  assert.equal(b.balls, 3);
  assert.equal(b.fours, 1);
  assert.equal(b.out, true);
  assert.equal(b.fielder_id, P.bowl2);
  assert.equal(b.dismissal_text, 'c');
});

// ───────────────────────────── bowling ─────────────────────────────
test('an over of dot balls is a maiden; an over with a run is not', () => {
  const maiden = state(Array.from({ length: 6 }, () => run(0)));
  assert.equal(bowl(maiden, P.bowl1).maidens, 1);
  assert.equal(bowl(maiden, P.bowl1).overs, '1.0');

  reset();
  const notMaiden = state([run(0), run(0), run(0), run(0), run(0), run(1)]);
  assert.equal(bowl(notMaiden, P.bowl1).maidens, 0);
});

test('an over of byes is still a maiden, because the bowler conceded nothing', () => {
  const s = state([ball('BYE', 1, P.rayyan), run(0), run(0), run(0), run(0), run(0)]);
  assert.equal(bowl(s, P.bowl1).maidens, 1);
  assert.equal(s.current.runs, 1);
});

test('bowling figures read overs, runs, wickets and economy', () => {
  const s = state([
    run(1, P.rayyan), run(0, P.hamdan), run(4, P.hamdan), run(0, P.hamdan), run(2, P.hamdan), run(0, P.hamdan),
  ]);
  const b = bowl(s, P.bowl1);
  assert.equal(b.overs, '1.0');
  assert.equal(b.runs, 7);
  assert.equal(b.economy, 7, '7 runs in one over');
});

test('a bowler cannot bowl two overs in a row', () => {
  const s = state(Array.from({ length: 6 }, () => run(0)));
  assert.equal(bowlerEligibility(s.current, P.bowl1).ok, false);
  assert.match(bowlerEligibility(s.current, P.bowl1).error, /two overs in a row/);
  assert.equal(bowlerEligibility(s.current, P.bowl2).ok, true);
});

test('finishing a part-bowled over is allowed, it is the same over', () => {
  const s = state([run(0), run(0)]);
  assert.equal(bowlerEligibility(s.current, P.bowl1).ok, true, 'mid-over the same bowler continues');
});

test('a bowler cannot exceed the per-bowler cap for the format', () => {
  // 20-over match: cap is 4 overs each. Give bowl1 four completed overs.
  const events = [];
  // eight overs alternating, so bowl1 has four and did NOT bowl the last one — the cap is what is tested,
  // not the "no two overs in a row" rule.
  for (let over = 0; over < 8; over++) {
    const who = over % 2 === 0 ? P.bowl1 : P.bowl2;
    for (let i = 0; i < 6; i++) events.push(ball('RUN', 0, P.rayyan, { bowler_id: who }));
  }
  const s = state(events, { oversLimit: 20 });
  assert.equal(Math.floor(bowl(s, P.bowl1).balls / 6), 4);
  const verdict = bowlerEligibility(s.current, P.bowl1, { oversLimit: 20 });
  assert.equal(verdict.ok, false);
  assert.match(verdict.error, /at most 4 overs/);
});

// ───────────────────────────── innings, chase, undo ─────────────────────────────
test('an innings closes on the overs limit or on ten wickets', () => {
  const twoOvers = state(Array.from({ length: 12 }, () => run(0)), { oversLimit: 2 });
  assert.equal(twoOvers.current.complete, true);
  assert.equal(twoOvers.current.balls_remaining, 0);

  reset();
  const partial = state(Array.from({ length: 6 }, () => run(0)), { oversLimit: 2 });
  assert.equal(partial.current.complete, false);
  assert.equal(partial.current.balls_remaining, 6);
  assert.equal(partial.current.wickets_remaining, 10);
});

test('the second innings knows the target, the runs needed and the required rate', () => {
  const first = [run(4), run(4), run(2)];                         // 10 all up
  const second = [
    { id: 100, event_type: 'RUN', team_id: B, player_id: P.vikram, value: 2,
      metadata: { innings: 2, bowler_id: P.bowl2, non_striker_id: P.sameer, bowling_team_id: A } },
  ];
  const s = replay([...first, ...second], { oversLimit: 2 });
  assert.equal(s.innings.length, 2);
  assert.equal(s.target, 11, 'target is one more than the first innings');
  assert.equal(s.chase.runs_needed, 9);
  assert.equal(s.current.innings, 2);
  assert.equal(s.current.batting_team_id, B);
  assert.equal(s.chase.balls_remaining, 11);
});

test('undo is exact: replaying without the last event restores every number', () => {
  const events = [run(1), run(4), ball('WIDE', 1, P.hamdan), run(6, P.hamdan)];
  const before = state(events.slice(0, 3));
  const after = state(events);
  assert.equal(after.current.runs, 12);
  assert.equal(bat(after, P.hamdan).runs, 6);

  // the app marks the last event undone -> it is simply not replayed
  const undone = state(events.map((e, i) => (i === 3 ? { ...e, is_undone: true } : e)));
  assert.equal(undone.current.runs, before.current.runs);
  assert.equal(undone.current.legal_balls, before.current.legal_balls);
  assert.deepEqual(bat(undone, P.hamdan), bat(before, P.hamdan));
  assert.deepEqual(bowl(undone, P.bowl1), bowl(before, P.bowl1));
  assert.equal(undone.current.striker_id, before.current.striker_id);
});

test('undoing a wicket brings the batter back and removes the fall of wicket', () => {
  const events = [
    run(4),
    ball('WICKET', 0, P.rayyan, { dismissal: 'bowled', out_player_id: P.rayyan, new_batter_id: P.vikram }),
  ];
  const withWicket = state(events);
  assert.equal(withWicket.current.wickets, 1);

  const undone = state(events.map((e, i) => (i === 1 ? { ...e, is_undone: true } : e)));
  assert.equal(undone.current.wickets, 0);
  assert.equal(undone.current.fall_of_wickets.length, 0);
  assert.equal(bat(undone, P.rayyan).out, false);
  assert.equal(bat(undone, P.rayyan).runs, 4);
  assert.equal(undone.current.striker_id, P.rayyan, 'he is back on strike');
  assert.equal(bowl(undone, P.bowl1).wickets, 0);
});

test('undoing a middle event, not just the last one, still adds up', () => {
  const events = [run(4), run(6), run(2)];
  const undone = state(events.map((e, i) => (i === 1 ? { ...e, is_undone: true } : e)));
  assert.equal(undone.current.runs, 6);
  assert.equal(bat(undone, P.rayyan).runs, 6);
  assert.equal(bat(undone, P.rayyan).sixes, 0);
  assert.equal(bat(undone, P.rayyan).balls, 2);
});

test('overs are counted in the cricket way, not as a decimal', () => {
  assert.equal(oversFromBalls(0), '0.0');
  assert.equal(oversFromBalls(5), '0.5');
  assert.equal(oversFromBalls(6), '1.0');
  assert.equal(oversFromBalls(13), '2.1');
});

test('a full, realistic over adds up on every card', () => {
  // W(ide) · 1 · 4 · dot · no-ball+6 · 2 · W(icket, bowled)
  const events = [
    ball('WIDE', 1, P.rayyan),
    run(1, P.rayyan),
    run(4, P.hamdan),
    run(0, P.hamdan),
    ball('NO_BALL', 7, P.hamdan, { off_bat: 6 }),
    run(2, P.hamdan),
    ball('WICKET', 0, P.hamdan, { dismissal: 'bowled', out_player_id: P.hamdan, new_batter_id: P.vikram }),
  ];
  const s = state(events);
  assert.equal(s.current.runs, 1 + 1 + 4 + 0 + 7 + 2 + 0);
  assert.equal(s.current.legal_balls, 5, 'the wide and the no-ball do not count');
  assert.equal(s.current.wickets, 1);
  assert.equal(s.current.extras.total, 2, 'one wide, one no-ball penalty');
  assert.equal(bat(s, P.rayyan).runs, 1);
  assert.equal(bat(s, P.hamdan).runs, 12, '4 + 6 off the no-ball + 2');
  assert.equal(bat(s, P.hamdan).sixes, 1);
  assert.equal(bowl(s, P.bowl1).runs, 15, 'everything except nothing here is byes');
  assert.equal(bowl(s, P.bowl1).wickets, 1);
  assert.equal(bowl(s, P.bowl1).balls, 5);
});
