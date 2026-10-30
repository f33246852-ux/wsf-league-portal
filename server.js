const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = __dirname;
try {
  for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
  }
} catch {}
const port = Number(process.env.PORT || 3000);
const baseUrl = process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;
const secret = process.env.SESSION_SECRET || 'development-only-change-me';
const sessions = new Map();
const claimsFile = process.env.CLAIMS_FILE ? path.resolve(process.env.CLAIMS_FILE) : path.join(root, '.private', 'claim-tickets.json');
const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY || '';
const persistentClaimsRequired = process.env.REQUIRE_PERSISTENT_CLAIMS === 'true';
const inviteCode = process.env.DISCORD_INVITE_CODE || 'jVqnac4MjS';
let publicInviteCache = { value:null, expires:0 };
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png' };

function send(res, status, data, type='application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type':type, 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'strict-origin-when-cross-origin' });
  res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
}
function signed(value) { return crypto.createHmac('sha256', secret).update(value).digest('hex'); }
function getUser(req) {
  const token = (req.headers.cookie || '').match(/(?:^|; )vrfs_session=([^;]+)/)?.[1];
  if (!token) return null;
  const [id, mac] = decodeURIComponent(token).split('.');
  if (!id || !mac || Buffer.byteLength(mac) !== 64 || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(signed(id)))) return null;
  const session = sessions.get(id);
  if (!session || session.expires < Date.now()) { sessions.delete(id); return null; }
  return session.user;
}
function setSession(res, user) {
  const id = crypto.randomBytes(24).toString('hex');
  sessions.set(id, { user, expires:Date.now() + 7*24*60*60*1000 });
  res.setHeader('Set-Cookie', [`vrfs_session=${encodeURIComponent(`${id}.${signed(id)}`)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${baseUrl.startsWith('https:')?'; Secure':''}`, `vrfs_oauth_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${baseUrl.startsWith('https:')?'; Secure':''}`]);
}
function clearSession(req, res) {
  const token = (req.headers.cookie || '').match(/(?:^|; )vrfs_session=([^;]+)/)?.[1];
  if (token) { const [id] = decodeURIComponent(token).split('.'); sessions.delete(id); }
  res.setHeader('Set-Cookie', 'vrfs_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}
const ready = () => Boolean(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET && process.env.SESSION_SECRET && process.env.SESSION_SECRET !== 'development-only-change-me');
const ownerDiscordId = () => /^\d{17,20}$/.test(process.env.WSF_OWNER_DISCORD_ID || '') ? process.env.WSF_OWNER_DISCORD_ID : '';
async function supabaseRequest(table, query = '', options = {}) {
  if (!supabaseUrl || !supabaseSecretKey) throw new Error('Ticket storage is not connected.');
  const response = await fetch(`${supabaseUrl}/rest/v1/${table}${query ? `?${query}` : ''}`, {
    method:options.method || 'GET',
    headers:{ apikey:supabaseSecretKey, Authorization:`Bearer ${supabaseSecretKey}`, 'Content-Type':'application/json', Prefer:options.prefer || 'return=representation', ...(options.headers || {}) },
    ...(options.body === undefined ? {} : { body:JSON.stringify(options.body) })
  });
  const text = await response.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) throw new Error(data?.message || `Ticket storage returned ${response.status}.`);
  return data;
}
async function accessFor(user) {
  if (!user) return 'none';
  if (ownerDiscordId() && user.id === ownerDiscordId()) return 'owner';
  try {
    const rows = await supabaseRequest('staff_access', `discord_id=eq.${encodeURIComponent(user.id)}&select=discord_id&limit=1`);
    return rows?.length ? 'staff' : 'member';
  } catch { return 'member'; }
}
async function readJson(req, maxBytes = 12000) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > maxBytes) throw Object.assign(new Error('The request is too large.'), { status:413 }); }
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error('Please check the information and try again.'), { status:400 }); }
}
function normalizeDiscordMessageLink(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (parsed.protocol !== 'https:' || !['discord.com','www.discord.com','discordapp.com','www.discordapp.com'].includes(parsed.hostname.toLowerCase())) return null;
    const match = parsed.pathname.match(/^\/channels\/(\d{17,20}|@me)\/(\d{17,20})\/(\d{17,20})\/?$/);
    if (!match) return null;
    return `https://discord.com/channels/${match[1]}/${match[2]}/${match[3]}`;
  } catch { return null; }
}
async function requireAccess(req, res, allowed = ['staff','owner']) {
  const user = getUser(req);
  if (!user) { send(res, 401, { error:'Sign in with Discord first.' }); return null; }
  const access = await accessFor(user);
  if (!allowed.includes(access)) { send(res, 403, { error:'This page is only for authorized WSF staff.' }); return null; }
  return { user, access };
}

