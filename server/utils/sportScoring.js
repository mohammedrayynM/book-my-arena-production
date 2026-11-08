// Sport-specific scoring rules for live tournament matches.
//
// A fixture keeps ONE number per team (`team_a_score` / `team_b_score`) that feeds results, standings and
// knockout advancement. Everything else a scoreboard shows (wickets, overs, cards, set points...) is derived
// from the non-undone rows of `tournament_match_events`, so undo always keeps everything consistent.
//
//   goals   Football and any sport without its own rules   score = goals
//   basket  Basketball                                     score = points
//   cricket Cricket                                        score = runs   (wickets/overs derived)
//   sets    Badminton, Tennis, Volleyball                  score = sets won (points in the current set derived)
//
// The server decides how much an event is worth - the client only names the event - so a viewer or a
// buggy client can never invent an arbitrary score.

const FAMILY_BY_SPORT = {
  football: 'goals',
  cricket: 'cricket',
  basketball: 'basket',
  badminton: 'sets',
  tennis: 'sets',
  volleyball: 'sets',
};

function familyOf(sport) {
  return FAMILY_BY_SPORT[String(sport || '').trim().toLowerCase()] || 'goals';
}

// score: fixed delta to the team's score. allowed: for events whose value the host chooses.
// legal: counts as a legal delivery (cricket). max: cap per team (cricket wickets).
const EVENTS = {
  goals: {
    GOAL: { score: 1 },
    POINT: { score: 1 },
    ASSIST: { score: 0 },
    YELLOW_CARD: { score: 0 },
    RED_CARD: { score: 0 },
    SUBSTITUTION: { score: 0 },
    FOUL: { score: 0 },
    TIMEOUT: { score: 0 },
    CORRECTION: { allowed: [-1, 1] },
  },
  basket: {
    '1_POINT': { score: 1 },
    '2_POINTS': { score: 2 },
    '3_POINTS': { score: 3 },
    ASSIST: { score: 0 },
    FOUL: { score: 0 },
    SUBSTITUTION: { score: 0 },
    TIMEOUT: { score: 0 },
    CORRECTION: { allowed: [-1, 1] },
  },
  cricket: {
    // `value` is always what the BATTING SIDE gets from the delivery, penalties included, so the fixture's
    // single running total stays correct. Who the runs belong to (batter / extras) is worked out by utils/cricket.
    RUN: { allowed: [0, 1, 2, 3, 4, 5, 6], legal: true },
    BYE: { allowed: [1, 2, 3, 4, 5], legal: true },
    LEG_BYE: { allowed: [1, 2, 3, 4, 5], legal: true },
    WIDE: { allowed: [1, 2, 3, 4, 5] },            // 1 penalty + anything run; never a legal ball
    NO_BALL: { allowed: [1, 2, 3, 4, 5, 6, 7] },   // 1 penalty + runs off the bat or byes
    WICKET: { allowed: [0, 1, 2, 3], legal: true, max: 10 },  // runs completed before a run out
  },
  sets: {
    POINT: { score: 0 },
    SET_WON: { score: 1 },
    FOUL: { score: 0 },
    TIMEOUT: { score: 0 },
  },
};

const PERIODS = {
  goals: ['1st Half', 'Half Time', '2nd Half', 'Extra Time', 'Penalties'],
  basket: ['Q1', 'Q2', 'Q3', 'Q4', 'Overtime'],
  cricket: ['1st Innings', 'Innings Break', '2nd Innings', 'Super Over'],
  sets: ['Set 1', 'Set 2', 'Set 3', 'Set 4', 'Set 5'],
};

// Validates a scoring event for a sport. Returns { type, delta, legal, max } or { error }.
function resolveScoreEvent(sport, eventType, rawValue) {
  const family = familyOf(sport);
  const spec = EVENTS[family][eventType];
  if (!spec) {
    return { error: `"${eventType}" is not a valid event for ${sport || 'this sport'}. Allowed: ${Object.keys(EVENTS[family]).join(', ')}` };
  }
  let delta;
  if (spec.allowed) {
    delta = Number(rawValue);
    if (!Number.isInteger(delta) || !spec.allowed.includes(delta)) {
      return { error: `${eventType} value must be one of ${spec.allowed.join(', ')}` };
    }
  } else {
    delta = spec.score;
  }
  return { type: eventType, delta, legal: !!spec.legal, max: spec.max || null };
}

