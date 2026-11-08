const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { verifyToken } = require('../middleware/auth');
const { verifyHost, manageableRows, findManageableTournament } = require('../utils/tournamentAccess');
const { parseYouTubeUrl, youtubePayload } = require('../utils/youtube');
const { parseDateOnly, dateOnlyResponses } = require('../utils/tournamentValidation');
const { notifyTournament, notifyMatch } = require('../utils/liveMatch');
const { fire: fireNotification } = require('../utils/notifications/events');
const { isCricketSport, roleForSport } = require('../utils/tournamentRoles');

// SQL DATE columns (match_date...) leave this router as plain 'YYYY-MM-DD', never a timezone-shifted timestamp.
router.use(dateOnlyResponses);

async function requirePaidTournament(req, res, next) {
  try {
    const tournament = await findManageableTournament(pool, req.params.id, req.tHost, {
      columns: 'status, is_paid_to_admin',
    });
    if (!tournament) return res.status(404).json({ success: false, error: 'Tournament not found or not yours to manage' });
    if (req.tHost.type !== 'admin' && tournament.status === 'DRAFT' && !tournament.is_paid_to_admin) {
      return res.status(402).json({ success: false, error: 'Pay the tournament creation fee before managing this draft' });
    }
    next();
  } catch (error) {
    console.error('Error checking tournament payment status:', error);
    res.status(500).json({ success: false, error: 'Could not verify tournament payment status' });
  }
}

