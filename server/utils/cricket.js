// Cricket match state, rebuilt by replaying the ball-by-ball events of a match.
//
// Nothing here reads or writes the database and nothing is cached: every call replays the non-undone events in
// id order, so an undo is simply "replay without that event" and the whole scorecard — batters, bowlers, extras,
// strike, fall of wickets — stays consistent automatically. That is the only way to make undo correct for a
// sport where one delivery touches a dozen numbers at once.
//
// Event shape (tournament_match_events):
//   event_type  RUN | BYE | LEG_BYE | WIDE | NO_BALL | WICKET
//   team_id     the BATTING team for that ball
//   player_id   the striker
//   value       total runs the batting side gets from the delivery (including any penalty)
//   metadata    { innings, bowler_id, non_striker_id, off_bat, dismissal, out_player_id, fielder_id, new_batter_id }
//
// Conventions follow normal scorecards:
//   • wides are not faced by the batter and are not legal deliveries
//   • no-balls are faced (they count in balls faced and strike rate) but are not legal deliveries
//   • byes and leg byes are legal deliveries faced by the batter, but the runs are extras, not his
//   • a bowler is not charged for byes or leg byes
//   • run outs, retirements and obstruction are not the bowler's wicket

const BALL_EVENTS = new Set(['RUN', 'BYE', 'LEG_BYE', 'WIDE', 'NO_BALL', 'WICKET']);

// Dismissals credited to the bowler. Everything else is a wicket for the team but not for his figures.
const BOWLER_WICKETS = new Set(['bowled', 'caught', 'lbw', 'stumped', 'hit_wicket', 'caught_and_bowled']);
const DISMISSALS = [
  'bowled', 'caught', 'caught_and_bowled', 'lbw', 'run_out', 'stumped',
  'hit_wicket', 'retired_hurt', 'retired_out', 'obstructing_the_field', 'timed_out', 'hit_ball_twice',
];
const DISMISSAL_LABEL = {
  bowled: 'b', caught: 'c', caught_and_bowled: 'c & b', lbw: 'lbw', run_out: 'run out', stumped: 'st',
  hit_wicket: 'hit wicket', retired_hurt: 'retired hurt', retired_out: 'retired out',
  obstructing_the_field: 'obstructing the field', timed_out: 'timed out', hit_ball_twice: 'hit the ball twice',
};
// A retired-hurt batter may come back in; everyone else is out for the innings.
const CAN_RETURN = new Set(['retired_hurt']);

const metaOf = (e) => {
  let m = e.metadata;
  if (typeof m === 'string') { try { m = JSON.parse(m); } catch { m = null; } }
  return m && typeof m === 'object' ? m : {};
};

const oversFromBalls = (balls) => `${Math.floor(balls / 6)}.${balls % 6}`;
const round2 = (n) => Math.round(n * 100) / 100;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function blankBatter(id) {
  return { player_id: id, runs: 0, balls: 0, fours: 0, sixes: 0, out: false, dismissal: null, dismissal_text: null, bowler_id: null, fielder_id: null, strike_rate: 0 };
}
function blankBowler(id) {
  return { player_id: id, balls: 0, runs: 0, wickets: 0, maidens: 0, wides: 0, no_balls: 0, overs: '0.0', economy: 0 };
}

function blankInnings(no) {
  return {
    innings: no,
    batting_team_id: null,
    bowling_team_id: null,
    runs: 0,
    wickets: 0,
    legal_balls: 0,
    extras: { wides: 0, no_balls: 0, byes: 0, leg_byes: 0, total: 0 },
    batters: {},          // player_id -> batting card, in the order they came in
    bowlers: {},          // player_id -> bowling card
    batting_order: [],
    bowling_order: [],
    fall_of_wickets: [],  // { wicket, runs, over, player_id }
    striker_id: null,
    non_striker_id: null,
    bowler_id: null,
    balls: [],            // one entry per delivery, newest last
    complete: false,
  };
}

/**
 * Replay a match.
 * @param {Array} events non-undone events for the match (any order; sorted here by id)
 * @param {{ oversLimit?: number|null, wicketsLimit?: number }} options
 * @returns {{ innings: Array, current: object, target: number|null }}
 */