const isMatchMarker = (type) => /^MATCH_|^PERIOD/.test(type);

function oversFromBalls(balls) {
  return `${Math.floor(balls / 6)}.${balls % 6}`;
}

// Per-team statistics derived from events. `events` = non-undone events (any order).
function summarize(sport, match, events) {
  const family = familyOf(sport);
  const blank = () => ({ score: 0 });
  const out = { family, a: blank(), b: blank() };
  const side = (teamId) => (teamId != null && Number(teamId) === Number(match.team_a_id) ? 'a' : teamId != null && Number(teamId) === Number(match.team_b_id) ? 'b' : null);
  const sorted = [...events].sort((x, y) => x.id - y.id);

  out.a.score = Number(match.team_a_score) || 0;
  out.b.score = Number(match.team_b_score) || 0;

  if (family === 'goals') {
    for (const s of ['a', 'b']) Object.assign(out[s], { goals: out[s].score, yellow_cards: 0, red_cards: 0, substitutions: 0, fouls: 0, assists: 0 });
    for (const e of sorted) {
      const s = side(e.team_id); if (!s) continue;
      if (e.event_type === 'YELLOW_CARD') out[s].yellow_cards++;
      else if (e.event_type === 'RED_CARD') out[s].red_cards++;
      else if (e.event_type === 'SUBSTITUTION') out[s].substitutions++;
      else if (e.event_type === 'FOUL') out[s].fouls++;
      else if (e.event_type === 'ASSIST') out[s].assists++;
    }
  } else if (family === 'basket') {
    for (const s of ['a', 'b']) Object.assign(out[s], { points: out[s].score, threes: 0, fouls: 0, assists: 0 });
    for (const e of sorted) {
      const s = side(e.team_id); if (!s) continue;
      if (e.event_type === '3_POINTS') out[s].threes++;
      else if (e.event_type === 'FOUL') out[s].fouls++;
      else if (e.event_type === 'ASSIST') out[s].assists++;
    }
  } else if (family === 'cricket') {
    // One source of truth: utils/cricket replays the deliveries. The per-team figures below are read from
    // that replay rather than counted a second time here, so the card and the scoreboard always agree.
    const { replay } = require('./cricket');
    const full = replay(sorted, { oversLimit: match.overs_limit || null });
    for (const s of ['a', 'b']) Object.assign(out[s], { runs: 0, wickets: 0, legal_balls: 0, extras: 0, fours: 0, sixes: 0, overs: '0.0', run_rate: 0 });
    for (const inn of full.innings) {
      const s = side(inn.batting_team_id);
      if (!s) continue;
      out[s].runs += inn.runs;
      out[s].wickets += inn.wickets;
      out[s].legal_balls += inn.legal_balls;
      out[s].extras += inn.extras.total;
      for (const b of Object.values(inn.batters)) { out[s].fours += b.fours; out[s].sixes += b.sixes; }
    }
    for (const s of ['a', 'b']) {
      out[s].overs = oversFromBalls(out[s].legal_balls);
      out[s].run_rate = out[s].legal_balls ? Math.round((out[s].runs / (out[s].legal_balls / 6)) * 100) / 100 : 0;
    }
    out.cricket = full;
  } else if (family === 'sets') {
    for (const s of ['a', 'b']) Object.assign(out[s], { sets: out[s].score, points: 0 });
    // points in the CURRENT set = points scored after the last SET_WON
    const lastSetWon = sorted.filter(e => e.event_type === 'SET_WON').reduce((m, e) => Math.max(m, e.id), 0);
    for (const e of sorted) {
      if (e.event_type !== 'POINT' || e.id < lastSetWon) continue;
      const s = side(e.team_id); if (s) out[s].points++;
    }
    out.current_set = 1 + sorted.filter(e => e.event_type === 'SET_WON').length;
  }
  return out;
}