// Helper to record audit logs
async function recordAuditLog(connectionOrPool, tournamentId, actorId, action, entity, entityId, prevValue = null, newValue = null) {
  try {
    await connectionOrPool.query(`
      INSERT INTO tournament_audit_logs (tournament_id, actor_id, action, entity, entity_id, prev_value, new_value)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      tournamentId, actorId, action, entity, entityId || null,
      prevValue ? JSON.stringify(prevValue) : null,
      newValue ? JSON.stringify(newValue) : null
    ]);
  } catch (err) {
    console.error('Audit log error:', err.message);
  }
}

// ----------------------------------------------------
// PARTICIPANT MANAGEMENT
// ----------------------------------------------------

// GET /api/tournaments/:id/participants - Host views participants
router.get('/:id/participants', verifyToken, verifyHost, async (req, res) => {
  try {
    const tournamentId = req.params.id;
    const ownerId = req.user.id;
    const { status } = req.query;

    // Verify ownership
    const tournaments = await manageableRows(pool, tournamentId, req.tHost, 'id', false);
    if (tournaments.length === 0) {
      return res.status(403).json({ success: false, error: 'Unauthorized or tournament not found' });
    }

    // LEFT JOIN, not JOIN: a roster member added by the organizer may have no Book Arena account, and an
    // INNER JOIN here is what used to make those players vanish from the list entirely.
    let query = `
      SELECT p.*, u.name as user_name, u.email as user_email, COALESCE(p.profile_photo, u.profile_pic) as avatar, u.profile_pic as user_avatar,
             COALESCE(p.player_name, u.name) AS display_name,
             t.name as team_name
      FROM tournament_participants p
      LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN tournament_teams t ON p.team_id = t.id
      WHERE p.tournament_id = ?
    `;
    const params = [tournamentId];

    if (status && status !== 'ALL') {
      query += ` AND p.status = ?`;
      params.push(status);
    }

    query += ' ORDER BY p.registered_at DESC';

    const [participants] = await pool.query(query, params);
    res.json({ success: true, participants });
  } catch (error) {
    console.error('Error fetching participants:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch participants' });
  }
});

// PATCH /api/tournaments/:id/participants/:participantId - Approve / Reject / Waitlist / Assign Team
router.patch('/:id/participants/:participantId', verifyToken, verifyHost, requirePaidTournament, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { id: tournamentId, participantId } = req.params;
    const { status, team_id, position, jersey_number } = req.body;
    const ownerId = req.user.id;

    // 1. Verify owner & lock tournament row for capacity check
    const tournaments = await manageableRows(connection, tournamentId, req.tHost, '*', true);
    if (tournaments.length === 0) {
      await connection.rollback();
      return res.status(403).json({ success: false, error: 'Unauthorized or tournament not found' });
    }
    const tournament = tournaments[0];

    // 2. Fetch existing participant
    const [participants] = await connection.query(
      'SELECT * FROM tournament_participants WHERE id = ? AND tournament_id = ? FOR UPDATE',
      [participantId, tournamentId]
    );
    if (participants.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, error: 'Participant not found' });
    }
    const participant = participants[0];

    // 3. If approving, check capacity limits with strict transaction lock
    if (status === 'APPROVED' && participant.status !== 'APPROVED') {
      if (tournament.max_participants) {
        const [approvedCount] = await connection.query(
          "SELECT COUNT(*) as count FROM tournament_participants WHERE tournament_id = ? AND status = 'APPROVED'",
          [tournamentId]
        );
        if (approvedCount[0].count >= tournament.max_participants) {
          await connection.rollback();
          return res.status(400).json({ success: false, error: 'Tournament participant capacity reached' });
        }
      }

      // If assigned to a team, check team capacity
      const targetTeamId = team_id !== undefined ? team_id : participant.team_id;
      if (targetTeamId) {
        const [teams] = await connection.query('SELECT max_players FROM tournament_teams WHERE id = ?', [targetTeamId]);
        if (teams.length > 0 && teams[0].max_players) {
          const [teamCount] = await connection.query(
            "SELECT COUNT(*) as count FROM tournament_participants WHERE team_id = ? AND status = 'APPROVED'",
            [targetTeamId]
          );
          if (teamCount[0].count >= teams[0].max_players) {
            await connection.rollback();
            return res.status(400).json({ success: false, error: 'Team maximum capacity reached' });
          }
        }
      }
    }

    // 4. Update participant
    const updateFields = [];
    const updateParams = [];

    if (status) {
      updateFields.push('status = ?');
      updateParams.push(status);
    }
    if (team_id !== undefined) {
      updateFields.push('team_id = ?');
      updateParams.push(team_id || null);
    }
    if (position !== undefined) {
      updateFields.push('position = ?');
      updateParams.push(position || null);
    }
    if (jersey_number !== undefined) {
      updateFields.push('jersey_number = ?');
      updateParams.push(jersey_number || null);
    }

    if (updateFields.length > 0) {
      updateParams.push(participantId);
      await connection.query(
        `UPDATE tournament_participants SET ${updateFields.join(', ')} WHERE id = ?`,
        updateParams
      );
    }

    // Also sync join request status if any
    if (status) {
      await connection.query(
        'UPDATE tournament_join_requests SET status = ? WHERE tournament_id = ? AND user_id = ?',
        [status === 'APPROVED' ? 'APPROVED' : status === 'REJECTED' ? 'REJECTED' : 'PENDING', tournamentId, participant.user_id]
      );
    }

    await recordAuditLog(connection, tournamentId, ownerId, 'UPDATE_PARTICIPANT', 'participant', participantId, participant, { status, team_id });
    await connection.commit();

    // tell the player what the host decided (checked against the row, deduplicated per decision)
    if (status) fireNotification('tournament.join_decided', { participantId });
    if (team_id) fireNotification('tournament.team_assigned', { participantId });

    res.json({ success: true, message: 'Participant updated successfully' });
  } catch (error) {
    await connection.rollback();
    console.error('Error updating participant:', error);
    res.status(500).json({ success: false, error: 'Failed to update participant' });
  } finally {
    connection.release();
  }
});

// ----------------------------------------------------
// TEAM MANAGEMENT
// ----------------------------------------------------

// GET /api/tournaments/:id/teams
router.get('/:id/teams', async (req, res) => {
  try {
    const tournamentId = req.params.id;

    const [teams] = await pool.query(`
      SELECT t.*, 
             c.name as captain_name,
             vc.name as vice_captain_name,
             COUNT(p.id) as player_count
      FROM tournament_teams t
      LEFT JOIN users c ON t.captain_id = c.id
      LEFT JOIN users vc ON t.vice_captain_id = vc.id
      LEFT JOIN tournament_participants p ON t.id = p.team_id AND p.status = 'APPROVED'
      WHERE t.tournament_id = ?
      GROUP BY t.id, c.name, vc.name
      ORDER BY t.created_at ASC
    `, [tournamentId]);

    res.json({ success: true, teams });
  } catch (error) {
    console.error('Error fetching teams:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch teams' });
  }
});

// GET /api/tournaments/:id/teams/:teamId - Get squad
router.get('/:id/teams/:teamId', async (req, res) => {
  try {
    const { id: tournamentId, teamId } = req.params;

    const [teams] = await pool.query('SELECT * FROM tournament_teams WHERE id = ? AND tournament_id = ?', [teamId, tournamentId]);
    if (teams.length === 0) {
      return res.status(404).json({ success: false, error: 'Team not found' });
    }

    // LEFT JOIN: a roster player need not have a Book Arena account. The INNER JOIN that used to be here
    // is why an organizer's hand-built squad looked empty on the team card.
    const [players] = await pool.query(`
      SELECT p.id, p.user_id, p.team_id, p.jersey_number, p.position, COALESCE(p.player_name, u.name) AS name,
             COALESCE(p.profile_photo, u.profile_pic) AS avatar,
             p.player_role, p.batting_style, p.bowling_style, p.is_captain, p.is_vice_captain, p.is_substitute
      FROM tournament_participants p
      LEFT JOIN users u ON p.user_id = u.id
      WHERE p.team_id = ? AND p.tournament_id = ? AND p.status = 'APPROVED'
      ORDER BY p.is_substitute ASC, p.id ASC
    `, [teamId, tournamentId]);

    res.json({ success: true, team: teams[0], players });
  } catch (error) {
    console.error('Error fetching team squad:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch team squad' });
  }
});

// POST /api/tournaments/:id/teams - Host creates team
router.post('/:id/teams', verifyToken, verifyHost, requirePaidTournament, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const tournamentId = req.params.id;
    const ownerId = req.user.id;
    const { name, logo, color, captain_id, vice_captain_id, description, max_players, group_name } = req.body || {};

    // Bad input is a 400 the caller can fix. Without this a missing/blank name reached name.trim() and became a 500.
    if (typeof name !== 'string' || !name.trim()) {
      await connection.rollback();
      return res.status(400).json({ success: false, error: 'Team name is required' });
    }
    if (name.trim().length > 100) {
      await connection.rollback();
      return res.status(400).json({ success: false, error: 'Team name must be 100 characters or fewer' });
    }

    // Verify owner
    const tournaments = await manageableRows(connection, tournamentId, req.tHost, 'max_teams', false);
    if (tournaments.length === 0) {
      await connection.rollback();
      return res.status(403).json({ success: false, error: 'Unauthorized or tournament not found' });
    }

    // Enforce max teams limit if configured
    if (tournaments[0].max_teams) {
      const [existingTeamsCount] = await connection.query('SELECT COUNT(*) as count FROM tournament_teams WHERE tournament_id = ?', [tournamentId]);
      if (existingTeamsCount[0].count >= tournaments[0].max_teams) {
        await connection.rollback();
        return res.status(400).json({ success: false, error: 'Maximum teams limit reached for this tournament' });
      }
    }

    // Check name uniqueness inside tournament
    const [duplicate] = await connection.query('SELECT id FROM tournament_teams WHERE tournament_id = ? AND LOWER(name) = LOWER(?)', [tournamentId, name.trim()]);
    if (duplicate.length > 0) {
      await connection.rollback();
      return res.status(400).json({ success: false, error: 'A team with this name already exists in this tournament' });
    }

    const [result] = await connection.query(`
      INSERT INTO tournament_teams (tournament_id, name, logo, color, captain_id, vice_captain_id, description, max_players, group_name, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')
    `, [tournamentId, name.trim(), logo || null, color || '#3B82F6', captain_id || null, vice_captain_id || null, description || null, max_players || null, group_name || null]);

    const teamId = result.insertId;

    // If captain_id provided, assign participant to this team
    if (captain_id) {
      await connection.query(`
        UPDATE tournament_participants SET team_id = ? WHERE tournament_id = ? AND user_id = ?
      `, [teamId, tournamentId, captain_id]);
    }

    await recordAuditLog(connection, tournamentId, ownerId, 'CREATE_TEAM', 'team', teamId, null, { name, captain_id });
    await connection.commit();

    res.json({ success: true, message: 'Team created successfully', team_id: teamId });
  } catch (error) {
    await connection.rollback();
    console.error('Error creating team:', error);
    res.status(500).json({ success: false, error: 'Failed to create team' });
  } finally {
    connection.release();
  }
});

// PATCH /api/tournaments/:id/teams/:teamId - Host edits team / Locks / Unlocks / Transfers Captain
router.patch('/:id/teams/:teamId', verifyToken, verifyHost, requirePaidTournament, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { id: tournamentId, teamId } = req.params;
    const ownerId = req.user.id;
    const { name, logo, color, captain_id, vice_captain_id, description, max_players, group_name, status } = req.body;

    const tournaments = await manageableRows(connection, tournamentId, req.tHost, 'owner_id', false);
    if (tournaments.length === 0) {
      await connection.rollback();
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    const [existing] = await connection.query('SELECT * FROM tournament_teams WHERE id = ? AND tournament_id = ?', [teamId, tournamentId]);
    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, error: 'Team not found' });
    }

    // Name uniqueness check if changing name
    if (name && name.trim().toLowerCase() !== existing[0].name.toLowerCase()) {
      const [duplicate] = await connection.query('SELECT id FROM tournament_teams WHERE tournament_id = ? AND LOWER(name) = LOWER(?) AND id != ?', [tournamentId, name.trim(), teamId]);
      if (duplicate.length > 0) {
        await connection.rollback();
        return res.status(400).json({ success: false, error: 'Team name already in use' });
      }
    }

    const updates = [];
    const params = [];

    if (name) { updates.push('name = ?'); params.push(name.trim()); }
    if (logo !== undefined) { updates.push('logo = ?'); params.push(logo || null); }
    if (color) { updates.push('color = ?'); params.push(color); }
    if (captain_id !== undefined) { updates.push('captain_id = ?'); params.push(captain_id || null); }
    if (vice_captain_id !== undefined) { updates.push('vice_captain_id = ?'); params.push(vice_captain_id || null); }
    if (description !== undefined) { updates.push('description = ?'); params.push(description || null); }
    if (max_players !== undefined) { updates.push('max_players = ?'); params.push(max_players || null); }
    if (group_name !== undefined) { updates.push('group_name = ?'); params.push(group_name || null); }
    if (status) { updates.push('status = ?'); params.push(status); }

    if (updates.length > 0) {
      params.push(teamId);
      await connection.query(`UPDATE tournament_teams SET ${updates.join(', ')} WHERE id = ?`, params);
    }

    await recordAuditLog(connection, tournamentId, ownerId, 'UPDATE_TEAM', 'team', teamId, existing[0], req.body);
    await connection.commit();

    res.json({ success: true, message: 'Team updated successfully' });
  } catch (error) {
    await connection.rollback();
    console.error('Error updating team:', error);
    res.status(500).json({ success: false, error: 'Failed to update team' });
  } finally {
    connection.release();
  }
});

// DELETE /api/tournaments/:id/teams/:teamId - Delete team (Rule: cannot delete if matches have started)
router.delete('/:id/teams/:teamId', verifyToken, verifyHost, requirePaidTournament, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { id: tournamentId, teamId } = req.params;
    const ownerId = req.user.id;

    const tournaments = await manageableRows(connection, tournamentId, req.tHost, 'owner_id', false);
    if (tournaments.length === 0) {
      await connection.rollback();
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    // Check if matches have started or fixtures created
    const [startedMatches] = await connection.query(
      "SELECT id FROM tournament_fixtures WHERE tournament_id = ? AND (team_a_id = ? OR team_b_id = ?) AND status != 'SCHEDULED'",
      [tournamentId, teamId, teamId]
    );

    if (startedMatches.length > 0) {
      await connection.rollback();
      return res.status(400).json({ success: false, error: 'Cannot delete team after matches have begun or been played' });
    }

    // Unassign players from this team
    await connection.query('UPDATE tournament_participants SET team_id = NULL WHERE team_id = ?', [teamId]);

    // Remove team
    await connection.query('DELETE FROM tournament_teams WHERE id = ? AND tournament_id = ?', [teamId, tournamentId]);

    await recordAuditLog(connection, tournamentId, ownerId, 'DELETE_TEAM', 'team', teamId);
    await connection.commit();

    res.json({ success: true, message: 'Team deleted successfully' });
  } catch (error) {
    await connection.rollback();
    console.error('Error deleting team:', error);
    res.status(500).json({ success: false, error: 'Failed to delete team' });
  } finally {
    connection.release();
  }
});

// ----------------------------------------------------
// FIXTURE GENERATION & MANAGEMENT
// ----------------------------------------------------

// POST /api/tournaments/:id/fixtures/generate - Auto Fixture Generator
router.post('/:id/fixtures/generate', verifyToken, verifyHost, requirePaidTournament, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const tournamentId = req.params.id;
    const ownerId = req.user.id;

    // Fetch tournament configuration
    const tournaments = await manageableRows(connection, tournamentId, req.tHost, '*', false);
    if (tournaments.length === 0) {
      await connection.rollback();
      return res.status(403).json({ success: false, error: 'Unauthorized or tournament not found' });
    }
    const t = tournaments[0];

    // Fetch approved teams
    const [teams] = await connection.query('SELECT id, name, group_name FROM tournament_teams WHERE tournament_id = ? ORDER BY id ASC', [tournamentId]);

    if (teams.length < 2) {
      await connection.rollback();
      return res.status(400).json({ success: false, error: 'At least 2 teams are required to generate fixtures' });
    }

    const [[startedFixtures]] = await connection.query(
      "SELECT COUNT(*) AS count FROM tournament_fixtures WHERE tournament_id = ? AND status <> 'SCHEDULED'",
      [tournamentId]);
    if (Number(startedFixtures.count) > 0) {
      await connection.rollback();
      return res.status(409).json({ success: false, error: 'Fixtures cannot be regenerated after a match or bye has been recorded' });
    }

    // Replace only untouched schedules; played or advanced brackets are preserved above.
    await connection.query("DELETE FROM tournament_fixtures WHERE tournament_id = ? AND status = 'SCHEDULED'", [tournamentId]);

    const format = t.format_type; // 'Knockout', 'Round Robin', 'Group Stage + Knockout'
    if (!['Knockout', 'Round Robin', 'Group Stage + Knockout'].includes(format)) {
      await connection.rollback();
      return res.status(400).json({ success: false, error: 'This tournament format cannot generate fixtures' });
    }
    const generatedFixtures = [];

    if (format === 'Knockout') {
      // Build Knockout Bracket
      const numTeams = teams.length;
      // Calculate next power of 2 for bracket size (e.g. 4, 8, 16)
      let bracketSize = 2;
      while (bracketSize < numTeams) bracketSize *= 2;

      // Seed teams
      const seeded = [...teams];
      while (seeded.length < bracketSize) {
        seeded.push(null); // Bye
      }

      // Generate Round 1
      const round1Count = bracketSize / 2;
      const r1MatchIds = [];

      let stageName = round1Count === 8 ? 'Round of 16' : round1Count === 4 ? 'Quarter Final' : round1Count === 2 ? 'Semi Final' : 'Final';

      for (let i = 0; i < round1Count; i++) {
        const teamA = seeded[i * 2];
        const teamB = seeded[i * 2 + 1];

        // If teamB is BYE, teamA automatically wins or advances
        const winnerId = (teamA && !teamB) ? teamA.id : (teamB && !teamA) ? teamB.id : null;

        const [res] = await connection.query(`
          INSERT INTO tournament_fixtures (tournament_id, stage, round_number, match_number, team_a_id, team_b_id, status, winner_id)
          VALUES (?, ?, 1, ?, ?, ?, ?, ?)
        `, [
          tournamentId, stageName, i + 1,
          teamA ? teamA.id : null,
          teamB ? teamB.id : null,
          winnerId ? 'FINISHED' : 'SCHEDULED',
          winnerId
        ]);

        r1MatchIds.push(res.insertId);
        generatedFixtures.push(res.insertId);
      }

      // Generate subsequent rounds (Semi Finals, Final, Third Place)
      let currentRoundMatches = r1MatchIds;
      let currentRoundNum = 1;
      let remainingPairs = round1Count;

      while (remainingPairs > 1) {
        currentRoundNum++;
        remainingPairs = remainingPairs / 2;
        const nextRoundStage = remainingPairs === 4 ? 'Quarter Final' : remainingPairs === 2 ? 'Semi Final' : 'Final';
        const nextRoundMatchIds = [];

        for (let i = 0; i < remainingPairs; i++) {
          const matchA_Id = currentRoundMatches[i * 2];
          const matchB_Id = currentRoundMatches[i * 2 + 1];

          const [nextMatch] = await connection.query(`
            INSERT INTO tournament_fixtures (tournament_id, stage, round_number, match_number, status)
            VALUES (?, ?, ?, ?, 'SCHEDULED')
          `, [tournamentId, nextRoundStage, currentRoundNum, i + 1]);

          const nextId = nextMatch.insertId;
          nextRoundMatchIds.push(nextId);
          generatedFixtures.push(nextId);

          // Update previous round matches to point to next_match_id
          await connection.query('UPDATE tournament_fixtures SET next_match_id = ?, next_match_slot = "A" WHERE id = ?', [nextId, matchA_Id]);
          await connection.query('UPDATE tournament_fixtures SET next_match_id = ?, next_match_slot = "B" WHERE id = ?', [nextId, matchB_Id]);

          // A bye is already a finished first-round fixture; carry its winner into the next round immediately.
          const [children] = await connection.query(
            'SELECT id, winner_id FROM tournament_fixtures WHERE id IN (?, ?)',
            [matchA_Id, matchB_Id]);
          for (const child of children) {
            if (child.winner_id) {
              const slot = Number(child.id) === Number(matchA_Id) ? 'team_a_id' : 'team_b_id';
              await connection.query(`UPDATE tournament_fixtures SET ${slot} = ? WHERE id = ?`, [child.winner_id, nextId]);
            }
          }
        }

        currentRoundMatches = nextRoundMatchIds;
      }

    } else if (format === 'Round Robin') {
      // Standard Round Robin Algorithm (Berger Tables / Round Robin scheduling)
      const list = [...teams];
      if (list.length % 2 !== 0) {
        list.push(null); // Dummy team for BYE
      }

      const totalRounds = list.length - 1;
      const matchesPerRound = list.length / 2;

      for (let round = 0; round < totalRounds; round++) {
        for (let match = 0; match < matchesPerRound; match++) {
          const teamA = list[match];
          const teamB = list[list.length - 1 - match];

          if (teamA && teamB) {
            const [res] = await connection.query(`
              INSERT INTO tournament_fixtures (tournament_id, stage, round_number, match_number, team_a_id, team_b_id, status)
              VALUES (?, 'League', ?, ?, ?, ?, 'SCHEDULED')
            `, [tournamentId, round + 1, match + 1, teamA.id, teamB.id]);
            generatedFixtures.push(res.insertId);
          }
        }
        // Rotate array except first item
        list.splice(1, 0, list.pop());
      }

    } else if (format === 'Group Stage + Knockout') {
      // Group Stage Allocation & Fixtures
      const numGroups = t.number_of_groups || 2;
      const groupNames = Array.from({ length: numGroups }, (_, i) => String.fromCharCode(65 + i)); // Group A, B...

      // Assign teams to groups if not assigned
      for (let i = 0; i < teams.length; i++) {
        const groupName = `Group ${groupNames[i % numGroups]}`;
        await connection.query('UPDATE tournament_teams SET group_name = ? WHERE id = ?', [groupName, teams[i].id]);
        teams[i].group_name = groupName;
      }

      // Generate round robin for each group
      for (const gName of groupNames) {
        const fullGName = `Group ${gName}`;
        const gTeams = teams.filter(tm => tm.group_name === fullGName);

        const list = [...gTeams];
        if (list.length % 2 !== 0) list.push(null);

        const totalRounds = list.length - 1;
        const matchesPerRound = list.length / 2;

        for (let round = 0; round < totalRounds; round++) {
          for (let match = 0; match < matchesPerRound; match++) {
            const teamA = list[match];
            const teamB = list[list.length - 1 - match];

            if (teamA && teamB) {
              const [res] = await connection.query(`
                INSERT INTO tournament_fixtures (tournament_id, stage, group_name, round_number, match_number, team_a_id, team_b_id, status)
                VALUES (?, 'Group Stage', ?, ?, ?, ?, ?, 'SCHEDULED')
              `, [tournamentId, fullGName, round + 1, match + 1, teamA.id, teamB.id]);
              generatedFixtures.push(res.insertId);
            }
          }
          list.splice(1, 0, list.pop());
        }
      }
    }

    // Update tournament status to UPCOMING if draft
    if (t.status === 'DRAFT') {
      await connection.query("UPDATE tournaments SET status = 'UPCOMING' WHERE id = ?", [tournamentId]);
    }

    await recordAuditLog(connection, tournamentId, ownerId, 'GENERATE_FIXTURES', 'tournament', tournamentId, null, { count: generatedFixtures.length });
    await connection.commit();

    res.json({ success: true, message: `Generated ${generatedFixtures.length} match fixtures successfully` });
  } catch (error) {
    await connection.rollback();
    console.error('Error generating fixtures:', error);
    res.status(500).json({ success: false, error: 'Failed to generate fixtures' });
  } finally {
    connection.release();
  }
});

// GET /api/tournaments/:id/fixtures - Get all fixtures
router.get('/:id/fixtures', async (req, res) => {
  try {
    const tournamentId = req.params.id;

    const [fixtures] = await pool.query(`
      SELECT f.*,
             ta.name as team_a_name, ta.logo as team_a_logo, ta.color as team_a_color,
             tb.name as team_b_name, tb.logo as team_b_logo, tb.color as team_b_color,
             w.name as winner_name
      FROM tournament_fixtures f
      LEFT JOIN tournament_teams ta ON f.team_a_id = ta.id
      LEFT JOIN tournament_teams tb ON f.team_b_id = tb.id
      LEFT JOIN tournament_teams w ON f.winner_id = w.id
      WHERE f.tournament_id = ?
      ORDER BY f.round_number ASC, f.id ASC
    `, [tournamentId]);

    res.json({ success: true, fixtures });
  } catch (error) {
    console.error('Error fetching fixtures:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch fixtures' });
  }
});

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// Validates the schedule fields shared by "create match" and "edit match". Returns { error } or { values }.
function matchDetails(body, { isCreate }) {
  const v = {};
  if (body.match_date !== undefined) {
    if (body.match_date === null || body.match_date === '') v.match_date = null;
    else {
      const d = parseDateOnly(body.match_date);
      if (!d) return { error: 'Match date must be a valid date (YYYY-MM-DD)' };
      v.match_date = d;
    }
  }
  if (body.match_time !== undefined) {
    if (body.match_time === null || body.match_time === '') v.match_time = null;
    else if (typeof body.match_time === 'string' && TIME_RE.test(body.match_time.trim())) v.match_time = body.match_time.trim() + ':00';
    else return { error: 'Match time must be HH:MM (24-hour)' };
  }
  const text = (key, max, label) => {
    if (body[key] === undefined) return null;
    const val = body[key] === null ? '' : String(body[key]).trim();
    if (val.length > max) return `${label} is too long (max ${max} characters)`;
    v[key] = val || null;
    return null;
  };
  for (const [key, max, label] of [['venue', 255, 'Venue'], ['stage', 100, 'Round'], ['group_name', 50, 'Group'], ['format_label', 60, 'Match format'], ['referee_name', 255, 'Referee'], ['notes', 1000, 'Notes']]) {
    const err = text(key, max, label);
    if (err) return { error: err };
  }
  if (body.duration_min !== undefined) {
    if (body.duration_min === null || body.duration_min === '') v.duration_min = null;
    else {
      const n = Number(body.duration_min);
      if (!Number.isInteger(n) || n < 1 || n > 600) return { error: 'Match duration must be between 1 and 600 minutes' };
      v.duration_min = n;
    }
  }
  if (isCreate && !v.stage) v.stage = 'Match';
  return { values: v };
}

// POST /api/tournaments/:id/fixtures - Host/admin creates ONE match by hand (no bracket generation needed)
router.post('/:id/fixtures', verifyToken, verifyHost, requirePaidTournament, async (req, res) => {
  try {
    const tournamentId = req.params.id;
    const t = (await manageableRows(pool, tournamentId, req.tHost, 'id, venue, status', false))[0];
    if (!t) return res.status(403).json({ success: false, error: 'Unauthorized or tournament not found' });
    if (t.status === 'CANCELLED') return res.status(409).json({ success: false, error: 'This tournament is cancelled' });

    const body = req.body || {};
    const a = /^\d+$/.test(String(body.team_a_id)) ? Number(body.team_a_id) : null;
    const b = /^\d+$/.test(String(body.team_b_id)) ? Number(body.team_b_id) : null;
    if (!a || !b) return res.status(400).json({ success: false, error: 'Choose both teams' });
    if (a === b) return res.status(400).json({ success: false, error: 'A team cannot play itself' });
    const [teams] = await pool.query('SELECT id FROM tournament_teams WHERE tournament_id = ? AND id IN (?, ?)', [tournamentId, a, b]);
    if (teams.length !== 2) return res.status(400).json({ success: false, error: 'Both teams must belong to this tournament' });

    const parsed = matchDetails(body, { isCreate: true });
    if (parsed.error) return res.status(400).json({ success: false, error: parsed.error });
    const v = parsed.values;
    if (v.venue === undefined || v.venue === null) v.venue = t.venue || null;

    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM tournament_fixtures WHERE tournament_id = ?', [tournamentId]);
    const [result] = await pool.query(
      `INSERT INTO tournament_fixtures (tournament_id, stage, group_name, round_number, match_number, team_a_id, team_b_id, match_date, match_time, venue, duration_min, format_label, status)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'SCHEDULED')`,
      [tournamentId, v.stage, v.group_name || null, n + 1, a, b, v.match_date || null, v.match_time || null, v.venue, v.duration_min || null, v.format_label || null]
    );
    await recordAuditLog(pool, tournamentId, req.user.id, 'CREATE_MATCH', 'fixture', result.insertId, null, body);
    notifyTournament(tournamentId);
    fireNotification('tournament.match_scheduled', { fixtureId: result.insertId });
    res.json({ success: true, message: 'Match created', fixture_id: result.insertId });
  } catch (error) {
    console.error('Error creating match:', error);
    res.status(500).json({ success: false, error: 'Failed to create match' });
  }
});

// DELETE /api/tournaments/:id/fixtures/:fixtureId - remove a match that has not started
router.delete('/:id/fixtures/:fixtureId', verifyToken, verifyHost, requirePaidTournament, async (req, res) => {
  try {
    const { id: tournamentId, fixtureId } = req.params;
    if ((await manageableRows(pool, tournamentId, req.tHost, 'id', false)).length === 0) {
      return res.status(403).json({ success: false, error: 'Unauthorized or tournament not found' });
    }
    const [[fx]] = await pool.query('SELECT status FROM tournament_fixtures WHERE id = ? AND tournament_id = ?', [fixtureId, tournamentId]);
    if (!fx) return res.status(404).json({ success: false, error: 'Match not found' });
    if (fx.status !== 'SCHEDULED' && fx.status !== 'POSTPONED') {
      return res.status(409).json({ success: false, error: 'Only a match that has not started can be deleted' });
    }
    await pool.query('UPDATE tournament_fixtures SET next_match_id = NULL, next_match_slot = NULL WHERE next_match_id = ? AND tournament_id = ?', [fixtureId, tournamentId]);
    await pool.query('DELETE FROM tournament_match_events WHERE match_id = ?', [fixtureId]);
    await pool.query('DELETE FROM tournament_streams WHERE match_id = ? AND tournament_id = ?', [fixtureId, tournamentId]);
    await pool.query('DELETE FROM tournament_fixtures WHERE id = ? AND tournament_id = ?', [fixtureId, tournamentId]);
    await recordAuditLog(pool, tournamentId, req.user.id, 'DELETE_MATCH', 'fixture', fixtureId, null, null);
    notifyTournament(tournamentId);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting match:', error);
    res.status(500).json({ success: false, error: 'Failed to delete match' });
  }
});

// PATCH /api/tournaments/:id/fixtures/:fixtureId - Reschedule / Edit fixture details
router.patch('/:id/fixtures/:fixtureId', verifyToken, verifyHost, requirePaidTournament, async (req, res) => {
  try {
    const { id: tournamentId, fixtureId } = req.params;
    const ownerId = req.user.id;
    const { team_a_id, team_b_id, status } = req.body;
    const parsedDetails = matchDetails(req.body, { isCreate: false });
    if (parsedDetails.error) return res.status(400).json({ success: false, error: parsedDetails.error });
    const details = parsedDetails.values;

    const tournaments = await manageableRows(pool, tournamentId, req.tHost, 'owner_id', false);
    if (tournaments.length === 0) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    // Match state (LIVE / PAUSED / FINISHED) belongs to the live-match controls, which keep the clock, winner and
    // bracket consistent. This route may only reschedule or postpone/cancel a match that has not started, and
    // can never swap the teams of a match that is being (or has been) played.
    const [[fx]] = await pool.query('SELECT status FROM tournament_fixtures WHERE id = ? AND tournament_id = ?', [fixtureId, tournamentId]);
    if (!fx) return res.status(404).json({ success: false, error: 'Fixture not found' });
    if (status && !['SCHEDULED', 'POSTPONED', 'CANCELLED'].includes(status)) {
      return res.status(400).json({ success: false, error: 'Use the Live Match Control to start, pause or finish a match' });
    }
    if (['LIVE', 'PAUSED', 'FINISHED'].includes(fx.status) && (status || team_a_id !== undefined || team_b_id !== undefined)) {
      return res.status(409).json({ success: false, error: 'This match has already started - its teams and status can no longer be changed here' });
    }

    const updates = [];
    const params = [];

    for (const [col, val] of Object.entries(details)) { updates.push(col + ' = ?'); params.push(val); }
    if (team_a_id !== undefined) { updates.push('team_a_id = ?'); params.push(team_a_id || null); }
    if (team_b_id !== undefined) { updates.push('team_b_id = ?'); params.push(team_b_id || null); }
    if (status) { updates.push('status = ?'); params.push(status); }

    if (updates.length > 0) {
      params.push(fixtureId, tournamentId);
      await pool.query(`UPDATE tournament_fixtures SET ${updates.join(', ')} WHERE id = ? AND tournament_id = ?`, params);
    }

    await recordAuditLog(pool, tournamentId, ownerId, 'UPDATE_FIXTURE', 'fixture', fixtureId, null, req.body);
    if (details.match_date !== undefined || details.match_time !== undefined) fireNotification('tournament.match_scheduled', { fixtureId });

    res.json({ success: true, message: 'Fixture updated successfully' });
  } catch (error) {
    console.error('Error updating fixture:', error);
    res.status(500).json({ success: false, error: 'Failed to update fixture' });
  }
});

// ----------------------------------------------------
// STANDINGS & LEADERBOARD
// ----------------------------------------------------

// GET /api/tournaments/:id/standings - Real database calculated standings
router.get('/:id/standings', async (req, res) => {
  try {
    const tournamentId = req.params.id;

    // Fetch tournament format and points config
    const [tournaments] = await pool.query('SELECT format_type, points_for_win, points_for_draw, points_for_loss FROM tournaments WHERE id = ?', [tournamentId]);
    if (tournaments.length === 0) {
      return res.status(404).json({ success: false, error: 'Tournament not found' });
    }
    const t = tournaments[0];
    const winPts = t.points_for_win || 3;
    const drawPts = t.points_for_draw || 1;
    const lossPts = t.points_for_loss || 0;

    // Fetch all teams
    const [teams] = await pool.query('SELECT id, name, logo, color, group_name FROM tournament_teams WHERE tournament_id = ?', [tournamentId]);

    // Fetch all finished matches
    const [matches] = await pool.query(
      "SELECT * FROM tournament_fixtures WHERE tournament_id = ? AND status = 'FINISHED'",
      [tournamentId]
    );

    // Initialize map
    const statsMap = {};
    for (const team of teams) {
      statsMap[team.id] = {
        team_id: team.id,
        team_name: team.name,
        logo: team.logo,
        color: team.color,
        group_name: team.group_name || 'Main League',
        played: 0,
        won: 0,
        draw: 0,
        lost: 0,
        goals_for: 0,
        goals_against: 0,
        goal_diff: 0,
        points: 0,
        form: []
      };
    }

    // Process finished matches
    for (const match of matches) {
      const a = statsMap[match.team_a_id];
      const b = statsMap[match.team_b_id];

      if (a) {
        a.played++;
        a.goals_for += match.team_a_score;
        a.goals_against += match.team_b_score;
      }
      if (b) {
        b.played++;
        b.goals_for += match.team_b_score;
        b.goals_against += match.team_a_score;
      }

      if (match.team_a_score > match.team_b_score) {
        if (a) { a.won++; a.points += winPts; a.form.push('W'); }
        if (b) { b.lost++; b.points += lossPts; b.form.push('L'); }
      } else if (match.team_b_score > match.team_a_score) {
        if (b) { b.won++; b.points += winPts; b.form.push('W'); }
        if (a) { a.lost++; a.points += lossPts; a.form.push('L'); }
      } else {
        if (a) { a.draw++; a.points += drawPts; a.form.push('D'); }
        if (b) { b.draw++; b.points += drawPts; b.form.push('D'); }
      }
    }

    const standingsList = Object.values(statsMap).map(item => {
      item.goal_diff = item.goals_for - item.goals_against;
      item.form_string = item.form.slice(-5).join('');
      return item;
    });

    // Sort by Points DESC, Goal Diff DESC, Goals For DESC
    standingsList.sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.goal_diff !== a.goal_diff) return b.goal_diff - a.goal_diff;
      return b.goals_for - a.goals_for;
    });

    // Assign rank
    standingsList.forEach((item, index) => { item.rank = index + 1; });

    // Group if Group Stage
    const standingsByGroup = {};
    for (const item of standingsList) {
      const groupKey = item.group_name;
      if (!standingsByGroup[groupKey]) standingsByGroup[groupKey] = [];
      standingsByGroup[groupKey].push(item);
    }

    res.json({ success: true, standings: standingsList, standingsByGroup });
  } catch (error) {
    console.error('Error calculating standings:', error);
    res.status(500).json({ success: false, error: 'Failed to calculate standings' });
  }
});

// GET /api/tournaments/:id/stats - Real database player statistics & leaderboard
router.get('/:id/stats', async (req, res) => {
  try {
    const tournamentId = req.params.id;

    // Top Scorers / Points
    const [topScorers] = await pool.query(`
      SELECT p.id as participant_id, p.user_id as user_id, COALESCE(p.player_name, u.name) as player_name, COALESCE(p.profile_photo, u.profile_pic) as profile_photo,
             t.name as team_name, SUM(e.value) as total_score, COUNT(DISTINCT e.match_id) as matches_played
      FROM tournament_match_events e
      JOIN tournament_fixtures f ON e.match_id = f.id
      JOIN tournament_participants p ON (e.player_id = p.id OR e.player_id = p.user_id) AND p.tournament_id = f.tournament_id
      LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN tournament_teams t ON p.team_id = t.id
      WHERE f.tournament_id = ? AND e.is_undone = false AND e.event_type IN ('GOAL', 'RUN', 'POINT', '1_POINT', '2_POINTS', '3_POINTS')
      GROUP BY p.id, u.id, u.name, u.profile_pic, t.name
      ORDER BY total_score DESC
      LIMIT 10
    `, [tournamentId]);

    // Top Assists
    const [topAssists] = await pool.query(`
      SELECT p.id as participant_id, p.user_id as user_id, COALESCE(p.player_name, u.name) as player_name, COALESCE(p.profile_photo, u.profile_pic) as profile_photo,
             t.name as team_name, COUNT(e.id) as total_assists
      FROM tournament_match_events e
      JOIN tournament_fixtures f ON e.match_id = f.id
      JOIN tournament_participants p ON (e.player_id = p.id OR e.player_id = p.user_id) AND p.tournament_id = f.tournament_id
      LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN tournament_teams t ON p.team_id = t.id
      WHERE f.tournament_id = ? AND e.is_undone = false AND e.event_type = 'ASSIST'
      GROUP BY p.id, u.id, u.name, u.profile_pic, t.name
      ORDER BY total_assists DESC
      LIMIT 10
    `, [tournamentId]);

    // MVPs / Yellow & Red Cards summary
    const [cardsSummary] = await pool.query(`
      SELECT e.event_type, COUNT(e.id) as count
      FROM tournament_match_events e
      JOIN tournament_fixtures f ON e.match_id = f.id
      WHERE f.tournament_id = ? AND e.is_undone = false AND e.event_type IN ('YELLOW_CARD', 'RED_CARD', 'WICKET', 'FOUL')
      GROUP BY e.event_type
    `, [tournamentId]);

    res.json({
      success: true,
      topScorers,
      topAssists,
      cardsSummary
    });
  } catch (error) {
    console.error('Error fetching tournament stats:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch tournament statistics' });
  }
});

// GET /api/tournaments/:id/results - Auto-generated summary (Champion, Runner-up, top scorer, MVP)
// Phase 13: computed live from real fixtures/events, never fabricated.
router.get('/:id/results', async (req, res) => {
  try {
    const tournamentId = req.params.id;
    const [tournaments] = await pool.query('SELECT id, name, sport, format_type, status FROM tournaments WHERE id = ?', [tournamentId]);
    if (tournaments.length === 0) {
      return res.status(404).json({ success: false, error: 'Tournament not found' });
    }
    const t = tournaments[0];

    let champion = null;
    let runnerUp = null;

    // Champion/runner-up come from the Final fixture when the format has one (Knockout, Group+Knockout).
    const [finals] = await pool.query(`
      SELECT f.winner_id, f.team_a_id, f.team_b_id, ta.name as team_a_name, tb.name as team_b_name, w.name as winner_name
      FROM tournament_fixtures f
      LEFT JOIN tournament_teams ta ON f.team_a_id = ta.id
      LEFT JOIN tournament_teams tb ON f.team_b_id = tb.id
      LEFT JOIN tournament_teams w ON f.winner_id = w.id
      WHERE f.tournament_id = ? AND f.stage = 'Final' AND f.status = 'FINISHED'
      ORDER BY f.id DESC LIMIT 1
    `, [tournamentId]);
    if (finals.length > 0) {
      const fnl = finals[0];
      champion = fnl.winner_name || null;
      if (fnl.winner_id) {
        runnerUp = fnl.winner_id === fnl.team_a_id ? fnl.team_b_name : fnl.team_a_name;
      }
    }

    // Top scorer
    const [topScorerRows] = await pool.query(`
      SELECT COALESCE(p.player_name, u.name) as player_name, t.name as team_name, SUM(e.value) as total_score
      FROM tournament_match_events e
      JOIN tournament_fixtures f ON e.match_id = f.id
      JOIN tournament_participants p ON (e.player_id = p.id OR e.player_id = p.user_id) AND p.tournament_id = f.tournament_id
      LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN tournament_teams t ON p.team_id = t.id
      WHERE f.tournament_id = ? AND e.is_undone = false AND e.event_type IN ('GOAL', 'RUN', 'POINT', '1_POINT', '2_POINTS', '3_POINTS')
      GROUP BY u.id, u.name, t.name
      ORDER BY total_score DESC LIMIT 1
    `, [tournamentId]);

    // Player of the Tournament: most MVP awards, falling back to the top scorer
    const [mvpRows] = await pool.query(`
      SELECT COALESCE(p.player_name, u.name) as player_name, t.name as team_name, COUNT(e.id) as mvp_count
      FROM tournament_match_events e
      JOIN tournament_fixtures f ON e.match_id = f.id
      JOIN tournament_participants p ON (e.player_id = p.id OR e.player_id = p.user_id) AND p.tournament_id = f.tournament_id
      LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN tournament_teams t ON p.team_id = t.id
      WHERE f.tournament_id = ? AND e.is_undone = false AND e.event_type = 'MVP'
      GROUP BY u.id, u.name, t.name
      ORDER BY mvp_count DESC LIMIT 1
    `, [tournamentId]);

    res.json({
      success: true,
      tournament: { id: t.id, name: t.name, sport: t.sport, status: t.status },
      champion,
      runner_up: runnerUp,
      top_scorer: topScorerRows[0] || null,
      player_of_tournament: mvpRows[0] || topScorerRows[0] || null,
      has_final_result: finals.length > 0
    });
  } catch (error) {
    console.error('Error computing tournament results:', error);
    res.status(500).json({ success: false, error: 'Failed to compute tournament results' });
  }
});

// ----------------------------------------------------
// ANNOUNCEMENTS & YOUTUBE LIVE STREAMS
// ----------------------------------------------------

// GET & POST /api/tournaments/:id/announcements
router.get('/:id/announcements', async (req, res) => {
  try {
    const [announcements] = await pool.query(
      'SELECT * FROM tournament_announcements WHERE tournament_id = ? ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json({ success: true, announcements });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch announcements' });
  }
});

router.post('/:id/announcements', verifyToken, verifyHost, requirePaidTournament, async (req, res) => {
  try {
    const tournamentId = req.params.id;
    const { title, content } = req.body || {};
    if (typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ success: false, error: 'Announcement title is required' });
    }
    if (typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ success: false, error: 'Announcement content is required' });
    }

    if ((await manageableRows(pool, tournamentId, req.tHost, 'id')).length === 0) {
      return res.status(403).json({ success: false, error: 'Unauthorized or tournament not found' });
    }

    const [result] = await pool.query(
      'INSERT INTO tournament_announcements (tournament_id, title, content) VALUES (?, ?, ?)',
      [tournamentId, title.trim(), content.trim()]
    );

    fireNotification('tournament.announcement', { announcementId: result.insertId });
    res.json({ success: true, message: 'Announcement published successfully', id: result.insertId });
  } catch (error) {
    console.error('Error publishing announcement:', error);
    res.status(500).json({ success: false, error: 'Failed to publish announcement' });
  }
});

// GET /api/tournaments/:id/streams - Public list of live streams (server-built embed URLs)
router.get('/:id/streams', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, match_id, stream_title, stream_status, youtube_url FROM tournament_streams WHERE tournament_id = ? ORDER BY id DESC', [req.params.id]);
    const streams = rows.map(({ youtube_url, ...s }) => ({ ...s, youtube: youtubePayload(youtube_url) })).filter(s => s.youtube);
    res.json({ success: true, streams });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch streams' });
  }
});

// POST /api/tournaments/:id/streams - Host/admin adds or REPLACES the YouTube link for the whole tournament
// (no match_id) or for one match of it. One link per scope: saving again updates it.
router.post('/:id/streams', verifyToken, verifyHost, requirePaidTournament, async (req, res) => {
  try {
    const tournamentId = req.params.id;
    const { match_id, youtube_url, stream_title, stream_status } = req.body || {};

    if ((await manageableRows(pool, tournamentId, req.tHost, 'id')).length === 0) {
      return res.status(403).json({ success: false, error: 'Unauthorized or tournament not found' });
    }

    const parsed = parseYouTubeUrl(youtube_url);
    if (parsed.error) return res.status(400).json({ success: false, error: parsed.error });

    const status = stream_status === undefined ? 'LIVE' : stream_status;
    if (!['UPCOMING', 'LIVE', 'ENDED'].includes(status)) {
      return res.status(400).json({ success: false, error: 'stream_status must be UPCOMING, LIVE or ENDED' });
    }
    const title = String(stream_title || 'Live Stream').trim().slice(0, 120);

    let matchId = null;
    if (match_id !== undefined && match_id !== null && match_id !== '') {
      matchId = /^\d+$/.test(String(match_id)) ? Number(match_id) : 0;
      // The match must belong to THIS tournament - never let one host change another tournament's fixture
      const [fx] = await pool.query('SELECT id FROM tournament_fixtures WHERE id = ? AND tournament_id = ?', [matchId, tournamentId]);
      if (fx.length === 0) return res.status(400).json({ success: false, error: 'That match does not belong to this tournament' });
    }

    await pool.query(matchId ? 'DELETE FROM tournament_streams WHERE tournament_id = ? AND match_id = ?' : 'DELETE FROM tournament_streams WHERE tournament_id = ? AND match_id IS NULL',
      matchId ? [tournamentId, matchId] : [tournamentId]);
    const [result] = await pool.query(
      'INSERT INTO tournament_streams (tournament_id, match_id, youtube_url, stream_title, stream_status) VALUES (?, ?, ?, ?, ?)',
      [tournamentId, matchId, parsed.watch_url, title, status]
    );
    if (matchId) await pool.query('UPDATE tournament_fixtures SET youtube_url = ? WHERE id = ? AND tournament_id = ?', [parsed.watch_url, matchId, tournamentId]);

    if (matchId) notifyMatch(matchId, tournamentId); else notifyTournament(tournamentId);
    await recordAuditLog(pool, tournamentId, req.user.id, 'SET_YOUTUBE_STREAM', matchId ? 'fixture' : 'tournament', matchId || tournamentId, null, { youtube: parsed.watch_url });
    res.json({ success: true, message: 'YouTube Live link saved', stream_id: result.insertId, youtube: { kind: parsed.kind, id: parsed.id, watch_url: parsed.watch_url, embed_url: parsed.embed_url } });
  } catch (error) {
    console.error('Error saving stream:', error);
    res.status(500).json({ success: false, error: 'Failed to attach stream' });
  }
});

router.delete('/:id/streams/:streamId', verifyToken, verifyHost, requirePaidTournament, async (req, res) => {
  try {
    if ((await manageableRows(pool, req.params.id, req.tHost, 'id')).length === 0) {
      return res.status(403).json({ success: false, error: 'Unauthorized or tournament not found' });
    }
    const [rows] = await pool.query('SELECT match_id FROM tournament_streams WHERE id = ? AND tournament_id = ?', [req.params.streamId, req.params.id]);
    await pool.query('DELETE FROM tournament_streams WHERE id = ? AND tournament_id = ?', [req.params.streamId, req.params.id]);
    if (rows[0] && rows[0].match_id) await pool.query('UPDATE tournament_fixtures SET youtube_url = NULL WHERE id = ? AND tournament_id = ?', [rows[0].match_id, req.params.id]);
    if (rows[0] && rows[0].match_id) notifyMatch(rows[0].match_id, req.params.id); else notifyTournament(req.params.id);
    res.json({ success: true, message: 'Stream removed successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to remove stream' });
  }
});

// ----------------------------------------------------
// SPONSORS (Phase 14)
// ----------------------------------------------------

// GET /api/tournaments/:id/sponsors - Public, shown on the tournament page/scoreboard
router.get('/:id/sponsors', async (req, res) => {
  try {
    const [sponsors] = await pool.query(
      'SELECT * FROM tournament_sponsors WHERE tournament_id = ? ORDER BY FIELD(sponsor_type, "TITLE","GOLD","SILVER","BRONZE","PARTNER"), created_at ASC',
      [req.params.id]
    );
    res.json({ success: true, sponsors });
  } catch (error) {
    console.error('Error fetching sponsors:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch sponsors' });
  }
});

// POST /api/tournaments/:id/sponsors - Organizer adds a sponsor
router.post('/:id/sponsors', verifyToken, verifyHost, requirePaidTournament, async (req, res) => {
  try {
    const tournamentId = req.params.id;
    const ownerId = req.user.id;
    const { name, logo, website_url, sponsor_type, package_amount } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Sponsor name is required' });
    }

    const tournaments = await manageableRows(pool, tournamentId, req.tHost, 'id', false);
    if (tournaments.length === 0) {
      return res.status(403).json({ success: false, error: 'Unauthorized or tournament not found' });
    }

    const validTypes = ['TITLE', 'GOLD', 'SILVER', 'BRONZE', 'PARTNER'];
    const type = validTypes.includes(sponsor_type) ? sponsor_type : 'PARTNER';

    const [result] = await pool.query(`
      INSERT INTO tournament_sponsors (tournament_id, name, logo, website_url, sponsor_type, package_amount)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [tournamentId, name.trim(), logo || null, website_url || null, type, package_amount || null]);

    await recordAuditLog(pool, tournamentId, ownerId, 'ADD_SPONSOR', 'sponsor', result.insertId, null, { name, sponsor_type: type });

    res.json({ success: true, message: 'Sponsor added', sponsor_id: result.insertId });
  } catch (error) {
    console.error('Error adding sponsor:', error);
    res.status(500).json({ success: false, error: 'Failed to add sponsor' });
  }
});