function replay(events, { oversLimit = null, wicketsLimit = 10 } = {}) {
  const balls = [...events]
    .filter((e) => BALL_EVENTS.has(e.event_type) && !e.is_undone)
    .sort((a, b) => Number(a.id) - Number(b.id));

  const inningsList = [];
  const inningsOf = (no) => {
    while (inningsList.length < no) inningsList.push(blankInnings(inningsList.length + 1));
    return inningsList[no - 1];
  };

  // Runs conceded per bowler within the current over, so a maiden can be decided when the over ends.
  const overTracker = { bowlerId: null, ballsInOver: 0, bowlerRuns: 0, inningsNo: null };

  const closeOver = (inn) => {
    if (overTracker.bowlerId != null && overTracker.ballsInOver === 6) {
      const bowler = inn.bowlers[String(overTracker.bowlerId)];
      if (bowler && overTracker.bowlerRuns === 0) bowler.maidens += 1;
      // the batters cross at the end of an over
      const tmp = inn.striker_id; inn.striker_id = inn.non_striker_id; inn.non_striker_id = tmp;
    }
    overTracker.ballsInOver = 0;
    overTracker.bowlerRuns = 0;
  };

  for (const e of balls) {
    const m = metaOf(e);
    let inningsNo = Math.max(1, parseInt(m.innings, 10) || 1);
    let inn = inningsOf(inningsNo);

    // If an event has a team_id different from the existing batting_team_id of this innings,
    // it belongs to the next innings (teams cannot bat in the same innings).
    if (inn.batting_team_id != null && e.team_id != null && Number(e.team_id) !== Number(inn.batting_team_id)) {
      inningsNo = inningsNo + 1;
      inn = inningsOf(inningsNo);
    }

    if (inn.batting_team_id == null && e.team_id != null) inn.batting_team_id = Number(e.team_id);
    if (inn.bowling_team_id == null && m.bowling_team_id != null) inn.bowling_team_id = Number(m.bowling_team_id);

    const strikerId = e.player_id != null ? Number(e.player_id) : inn.striker_id;
    const nonStrikerId = m.non_striker_id != null ? Number(m.non_striker_id) : inn.non_striker_id;
    const bowlerId = m.bowler_id != null ? Number(m.bowler_id) : inn.bowler_id;
    inn.striker_id = strikerId;
    inn.non_striker_id = nonStrikerId;
    inn.bowler_id = bowlerId;

    const batter = ensure(inn.batters, inn.batting_order, strikerId, blankBatter);
    const bowler = ensure(inn.bowlers, inn.bowling_order, bowlerId, blankBowler);

    // a new over begins whenever the bowler changes or the previous over filled up
    if (overTracker.inningsNo !== inningsNo || overTracker.bowlerId !== bowlerId || overTracker.ballsInOver >= 6) {
      if (overTracker.inningsNo === inningsNo) closeOver(inn);
      overTracker.inningsNo = inningsNo;
      overTracker.bowlerId = bowlerId;
      overTracker.ballsInOver = 0;
      overTracker.bowlerRuns = 0;
    }

    const total = num(e.value);
    let legal = false;
    let runsOffBat = 0;
    let bowlerCharged = 0;
    let runsForRotation = 0;

    switch (e.event_type) {
      case 'RUN':
        legal = true;
        runsOffBat = total;
        bowlerCharged = total;
        runsForRotation = total;
        break;
      case 'BYE':
        legal = true;
        inn.extras.byes += total;
        runsForRotation = total;      // the batters do run byes, so odd byes swap the strike
        break;
      case 'LEG_BYE':
        legal = true;
        inn.extras.leg_byes += total;
        runsForRotation = total;
        break;
      case 'WIDE': {
        // 1 penalty + anything run off it. Not a legal ball, not faced by the batter.
        inn.extras.wides += Math.max(1, total);
        bowlerCharged = Math.max(1, total);
        if (bowler) bowler.wides += 1;
        runsForRotation = Math.max(0, Math.max(1, total) - 1);
        break;
      }
      case 'NO_BALL': {
        // 1 penalty to extras; anything off the bat belongs to the batter. Faced, but not a legal ball.
        const offBat = num(m.off_bat);
        inn.extras.no_balls += 1;
        runsOffBat = offBat;
        bowlerCharged = Math.max(1, total);
        if (bowler) bowler.no_balls += 1;
        runsForRotation = offBat;
        // byes off a no-ball go to extras, not the batter
        const extraOther = Math.max(0, total - 1 - offBat);
        if (extraOther > 0) inn.extras.byes += extraOther;
        break;
      }
      case 'WICKET': {
        // A wicket can fall on a wide or a no-ball (run out, stumped off a wide): then it is not a legal ball.
        const onWide = !!m.off_wide;
        const onNoBall = !!m.off_no_ball;
        legal = !onWide && !onNoBall;
        if (onWide) { inn.extras.wides += 1; bowlerCharged += 1; if (bowler) bowler.wides += 1; }
        if (onNoBall) { inn.extras.no_balls += 1; bowlerCharged += 1; if (bowler) bowler.no_balls += 1; }
        const ranRuns = num(m.runs);   // runs completed before the dismissal (a run out after 1)
        runsOffBat = m.dismissal === 'run_out' ? ranRuns : 0;
        bowlerCharged += runsOffBat;
        runsForRotation = ranRuns;
        break;
      }
      default:
        break;
    }

    // ---- apply to the batter -------------------------------------------------------------------------
    if (batter) {
      if (runsOffBat) {
        batter.runs += runsOffBat;
        if (e.event_type === 'RUN' && runsOffBat === 4) batter.fours += 1;
        if (e.event_type === 'RUN' && runsOffBat === 6) batter.sixes += 1;
        if (e.event_type === 'NO_BALL' && runsOffBat === 4) batter.fours += 1;
        if (e.event_type === 'NO_BALL' && runsOffBat === 6) batter.sixes += 1;
      }
      // faced: every delivery except a wide
      if (e.event_type !== 'WIDE' && !(e.event_type === 'WICKET' && m.off_wide)) batter.balls += 1;
    }

    // ---- apply to the bowler -------------------------------------------------------------------------
    if (bowler) {
      if (legal) bowler.balls += 1;
      bowler.runs += bowlerCharged;
    }
    overTracker.bowlerRuns += bowlerCharged;

    // ---- team totals ----------------------------------------------------------------------------------
    inn.runs += total;
    if (legal) {
      inn.legal_balls += 1;
      overTracker.ballsInOver += 1;
    }

    // ---- the wicket itself ----------------------------------------------------------------------------
    if (e.event_type === 'WICKET') {
      const outId = m.out_player_id != null ? Number(m.out_player_id) : strikerId;
      const outBatter = ensure(inn.batters, inn.batting_order, outId, blankBatter);
      const kind = DISMISSALS.includes(m.dismissal) ? m.dismissal : 'bowled';
      if (outBatter) {
        outBatter.out = !CAN_RETURN.has(kind);
        outBatter.dismissal = kind;
        outBatter.dismissal_text = DISMISSAL_LABEL[kind] || kind;
        outBatter.bowler_id = BOWLER_WICKETS.has(kind) ? bowlerId : null;
        outBatter.fielder_id = m.fielder_id != null ? Number(m.fielder_id) : null;
      }
      if (kind !== 'retired_hurt') {
        inn.wickets += 1;
        inn.fall_of_wickets.push({ wicket: inn.wickets, runs: inn.runs, over: oversFromBalls(inn.legal_balls), player_id: outId });
      }
      if (bowler && BOWLER_WICKETS.has(kind)) bowler.wickets += 1;

      // whoever was out leaves; the replacement (if the scorer named one) takes that end
      const newId = m.new_batter_id != null ? Number(m.new_batter_id) : null;
      if (outId === inn.striker_id) inn.striker_id = newId;
      else if (outId === inn.non_striker_id) inn.non_striker_id = newId;
      if (newId != null) ensure(inn.batters, inn.batting_order, newId, blankBatter);
    }

    // ---- strike rotation ------------------------------------------------------------------------------
    if (runsForRotation % 2 === 1) {
      const tmp = inn.striker_id; inn.striker_id = inn.non_striker_id; inn.non_striker_id = tmp;
    }

    inn.balls.push({
      id: e.id,
      innings: inningsNo,
      type: e.event_type,
      runs: total,
      off_bat: runsOffBat,
      legal,
      striker_id: strikerId,
      bowler_id: bowlerId,
      dismissal: e.event_type === 'WICKET' ? (m.dismissal || 'bowled') : null,
      over: oversFromBalls(inn.legal_balls),
    });

    // end of the over: maiden check + the batters cross
    if (legal && overTracker.ballsInOver === 6) closeOver(inn);
  }

  // A match with no deliveries yet still answers with a real innings 1, so every caller can read
  // overs / run rate / cards without guarding for an empty match.
  if (inningsList.length === 0) inningsList.push(blankInnings(1));

  // ---- derived figures ---------------------------------------------------------------------------------
  for (const inn of inningsList) {
    inn.extras.total = inn.extras.wides + inn.extras.no_balls + inn.extras.byes + inn.extras.leg_byes;
    inn.overs = oversFromBalls(inn.legal_balls);
    inn.run_rate = inn.legal_balls ? round2(inn.runs / (inn.legal_balls / 6)) : 0;
    inn.wickets_remaining = Math.max(0, wicketsLimit - inn.wickets);
    if (oversLimit) {
      inn.balls_remaining = Math.max(0, oversLimit * 6 - inn.legal_balls);
      inn.overs_limit = oversLimit;
      inn.complete = inn.legal_balls >= oversLimit * 6 || inn.wickets >= wicketsLimit;
    } else {
      inn.balls_remaining = null;
      inn.overs_limit = null;
      inn.complete = inn.wickets >= wicketsLimit;
    }
    for (const b of Object.values(inn.batters)) b.strike_rate = b.balls ? round2((b.runs / b.balls) * 100) : 0;
    for (const b of Object.values(inn.bowlers)) {
      b.overs = oversFromBalls(b.balls);
      b.economy = b.balls ? round2(b.runs / (b.balls / 6)) : 0;
    }
    inn.batting_card = inn.batting_order.map((id) => inn.batters[String(id)]);
    inn.bowling_card = inn.bowling_order.map((id) => inn.bowlers[String(id)]);
    inn.recent_balls = inn.balls.slice(-12);
  }

  const current = inningsList[inningsList.length - 1];
  // Chasing: the target is one more than the first innings total.
  let target = null;
  if (inningsList.length >= 2) target = inningsList[0].runs + 1;

  const chase = target != null ? {
    target,
    runs_needed: Math.max(0, target - current.runs),
    balls_remaining: current.balls_remaining,
    required_run_rate: current.balls_remaining ? round2((target - current.runs) / (current.balls_remaining / 6)) : null,
  } : null;

  return { innings: inningsList, current, target, chase };
}