const majorxDataUrl = 'https://majorx.app/xr/api/data';
const wsfRefreshMs = 24 * 60 * 60 * 1000;
let wsfLeagueCache = { value:null, expires:0, refreshing:null };
async function readMajorxTable(table, schema, query) {
  const endpoint = new URL(majorxDataUrl);
  endpoint.searchParams.set('t', table);
  endpoint.searchParams.set('s', schema || 'public');
  endpoint.searchParams.set('q', query);
  const response = await fetch(endpoint, { headers:{ Accept:'application/json' } });
  if (!response.ok) throw new Error(`MajorX ${table} lookup failed (${response.status})`);
  return response.json();
}
async function refreshWsfLeague(force = false) {
  if (wsfLeagueCache.refreshing) return wsfLeagueCache.refreshing;
  if (!force && wsfLeagueCache.value && wsfLeagueCache.expires > Date.now()) return wsfLeagueCache.value;
  wsfLeagueCache.refreshing = (async () => {
    const competitionFilter = 'or=(competition.ilike.*WSF*,competition.ilike.*UCL*)';
    const [standings, teams, completed, scheduled] = await Promise.all([
      readMajorxTable('comp_standings', 'public', `select=competition,team_id,played,wins,draws,losses,goal_diff,points,position&${competitionFilter}&order=competition.asc,position.asc&limit=500`),
      readMajorxTable('teams', 'transfers', 'select=team_id,team_name,league_key&league_key=eq.wsf&limit=500'),
      readMajorxTable('comp_fixtures', 'public', `select=id,competition,gameweek,home_team_id,away_team_id,home_score,away_score,status,played_at,season&${competitionFilter}&status=eq.completed&order=played_at.desc.nullslast&limit=300`),
      readMajorxTable('comp_fixtures', 'public', `select=id,competition,gameweek,home_team_id,away_team_id,home_score,away_score,status,played_at,season&${competitionFilter}&status=eq.scheduled&order=gameweek.asc&limit=100`)
    ]);
    const names = new Map(teams.map(team => [String(team.team_id), String(team.team_name || '')]));
    const wsfStandings = standings.filter(row => {
      const competition = String(row.competition || '').toUpperCase();
      return names.has(String(row.team_id)) && (competition.includes('WSF') || competition.includes('UCL'));
    });
    const wsfCompetitions = new Set(wsfStandings.map(row => row.competition));
    const wsfCompleted = completed.filter(match => wsfCompetitions.has(match.competition));
    const wsfScheduled = scheduled.filter(match => wsfCompetitions.has(match.competition));
    const cleanName = id => (names.get(String(id)) || 'WSF club').replace(/^(MLS|MLSN)\s*\|\s*/i, '');
    const mapFixture = match => ({
      id:match.id, competition:match.competition, gameweek:match.gameweek,
      homeTeam:cleanName(match.home_team_id), awayTeam:cleanName(match.away_team_id),
      homeScore:match.home_score, awayScore:match.away_score,
      playedAt:match.played_at || null, status:match.status
    });
    const goalsByTeam = new Map();
    wsfCompleted.forEach(match => {
      const home = String(match.home_team_id), away = String(match.away_team_id);
      const homeStats = goalsByTeam.get(home) || { for:0, against:0 };
      const awayStats = goalsByTeam.get(away) || { for:0, against:0 };
      homeStats.for += Number(match.home_score || 0); homeStats.against += Number(match.away_score || 0);
      awayStats.for += Number(match.away_score || 0); awayStats.against += Number(match.home_score || 0);
      goalsByTeam.set(home, homeStats); goalsByTeam.set(away, awayStats);
    });
    const teamStats = standings.map(row => ({
      team:cleanName(row.team_id), goalsFor:(goalsByTeam.get(String(row.team_id)) || { for:0 }).for,
      goalsAgainst:(goalsByTeam.get(String(row.team_id)) || { against:0 }).against, wins:Number(row.wins || 0)
    }));
    const best = (key, low = false) => teamStats.slice().sort((a,b) => low ? a[key]-b[key] : b[key]-a[key])[0] || null;
    const value = {
      standings:wsfStandings.map(row => ({
        competition:row.competition, team:cleanName(row.team_id), played:row.played,
        wins:row.wins, draws:row.draws, losses:row.losses, goalDiff:row.goal_diff,
        points:row.points, position:row.position
      })),
      results:wsfCompleted.slice(0, 18).map(mapFixture),
      upcoming:wsfScheduled.slice(0, 30).map(mapFixture),
      teamStats:{ topAttack:best('goalsFor'), bestDefence:best('goalsAgainst',true), mostWins:best('wins') },
      checkedAt:new Date().toISOString(), source:'MajorX XR'
    };
    wsfLeagueCache = { value, expires:Date.now()+wsfRefreshMs, refreshing:null };
    return value;
  })().catch(error => {
    wsfLeagueCache.refreshing = null;
    if (wsfLeagueCache.value) return wsfLeagueCache.value;
    throw error;
  });
  return wsfLeagueCache.refreshing;
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, baseUrl);
  if (req.method === 'GET' && url.pathname === '/api/wsf-league') {
    return send(res, 503, { error:'Automatic MajorX updates require authorized XR-Board API access.', source:'MajorX XR' });
  }
  if (req.method === 'GET' && url.pathname === '/api/config') return send(res, 200, { discordReady:ready(), ownerConfigured:Boolean(ownerDiscordId()), liveReady:Boolean(process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_GUILD_ID), guildId:process.env.DISCORD_GUILD_ID || null });
  if (req.method === 'GET' && url.pathname === '/api/public-server') {
    if (publicInviteCache.value && publicInviteCache.expires > Date.now()) return send(res, 200, publicInviteCache.value);
    try {
      const response = await fetch(`https://discord.com/api/v10/invites/${encodeURIComponent(inviteCode)}?with_counts=true`);
      if (!response.ok) throw new Error('Discord invite lookup failed');
      const invite = await response.json();
      const profile = invite.profile || {};
      const data = { inviteCode, guildId:invite.guild_id || invite.guild?.id || null, name:profile.name || invite.guild?.name || 'WSF Discord', description:profile.description || invite.guild?.description || '', memberCount:invite.approximate_member_count ?? profile.member_count ?? null, onlineCount:invite.approximate_presence_count ?? profile.online_count ?? null, icon:invite.guild?.icon ? `https://cdn.discordapp.com/icons/${invite.guild.id}/${invite.guild.icon}.png?size=128` : null, checkedAt:new Date().toISOString() };
      publicInviteCache = { value:data, expires:Date.now()+60_000 };
      return send(res, 200, data);
    } catch { return send(res, 502, { error:'Discord public server counts are temporarily unavailable.' }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/me') { const user = getUser(req); return send(res, 200, { user, access:await accessFor(user) }); }
  if (req.method === 'GET' && url.pathname === '/auth/discord') {
    if (!ready()) return send(res, 503, { error:'Discord sign-in is not configured yet. Add the credentials from .env.example.' });
    const state = crypto.randomBytes(24).toString('hex');
    res.setHeader('Set-Cookie', `vrfs_oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${baseUrl.startsWith('https:')?'; Secure':''}`);
    const auth = new URL('https://discord.com/oauth2/authorize');
    auth.search = new URLSearchParams({ client_id:process.env.DISCORD_CLIENT_ID, redirect_uri:`${baseUrl}/auth/callback`, response_type:'code', scope:'identify guilds', state }).toString();
    res.writeHead(302, { Location:auth.toString() }); return res.end();
  }
  if (req.method === 'GET' && url.pathname === '/auth/callback') {
    const expected = (req.headers.cookie || '').match(/(?:^|; )vrfs_oauth_state=([^;]+)/)?.[1];
    if (!expected || expected !== url.searchParams.get('state') || !url.searchParams.get('code')) return send(res, 400, { error:'Discord sign-in could not be verified. Please try again.' });
    try {
      const form = new URLSearchParams({ client_id:process.env.DISCORD_CLIENT_ID, client_secret:process.env.DISCORD_CLIENT_SECRET, grant_type:'authorization_code', code:url.searchParams.get('code'), redirect_uri:`${baseUrl}/auth/callback` });
      const tokenRes = await fetch('https://discord.com/api/oauth2/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:form });
      const token = await tokenRes.json(); if (!token.access_token) throw new Error('Token exchange failed');
      const meRes = await fetch('https://discord.com/api/users/@me', { headers:{ Authorization:`Bearer ${token.access_token}` } });
      const me = await meRes.json(); if (!me.id) throw new Error('Profile lookup failed');
      const guildRes = await fetch('https://discord.com/api/users/@me/guilds', { headers:{ Authorization:`Bearer ${token.access_token}` } });
      const guilds = guildRes.ok ? await guildRes.json() : [];
      const inGuild = process.env.DISCORD_GUILD_ID ? guilds.some(g => g.id === process.env.DISCORD_GUILD_ID) : null;
      setSession(res, { id:me.id, username:me.username, globalName:me.global_name || me.username, avatar:me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=128` : null, inGuild });
      res.writeHead(302, { Location:'/' }); return res.end();
    } catch { return send(res, 502, { error:'Discord sign-in failed. Please return and try again.' }); }
  }
  if (req.method === 'POST' && url.pathname === '/auth/logout') { clearSession(req,res); return send(res, 200, { ok:true }); }
  if (req.method === 'POST' && url.pathname === '/api/support') {
    const user = getUser(req);
    if (!user) return send(res, 401, { error:'Sign in with Discord before sending a support question.' });
    try {
      const form = await readJson(req, 8000);
      if (typeof form.subject !== 'string' || form.subject.trim().length < 3 || form.subject.length > 120 || typeof form.category !== 'string' || !['Account','League question','Technical issue','Other'].includes(form.category) || typeof form.message !== 'string' || form.message.trim().length < 10 || form.message.length > 3000) return send(res, 400, { error:'Add a short subject and a message of at least 10 characters.' });
      const saved = { id:crypto.randomUUID(), created_at:new Date().toISOString(), updated_at:new Date().toISOString(), discord_id:user.id, discord_username:user.username, subject:form.subject.trim(), category:form.category, message:form.message.trim(), status:'open', staff_reply:'' };
      await supabaseRequest('support_tickets', '', { method:'POST', body:saved, prefer:'return=minimal' });
      return send(res, 201, { ok:true, message:'Your question is in the WSF staff inbox.' });
    } catch (error) { return send(res, error.status || 503, { error:error.status ? error.message : 'Support tickets are not ready yet. Please try again later.' }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/my/support') {
    const user = getUser(req); if (!user) return send(res, 401, { error:'Sign in to view your questions.' });
    try { return send(res, 200, { tickets:await supabaseRequest('support_tickets', `discord_id=eq.${encodeURIComponent(user.id)}&select=id,created_at,subject,category,status,staff_reply&order=created_at.desc&limit=30`) }); }
    catch { return send(res, 503, { error:'Your support history is not available yet.' }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/my/claims') {
    const user = getUser(req); if (!user) return send(res, 401, { error:'Sign in to view your claims.' });
    try { return send(res, 200, { tickets:await supabaseRequest('claim_tickets', `discord_id=eq.${encodeURIComponent(user.id)}&select=id,submitted_at,item,status&order=submitted_at.desc&limit=30`) }); }
    catch { return send(res, 503, { error:'Your claim history is not available yet.' }); }
  }
  if (url.pathname === '/api/staff/access' && req.method === 'GET') {
    const auth = await requireAccess(req, res, ['owner']); if (!auth) return;
    try { return send(res, 200, { staff:await supabaseRequest('staff_access', 'select=discord_id,discord_username,created_at,added_by&order=created_at.desc') }); }
    catch { return send(res, 503, { error:'Staff access storage is not ready. Apply the WSF ticket database update first.' }); }
  }
  if (url.pathname === '/api/staff/access' && req.method === 'POST') {
    const auth = await requireAccess(req, res, ['owner']); if (!auth) return;
    try {
      const body = await readJson(req, 3000); const id = String(body.discordId || '').trim(); const username = String(body.username || '').trim().slice(0,80);
      if (!/^\d{17,20}$/.test(id) || !username) return send(res, 400, { error:'Enter their Discord User ID (the long number) and username.' });
      if (id === auth.user.id) return send(res, 400, { error:'You are already the owner.' });
      const entry = { discord_id:id, discord_username:username, added_by:auth.user.id, created_at:new Date().toISOString() };
      await supabaseRequest('staff_access', '', { method:'POST', body:entry, prefer:'resolution=merge-duplicates,return=minimal' });
      return send(res, 201, { ok:true });
    } catch { return send(res, 503, { error:'Could not save staff access. Make sure the database update has been applied.' }); }
  }
  if (url.pathname === '/api/staff/access' && req.method === 'DELETE') {
    const auth = await requireAccess(req, res, ['owner']); if (!auth) return;
    const id = url.searchParams.get('discordId') || '';
    if (!/^\d{17,20}$/.test(id) || id === auth.user.id) return send(res, 400, { error:'That staff account cannot be removed.' });
    try { await supabaseRequest('staff_access', `discord_id=eq.${encodeURIComponent(id)}`, { method:'DELETE', prefer:'return=minimal' }); return send(res, 200, { ok:true }); }
    catch { return send(res, 503, { error:'Could not update the staff list.' }); }
  }
  if (url.pathname === '/api/staff/tickets' && req.method === 'GET') {
    const auth = await requireAccess(req, res); if (!auth) return;
    const isSupport = url.searchParams.get('kind') === 'support';
    const kind = isSupport ? 'support_tickets' : 'claim_tickets';
    const ordering = isSupport ? 'created_at.desc.nullslast' : 'submitted_at.desc.nullslast';
    try { return send(res, 200, { tickets:await supabaseRequest(kind, `select=*&order=${ordering}&limit=200`) }); }
    catch { return send(res, 503, { error:'Ticket storage is not ready. Apply the WSF ticket database update first.' }); }
  }
  if (url.pathname.startsWith('/api/staff/tickets/') && req.method === 'PATCH') {
    const auth = await requireAccess(req, res); if (!auth) return;
    const pathParts = url.pathname.split('/'); const kind = pathParts[4], id = pathParts[5];
    if (!['claims','support'].includes(kind) || !/^[0-9a-f-]{36}$/i.test(id || '')) return send(res, 404, { error:'Ticket not found.' });
    try {
      const body = await readJson(req, 5000); const table = kind === 'claims' ? 'claim_tickets' : 'support_tickets';
      const allowed = kind === 'claims' ? ['pending','in_review','approved','rejected'] : ['open','in_progress','closed'];
      if (!allowed.includes(body.status) || (body.staffNote !== undefined && (typeof body.staffNote !== 'string' || body.staffNote.length > 2000)) || (body.reply !== undefined && (typeof body.reply !== 'string' || body.reply.length > 2000))) return send(res, 400, { error:'Choose a valid status and keep your note under 2,000 characters.' });
      const update = { status:body.status, updated_at:new Date().toISOString() };
      if (kind === 'claims') { update.staff_note = String(body.staffNote || '').trim(); update.reviewed_at = new Date().toISOString(); update.reviewed_by = auth.user.id; }
      else update.staff_reply = String(body.reply || '').trim();
      const rows = await supabaseRequest(table, `id=eq.${encodeURIComponent(id)}`, { method:'PATCH', body:update });
      if (!rows?.length) return send(res, 404, { error:'Ticket not found.' });
      return send(res, 200, { ok:true });
    } catch { return send(res, 503, { error:'Could not update this ticket. The database may need the WSF update applied.' }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/claims') {
    const user = getUser(req);
    if (!user) return send(res, 401, { error:'Sign in with Discord before submitting a claim.' });
    let raw = '';
    try {
      for await (const chunk of req) { raw += chunk; if (raw.length > 12000) return send(res, 413, { error:'The claim is too long.' }); }
      const claim = JSON.parse(raw);
      const fields = ['item','messageLink','playerId','winLocation'];
      if (fields.some(key => typeof claim[key] !== 'string' || !claim[key].trim())) return send(res, 400, { error:'Please complete every required field.' });
      if (!['Inside WSF','Outside WSF'].includes(claim.winLocation)) return send(res, 400, { error:'Choose where you won the event.' });
      const messageLink = normalizeDiscordMessageLink(claim.messageLink);
      if (!messageLink) return send(res, 400, { error:'Paste the full Discord message link, including its server, channel, and message number.' });
      const saved = { id:crypto.randomUUID(), submitted_at:new Date().toISOString(), discord_id:user.id, discord_username:user.username, item:claim.item.trim().slice(0,120), message_link:messageLink, player_id:claim.playerId.trim().slice(0,40), submitted_username:user.username, win_location:claim.winLocation, message:typeof claim.message === 'string' ? claim.message.trim().slice(0,1000) : '', status:'pending' };
      if (supabaseUrl && supabaseSecretKey) {
        let response;
        try { response = await fetch(`${supabaseUrl}/rest/v1/claim_tickets`, { method:'POST', headers:{ apikey:supabaseSecretKey, 'Content-Type':'application/json', Prefer:'return=minimal' }, body:JSON.stringify(saved) }); }
        catch { return send(res, 503, { error:'Claim storage is temporarily unreachable. Please try again later.' }); }
        if (!response.ok) {
          return send(res, 503, { error:'Claim storage is not ready. Please try again later.' });
        }
        return send(res, 201, { ok:true, message:'Your claim was sent to the WSF team.' });
      }
      if (persistentClaimsRequired) return send(res, 503, { error:'Claim storage is not connected yet. Please try again later.' });
      await fs.promises.mkdir(path.dirname(claimsFile), { recursive:true });
      let claims = [];
      try { claims = JSON.parse(await fs.promises.readFile(claimsFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      Object.assign(saved, { submittedAt:saved.submitted_at, discordId:saved.discord_id, messageLink:saved.message_link, playerId:saved.player_id, submittedUsername:saved.submitted_username, winLocation:saved.win_location });
      claims.push(saved);
      await fs.promises.writeFile(claimsFile, JSON.stringify(claims, null, 2), { mode:0o600 });
      return send(res, 201, { ok:true, message:'Your claim was sent to the WSF team.' });
    } catch { return send(res, 400, { error:'We could not read that claim. Check the fields and try again.' }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/guild') {
    const user = getUser(req);
    if (!user) return send(res, 401, { error:'Sign in with Discord to view league information.' });
    if (user.inGuild === false) return send(res, 403, { error:'Join the VRFS Discord server to view league information.' });
    if (!process.env.DISCORD_BOT_TOKEN || !process.env.DISCORD_GUILD_ID) return send(res, 503, { error:'Live server data is not configured yet.' });
    try {
      const headers = { Authorization:`Bot ${process.env.DISCORD_BOT_TOKEN}` };
      const [guildR, membersR, channelsR] = await Promise.all([
        fetch(`https://discord.com/api/guilds/${process.env.DISCORD_GUILD_ID}?with_counts=true`, {headers}),
        fetch(`https://discord.com/api/guilds/${process.env.DISCORD_GUILD_ID}/members?limit=1000`, {headers}),
        fetch(`https://discord.com/api/guilds/${process.env.DISCORD_GUILD_ID}/channels`, {headers})
      ]);
      if (!guildR.ok || !membersR.ok || !channelsR.ok) throw new Error('Guild lookup failed');
      const [guild,members,channels] = await Promise.all([guildR.json(),membersR.json(),channelsR.json()]);
      return send(res, 200, { guild:{name:guild.name, memberCount:guild.approximate_member_count, onlineCount:guild.approximate_presence_count, icon:guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=128` : null}, members:members.map(m=>({id:m.user.id,username:m.user.global_name||m.user.username,avatar:m.user.avatar?`https://cdn.discordapp.com/avatars/${m.user.id}/${m.user.avatar}.png?size=64`:null,roles:m.roles})), channels:channels.filter(c=>c.type===0).map(c=>({id:c.id,name:c.name,categoryId:c.parent_id,position:c.position})).sort((a,b)=>a.position-b.position) });
    } catch { return send(res, 502, { error:'Could not load live Discord server data.' }); }
  }
  if (req.method === 'GET') {
    const requested = path.normalize(decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)).replace(/^([/\\]*\.\.[/\\])+/, '');
    if (requested.split(/[\\/]/).includes('.private')) return send(res, 404, 'Not found', 'text/plain');
    const file = path.join(root, requested);
    if (!file.startsWith(root)) return send(res, 403, 'Forbidden', 'text/plain');
    fs.readFile(file, (err, body) => err ? send(res,404,'Not found','text/plain') : send(res,200,body,mime[path.extname(file)] || 'application/octet-stream'));
    return;
  }
  send(res,405,{error:'Method not allowed'});
});
server.listen(port, process.env.RENDER_EXTERNAL_URL ? '0.0.0.0' : '127.0.0.1', () => {
  console.log(`VRFS League Hub running at ${baseUrl}`);
});