// DELETE /api/tournaments/:id/sponsors/:sponsorId - Organizer removes a sponsor
router.delete('/:id/sponsors/:sponsorId', verifyToken, verifyHost, requirePaidTournament, async (req, res) => {
  try {
    const { id: tournamentId, sponsorId } = req.params;
    const ownerId = req.user.id;

    const tournaments = await manageableRows(pool, tournamentId, req.tHost, 'id', false);
    if (tournaments.length === 0) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    await pool.query('DELETE FROM tournament_sponsors WHERE id = ? AND tournament_id = ?', [sponsorId, tournamentId]);
    res.json({ success: true, message: 'Sponsor removed' });
  } catch (error) {
    console.error('Error removing sponsor:', error);
    res.status(500).json({ success: false, error: 'Failed to remove sponsor' });
  }
});


// ==================================================================================================
// SQUADS — the organizer builds a team's roster player by player.
// A roster member is a tournament_participants row. user_id is optional: most club players have no
// Book Arena account, and requiring one is what blocked this workflow before.
// ==================================================================================================
const BATTING_STYLES = ['RIGHT', 'LEFT', 'UNSPECIFIED'];
const BOWLING_STYLES = [
  'RIGHT_ARM_FAST', 'RIGHT_ARM_MEDIUM', 'RIGHT_ARM_OFF_SPIN', 'RIGHT_ARM_LEG_SPIN',
  'LEFT_ARM_FAST', 'LEFT_ARM_MEDIUM', 'LEFT_ARM_ORTHODOX', 'LEFT_ARM_CHINAMAN', 'UNSPECIFIED',
];

