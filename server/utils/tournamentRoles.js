const ROLES_BY_SPORT = {
  cricket: ['PLAYER', 'BATTER', 'BOWLER', 'ALL_ROUNDER', 'WICKETKEEPER', 'UMPIRE'],
  football: ['PLAYER', 'GOALKEEPER', 'DEFENDER', 'MIDFIELDER', 'FORWARD'],
  basketball: ['PLAYER', 'POINT_GUARD', 'SHOOTING_GUARD', 'SMALL_FORWARD', 'POWER_FORWARD', 'CENTER'],
  volleyball: ['PLAYER', 'SETTER', 'LIBERO', 'OUTSIDE_HITTER', 'OPPOSITE', 'MIDDLE_BLOCKER'],
};

function isCricketSport(sport) {
  return String(sport || '').trim().toLowerCase() === 'cricket';
}

function roleOptionsForSport(sport) {
  return ROLES_BY_SPORT[String(sport || '').trim().toLowerCase()] || ['PLAYER'];
}

function roleForSport(role, sport) {
  const allowed = roleOptionsForSport(sport);
  return allowed.includes(role) ? role : 'PLAYER';
}

module.exports = { isCricketSport, roleOptionsForSport, roleForSport };