const metaOf = (e) => {
  let m = e.metadata;
  if (typeof m === 'string') { try { m = JSON.parse(m); } catch { m = null; } }
  return m && typeof m === 'object' ? m : {};
};

// Per-player statistics, derived from the same non-undone events (so undo/corrections stay consistent).
// Keys are user ids. Only stats that make sense for the sport are filled in.
function playerStats(sport, events) {
  const family = familyOf(sport);
  const out = {};
  const get = (id) => { if (id == null) return null; const k = String(id); return out[k] || (out[k] = {}); };
  const add = (p, key, n = 1) => { if (p) p[key] = (p[key] || 0) + n; };
  const sorted = [...events].sort((x, y) => x.id - y.id);

  for (const e of sorted) {
    const p = get(e.player_id);
    if (family === 'goals') {
      if (!p) continue;
      if (e.event_type === 'GOAL' || e.event_type === 'POINT') add(p, 'goals');
      else if (e.event_type === 'ASSIST') add(p, 'assists');
      else if (e.event_type === 'YELLOW_CARD') add(p, 'yellow_cards');
      else if (e.event_type === 'RED_CARD') add(p, 'red_cards');
    } else if (family === 'basket') {
      if (!p) continue;
      if (['1_POINT', '2_POINTS', '3_POINTS'].includes(e.event_type)) { add(p, 'points', Number(e.value) || 0); if (e.event_type === '3_POINTS') add(p, 'threes'); }
      else if (e.event_type === 'ASSIST') add(p, 'assists');
      else if (e.event_type === 'FOUL') add(p, 'fouls');
    } else if (family === 'cricket') {
      const spec = EVENTS.cricket[e.event_type];
      if (!spec) continue;
      const bowler = get(metaOf(e).bowler_id);
      const runs = Number(e.value) || 0;
      // batting: the striker faces every legal ball (wides are not faced); byes/leg byes are not his runs
      if (p) {
        if (e.event_type === 'RUN') { add(p, 'runs', runs); if (runs === 4) add(p, 'fours'); if (runs === 6) add(p, 'sixes'); }
        if (spec.legal) add(p, 'balls');
        if (e.event_type === 'WICKET') p.out = true;
      }
      // bowling: legal deliveries, runs conceded (byes/leg byes are not charged to the bowler), wickets
      if (bowler) {
        if (spec.legal) add(bowler, 'bowl_balls');
        if (e.event_type === 'RUN' || e.event_type === 'WIDE' || e.event_type === 'NO_BALL') add(bowler, 'bowl_runs', runs);
        if (e.event_type === 'WICKET') add(bowler, 'bowl_wickets');
      }
    }
  }
  if (family === 'cricket') {
    for (const p of Object.values(out)) {
      if (p.balls !== undefined || p.runs !== undefined) p.strike_rate = p.balls ? Math.round(((p.runs || 0) / p.balls) * 10000) / 100 : 0;
      if (p.bowl_balls !== undefined || p.bowl_runs !== undefined || p.bowl_wickets !== undefined) {
        p.bowl_overs = oversFromBalls(p.bowl_balls || 0);
        p.economy = p.bowl_balls ? Math.round(((p.bowl_runs || 0) / (p.bowl_balls / 6)) * 100) / 100 : 0;
      }
    }
  }
  return out;
}

// Who is at the crease / bowling right now: taken from the latest ball. After a wicket the next batter is not known yet.
function currentCricket(events) {
  const balls = events.filter((e) => EVENTS.cricket[e.event_type]).sort((x, y) => y.id - x.id);
  const last = balls[0];
  if (!last) return { batter_id: null, bowler_id: null, batting_team_id: null };
  const m = metaOf(last);
  return {
    batter_id: last.event_type === 'WICKET' ? null : (last.player_id || null),
    bowler_id: m.bowler_id || null,
    batting_team_id: last.team_id || null,
  };
}

module.exports = { familyOf, resolveScoreEvent, summarize, isMatchMarker, PERIODS, EVENTS, oversFromBalls, playerStats, currentCricket, metaOf };