/** Phone numbers are optional, but a stored one must be a real number. Kept as digits only. */
function normalisePhone(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { ok: true, value: null };
  const digits = String(raw).replace(/[^0-9]/g, '');
  if (digits.length < 7 || digits.length > 15) return { ok: false, error: 'Enter a valid phone number, or leave it blank' };
  return { ok: true, value: digits };
}

function readMember(body = {}, sport) {
  const name = String(body.player_name || body.name || '').trim();
  if (!name) return { error: 'Player name is required' };
  if (name.length > 120) return { error: 'Player name must be 120 characters or fewer' };
  const phone = normalisePhone(body.phone);
  if (!phone.ok) return { error: phone.error };
  const cricket = isCricketSport(sport);
  const role = roleForSport(body.player_role, sport);
  const batting = cricket && BATTING_STYLES.includes(body.batting_style) ? body.batting_style : 'UNSPECIFIED';
  const bowling = cricket && body.bowling_style && BOWLING_STYLES.includes(body.bowling_style) ? body.bowling_style : null;
  return {
    value: {
      player_name: name,
      phone: phone.value,
      player_role: role,
      batting_style: batting,
      bowling_style: bowling,
      is_captain: body.is_captain ? 1 : 0,
      is_vice_captain: body.is_vice_captain ? 1 : 0,
      is_substitute: body.is_substitute ? 1 : 0,
      user_id: body.user_id ? parseInt(body.user_id, 10) : null,
      jersey_number: body.jersey_number ? String(body.jersey_number).trim().slice(0, 20) : null,
    },
  };
}