function ensure(map, order, id, make) {
  if (id == null) return null;
  const key = String(id);
  if (!map[key]) { map[key] = make(id); order.push(Number(id)); }
  return map[key];
}

/** Batters who may still be sent in for this innings (not already out, not already at the crease). */
function availableBatters(innings, squadIds) {
  const taken = new Set([innings.striker_id, innings.non_striker_id].filter((x) => x != null).map(Number));
  return squadIds
    .map(Number)
    .filter((id) => !taken.has(id))
    .filter((id) => {
      const card = innings.batters[String(id)];
      return !card || !card.out;
    });
}

/**
 * Whether this bowler may bowl the next delivery.
 * Two rules are enforced: no two overs in a row, and the per-bowler cap when the format sets an overs limit
 * (the usual one-fifth of the innings, rounded up).
 */
function bowlerEligibility(innings, bowlerId, { oversLimit = null, maxOversPerBowler = null } = {}) {
  const id = Number(bowlerId);
  const card = innings.bowlers[String(id)];
  const lastBall = innings.balls[innings.balls.length - 1];
  const midOver = innings.legal_balls % 6 !== 0;

  if (midOver && lastBall && Number(lastBall.bowler_id) === id) return { ok: true };
  if (!midOver && lastBall && Number(lastBall.bowler_id) === id) {
    return { ok: false, error: 'A bowler cannot bowl two overs in a row.' };
  }
  const cap = maxOversPerBowler || (oversLimit ? Math.ceil(oversLimit / 5) : null);
  if (cap && card && Math.floor(card.balls / 6) >= cap) {
    return { ok: false, error: `A bowler can bowl at most ${cap} overs in this match.` };
  }
  return { ok: true };
}

module.exports = {
  replay, availableBatters, bowlerEligibility, oversFromBalls,
  BALL_EVENTS, DISMISSALS, DISMISSAL_LABEL, BOWLER_WICKETS, metaOf,
};
