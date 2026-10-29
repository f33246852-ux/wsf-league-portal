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
  if (req.method === 'GET' && url.pathname === '/api/config') return send(res, 200, { discordReady:ready(), liveReady:Boolean(process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_GUILD_ID), guildId:process.env.DISCORD_GUILD_ID || null });
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
  if (req.method === 'GET' && url.pathname === '/api/me') return send(res, 200, { user:getUser(req) });
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
  if (req.method === 'POST' && url.pathname === '/api/claims') {
    const user = getUser(req);
    if (!user) return send(res, 401, { error:'Sign in with Discord before submitting a claim.' });
    let raw = '';
    try {
      for await (const chunk of req) { raw += chunk; if (raw.length > 12000) return send(res, 413, { error:'The claim is too long.' }); }
      const claim = JSON.parse(raw);
      const fields = ['item','messageLink','playerId','discordUsername','winLocation'];
      if (fields.some(key => typeof claim[key] !== 'string' || !claim[key].trim())) return send(res, 400, { error:'Please complete every required field.' });
      if (!['Inside WSF','Outside WSF'].includes(claim.winLocation)) return send(res, 400, { error:'Choose where you won the event.' });
      if (!/^https:\/\/(discord\.com|discordapp\.com)\/channels\//i.test(claim.messageLink.trim())) return send(res, 400, { error:'Paste a valid Discord message link.' });
      const saved = { id:crypto.randomUUID(), submitted_at:new Date().toISOString(), discord_id:user.id, discord_username:user.username, item:claim.item.trim().slice(0,120), message_link:claim.messageLink.trim().slice(0,500), player_id:claim.playerId.trim().slice(0,40), submitted_username:claim.discordUsername.trim().slice(0,80), win_location:claim.winLocation, message:typeof claim.message === 'string' ? claim.message.trim().slice(0,1000) : '', status:'pending' };
      if (supabaseUrl && supabaseSecretKey) {
        let response;
        try { response = await fetch(`${supabaseUrl}/rest/v1/claim_tickets`, { method:'POST', headers:{ apikey:supabaseSecretKey, 'Content-Type':'application/json', Prefer:'return=minimal' }, body:JSON.stringify(saved) }); }
        catch { return send(res, 503, { error:'Claim storage is temporarily unreachable. Please try again later.' }); }
        if (response.status === 409) return send(res, 409, { error:'That event message link has already been used for a claim.' });
        if (!response.ok) {
          let detail = ''; try { detail = (await response.json()).code || ''; } catch {}
          if (detail === '23505') return send(res, 409, { error:'That event message link has already been used for a claim.' });
          return send(res, 503, { error:'Claim storage is not ready. Please try again later.' });
        }
        return send(res, 201, { ok:true, message:'Your claim was sent to the WSF team.' });
      }
      if (persistentClaimsRequired) return send(res, 503, { error:'Claim storage is not connected yet. Please try again later.' });
      await fs.promises.mkdir(path.dirname(claimsFile), { recursive:true });
      let claims = [];
      try { claims = JSON.parse(await fs.promises.readFile(claimsFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (claims.some(ticket => ticket.messageLink === claim.messageLink.trim())) return send(res, 409, { error:'That event message link has already been used for a claim.' });
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
server.listen(port, '0.0.0.0', () => {
  console.log(`VRFS League Hub running at ${baseUrl}`);
});