/** The team, but only if this caller may manage its tournament. */
async function teamForHost(db, tournamentId, teamId, host) {
  const t = await findManageableTournament(db, tournamentId, host,
    { columns: 'id, players_per_team, substitute_limit, sport, status' });
  if (!t) return { error: 'Tournament not found or not yours to manage', status: 404 };
  const [[team]] = await db.query('SELECT * FROM tournament_teams WHERE id = ? AND tournament_id = ?', [teamId, tournamentId]);
  if (!team) return { error: 'Team not found in this tournament', status: 404 };
  return { tournament: t, team };
}

// GET /api/tournaments/:id/teams/:teamId/members — the full roster, in batting order
router.get('/:id/teams/:teamId/members', verifyToken, verifyHost, async (req, res) => {
  try {
    const found = await teamForHost(pool, req.params.id, req.params.teamId, req.tHost);
    if (found.error) return res.status(found.status).json({ success: false, error: found.error });
    const [members] = await pool.query(
      `SELECT p.*, COALESCE(p.player_name, u.name) AS display_name, u.name AS account_name, u.email AS account_email
         FROM tournament_participants p
         LEFT JOIN users u ON u.id = p.user_id
        WHERE p.tournament_id = ? AND p.team_id = ?
        ORDER BY p.is_substitute ASC, p.id ASC`,
      [req.params.id, req.params.teamId]);
    res.json({
      success: true,
      team: found.team,
      members,
      limits: {
        players_per_team: found.tournament.players_per_team || null,
        substitute_limit: found.tournament.substitute_limit || null,
      },
    });
  } catch (error) {
    console.error('Error fetching team members:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch the roster' });
  }
});

// POST /api/tournaments/:id/teams/:teamId/members — add one player
router.post('/:id/teams/:teamId/members', verifyToken, verifyHost, requirePaidTournament, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const found = await teamForHost(connection, req.params.id, req.params.teamId, req.tHost);
    if (found.error) { await connection.rollback(); connection.release(); return res.status(found.status).json({ success: false, error: found.error }); }
    const parsed = readMember(req.body, found.tournament.sport);
    if (parsed.error) { await connection.rollback(); connection.release(); return res.status(400).json({ success: false, error: parsed.error }); }
    const m = parsed.value;

    const [existing] = await connection.query(
      'SELECT id, player_name, phone, is_substitute, is_captain, is_vice_captain FROM tournament_participants WHERE tournament_id = ? AND team_id = ? FOR UPDATE',
      [req.params.id, req.params.teamId]);

    // the same person must not be in the team twice
    const sameName = existing.find((p) => String(p.player_name || '').trim().toLowerCase() === m.player_name.toLowerCase());
    if (sameName) { await connection.rollback(); connection.release(); return res.status(400).json({ success: false, error: 'That player is already in this team' }); }
    if (m.phone && existing.some((p) => p.phone === m.phone)) {
      await connection.rollback(); connection.release();
      return res.status(400).json({ success: false, error: 'A player with that phone number is already in this team' });
    }
    if (m.user_id) {
      const [[dupAccount]] = await connection.query(
        'SELECT id FROM tournament_participants WHERE tournament_id = ? AND user_id = ? LIMIT 1', [req.params.id, m.user_id]);
      if (dupAccount) { await connection.rollback(); connection.release(); return res.status(400).json({ success: false, error: 'That Book Arena account is already playing in this tournament' }); }
    }

    // squad size, taken from the tournament's own configuration
    const squadLimit = Number(found.tournament.players_per_team) || null;
    const subLimit = found.tournament.substitute_limit === null || found.tournament.substitute_limit === undefined
      ? null : Number(found.tournament.substitute_limit);
    const mainCount = existing.filter((p) => !p.is_substitute).length;
    const subCount = existing.filter((p) => p.is_substitute).length;
    if (!m.is_substitute && squadLimit && mainCount >= squadLimit) {
      await connection.rollback(); connection.release();
      return res.status(400).json({ success: false, error: `This team already has its ${squadLimit} players. Add the player as a substitute instead.` });
    }
    if (m.is_substitute && subLimit !== null && subCount >= subLimit) {
      await connection.rollback(); connection.release();
      return res.status(400).json({ success: false, error: subLimit === 0 ? 'This tournament does not allow substitutes' : `At most ${subLimit} substitute${subLimit === 1 ? '' : 's'} ${subLimit === 1 ? 'is' : 'are'} allowed` });
    }
    // one captain and one vice-captain per team
    if (m.is_captain && existing.some((p) => p.is_captain)) {
      await connection.query('UPDATE tournament_participants SET is_captain = 0 WHERE tournament_id = ? AND team_id = ?', [req.params.id, req.params.teamId]);
    }
    if (m.is_vice_captain && existing.some((p) => p.is_vice_captain)) {
      await connection.query('UPDATE tournament_participants SET is_vice_captain = 0 WHERE tournament_id = ? AND team_id = ?', [req.params.id, req.params.teamId]);
    }

    const [ins] = await connection.query(
      `INSERT INTO tournament_participants
         (tournament_id, user_id, team_id, player_name, phone, player_role, batting_style, bowling_style,
          is_captain, is_vice_captain, is_substitute, jersey_number, added_by_host, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'APPROVED')`,
      [req.params.id, m.user_id, req.params.teamId, m.player_name, m.phone, m.player_role, m.batting_style,
       m.bowling_style, m.is_captain, m.is_vice_captain, m.is_substitute, m.jersey_number]);

    if (m.is_captain && m.user_id) {
      await connection.query('UPDATE tournament_teams SET captain_id = ? WHERE id = ?', [m.user_id, req.params.teamId]);
    }
    await recordAuditLog(connection, req.params.id, req.user.id, 'ADD_TEAM_MEMBER', 'participant', ins.insertId, null, { team_id: Number(req.params.teamId), name: m.player_name });
    await connection.commit();
    res.json({ success: true, message: `${m.player_name} added to the team`, member_id: ins.insertId });
  } catch (error) {
    await connection.rollback().catch(() => {});
    console.error('Error adding team member:', error);
    res.status(500).json({ success: false, error: 'Failed to add the player' });
  } finally {
    connection.release();
  }
});

// PATCH /api/tournaments/:id/teams/:teamId/members/:memberId — edit one player
router.patch('/:id/teams/:teamId/members/:memberId', verifyToken, verifyHost, requirePaidTournament, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const found = await teamForHost(connection, req.params.id, req.params.teamId, req.tHost);
    if (found.error) { await connection.rollback(); connection.release(); return res.status(found.status).json({ success: false, error: found.error }); }

    const [[member]] = await connection.query(
      'SELECT * FROM tournament_participants WHERE id = ? AND tournament_id = ? AND team_id = ?',
      [req.params.memberId, req.params.id, req.params.teamId]);
    if (!member) { await connection.rollback(); connection.release(); return res.status(404).json({ success: false, error: 'Player not found in this team' }); }

    const parsed = readMember({ ...member, ...req.body }, found.tournament.sport);
    if (parsed.error) { await connection.rollback(); connection.release(); return res.status(400).json({ success: false, error: parsed.error }); }
    const m = parsed.value;

    const [[clash]] = await connection.query(
      'SELECT id FROM tournament_participants WHERE tournament_id = ? AND team_id = ? AND id <> ? AND LOWER(player_name) = LOWER(?) LIMIT 1',
      [req.params.id, req.params.teamId, req.params.memberId, m.player_name]);
    if (clash) { await connection.rollback(); connection.release(); return res.status(400).json({ success: false, error: 'Another player in this team already has that name' }); }

    if (m.is_captain) await connection.query('UPDATE tournament_participants SET is_captain = 0 WHERE tournament_id = ? AND team_id = ? AND id <> ?', [req.params.id, req.params.teamId, req.params.memberId]);
    if (m.is_vice_captain) await connection.query('UPDATE tournament_participants SET is_vice_captain = 0 WHERE tournament_id = ? AND team_id = ? AND id <> ?', [req.params.id, req.params.teamId, req.params.memberId]);

    await connection.query(
      `UPDATE tournament_participants SET player_name = ?, phone = ?, player_role = ?, batting_style = ?,
              bowling_style = ?, is_captain = ?, is_vice_captain = ?, is_substitute = ?, jersey_number = ?
        WHERE id = ?`,
      [m.player_name, m.phone, m.player_role, m.batting_style, m.bowling_style, m.is_captain, m.is_vice_captain,
       m.is_substitute, m.jersey_number, req.params.memberId]);
    await recordAuditLog(connection, req.params.id, req.user.id, 'EDIT_TEAM_MEMBER', 'participant', Number(req.params.memberId), member, m);
    await connection.commit();
    res.json({ success: true, message: 'Player updated' });
  } catch (error) {
    await connection.rollback().catch(() => {});
    console.error('Error editing team member:', error);
    res.status(500).json({ success: false, error: 'Failed to update the player' });
  } finally {
    connection.release();
  }
});

// DELETE /api/tournaments/:id/teams/:teamId/members/:memberId — remove a player
router.delete('/:id/teams/:teamId/members/:memberId', verifyToken, verifyHost, requirePaidTournament, async (req, res) => {
  try {
    const found = await teamForHost(pool, req.params.id, req.params.teamId, req.tHost);
    if (found.error) return res.status(found.status).json({ success: false, error: found.error });

    // A player who has already batted or bowled stays: removing him would silently rewrite a scorecard.
    const [[played]] = await pool.query(
      `SELECT COUNT(*) AS n FROM tournament_match_events e
         JOIN tournament_fixtures f ON f.id = e.match_id
        WHERE f.tournament_id = ? AND e.is_undone = false
          AND (e.player_id = ? OR JSON_EXTRACT(e.metadata, '$.bowler_id') = ?)`,
      [req.params.id, req.params.memberId, Number(req.params.memberId)]).catch(() => [[{ n: 0 }]]);
    if (played && Number(played.n) > 0) {
      return res.status(409).json({ success: false, error: 'This player already appears in a match scorecard and cannot be removed. Edit their details instead.' });
    }

    const [result] = await pool.query(
      'DELETE FROM tournament_participants WHERE id = ? AND tournament_id = ? AND team_id = ?',
      [req.params.memberId, req.params.id, req.params.teamId]);
    if (!result.affectedRows) return res.status(404).json({ success: false, error: 'Player not found in this team' });
    await recordAuditLog(pool, req.params.id, req.user.id, 'REMOVE_TEAM_MEMBER', 'participant', Number(req.params.memberId));
    res.json({ success: true, message: 'Player removed' });
  } catch (error) {
    console.error('Error removing team member:', error);
    res.status(500).json({ success: false, error: 'Failed to remove the player' });
  }
});

// GET /api/tournaments/:id/squads — every team with its roster, for the scoring screen and the public page
router.get('/:id/squads', async (req, res) => {
  try {
    const [teams] = await pool.query('SELECT id, name, logo, color, group_name FROM tournament_teams WHERE tournament_id = ? ORDER BY id', [req.params.id]);
    const [members] = await pool.query(
      `SELECT p.id, p.team_id, p.user_id, COALESCE(p.player_name, u.name) AS name, p.player_role,
              p.batting_style, p.bowling_style, p.is_captain, p.is_vice_captain, p.is_substitute, p.jersey_number
         FROM tournament_participants p
         LEFT JOIN users u ON u.id = p.user_id
        WHERE p.tournament_id = ? AND p.status = 'APPROVED' AND p.team_id IS NOT NULL
        ORDER BY p.is_substitute ASC, p.id ASC`, [req.params.id]);
    // deliberately no phone numbers here: this endpoint is public
    const byTeam = new Map(teams.map((t) => [t.id, { ...t, players: [] }]));
    for (const m of members) if (byTeam.has(m.team_id)) byTeam.get(m.team_id).players.push(m);
    res.json({ success: true, teams: [...byTeam.values()] });
  } catch (error) {
    console.error('Error fetching squads:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch squads' });
  }
});

module.exports = router;
