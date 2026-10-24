import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import crypto from 'node:crypto';
import 'dotenv/config';
import { attachTwitch, admin, status as twitchStatus } from './twitch.js';

const app = express();
const server = createServer(app);
const io = new Server(server);
app.use(express.static('public'));
app.use(express.json());
const OPTIONS = ['dragon', 'treasure', 'heal'];
const FACTIONS = ['chaos', 'hero'];
const POWER_MAX = 100;
const POWER_PER_ACTION = 12;
const POWER_COOLDOWN_MS = 12000;
const POWER_TRIGGER_COOLDOWN_MS = 8000;
const power = { chaos: 0, hero: 0 };
const powerActions = { chaos: 0, hero: 0 };
const powerLastContribution = new Map();
const powerTriggersAt = { chaos: 0, hero: 0 };
const eventHistory = [];
const MAX_HISTORY = 16;
let powerEnabled = true;
let powerLastEvent = null;
const factionMembers = new Map(); // Twitch viewer ID -> faction
const factionScores = { chaos: 0, hero: 0 };
const factionCommands = { chaos: { dragon: 'dragon', trap: 'trap' }, hero: { heal: 'heal', shield: 'shield' } };
const factionVotes = new Map();
const FACTION_ROUND_MS = 20000;
let factionEndsAt = 0;
let factionRound = 0;
let factionLastEvent = null;
const factionCooldownUntil = new Map();
const VOTE_MS = 20000;
const COOLDOWN_MS = 12000;
const votes = new Map();
let round = 0;
let endsAt = 0;
let cooldownUntil = 0;
let lastEvent = null;

function state() {
  const counts = Object.fromEntries(OPTIONS.map(x => [x, 0]));
  for (const vote of votes.values()) counts[vote]++;
  const factionCounts = {dragon:0,trap:0,heal:0,shield:0};
  for (const {choice} of factionVotes.values()) factionCounts[choice]++;
  const members = {chaos:0,hero:0}; for(const faction of factionMembers.values())members[faction]++;
  return { round, endsAt, cooldownUntil, counts, lastEvent, options: OPTIONS, factions: { members, scores: {...factionScores}, counts: factionCounts, endsAt:factionEndsAt, round:factionRound, lastEvent:factionLastEvent, power:{...power}, powerMax:POWER_MAX, powerActions:{...powerActions}, powerCooldownMs:POWER_COOLDOWN_MS, powerEnabled, powerLastEvent, history:eventHistory.slice(-8) } }; 
}
function broadcast() { io.emit('state', state()); }
function emitGameEvent(event) {
  eventHistory.push(event);
  if (eventHistory.length > MAX_HISTORY) eventHistory.shift();
  io.emit('game:event', event);
}
function contributePower(userId) {
  userId = String(userId || '');
  const faction = factionMembers.get(userId);
  if (!powerEnabled || !faction) return false;
  const now = Date.now();
  if (now - (powerLastContribution.get(userId) || 0) < POWER_COOLDOWN_MS) return false;
  powerLastContribution.set(userId, now);
  power[faction] = Math.min(POWER_MAX, power[faction] + POWER_PER_ACTION);
  powerActions[faction]++;
  factionScores[faction]++;
  if (power[faction] >= POWER_MAX && now >= powerTriggersAt[faction]) {
    power[faction] = 0;
    powerTriggersAt[faction] = now + POWER_TRIGGER_COOLDOWN_MS;
    const event = { id: crypto.randomUUID(), type: faction === 'chaos' ? 'dragon' : 'shield', faction, source:'power', at:now };
    powerLastEvent = event;
    factionScores[faction] += 10;
    emitGameEvent(event);
  }
  broadcast();
  return true;
}

function startRound() {
  if (Date.now() < cooldownUntil) return false;
  round++;
  votes.clear();
  endsAt = Date.now() + VOTE_MS;
  lastEvent = null;
  broadcast();
  return true;
}
function vote(userId, choice) {
  if (!endsAt || Date.now() >= endsAt || !OPTIONS.includes(choice) || !userId) return false;
  votes.set(String(userId), choice);
  broadcast();
  return true;
}
function closeRound() {
  if (!endsAt || Date.now() < endsAt) return;
  const counts = state().counts;
  const highest = Math.max(...Object.values(counts));
  const tied = OPTIONS.filter(option => counts[option] === highest);
  // Deterministic tie-break: listed option order; no event when nobody votes.
  const winner = highest ? tied[0] : null;
  endsAt = 0;
  cooldownUntil = Date.now() + COOLDOWN_MS;
  if (winner) {
    lastEvent = { id: crypto.randomUUID(), type: winner, round, at: Date.now() };
    emitGameEvent(lastEvent);
  }
  broadcast();
}
function joinFaction(userId, faction) {
  if (!userId || !FACTIONS.includes(faction)) return false;
  // Team switching is locked after the first choice for the current server session.
  if (factionMembers.has(String(userId))) return false;
  factionMembers.set(String(userId), faction); broadcast(); return true;
}
function startFactionRound() {
  if (factionEndsAt) return false;
  factionRound++; factionVotes.clear(); factionEndsAt=Date.now()+FACTION_ROUND_MS;
  factionLastEvent=null; broadcast(); return true;
}
function castFactionVote(userId, choice) {
  const faction=factionMembers.get(String(userId));
  if(!faction || !factionEndsAt || Date.now()>=factionEndsAt) return false;
  if(factionCommands[faction][choice]!==choice) return false;
  factionVotes.set(String(userId), {faction,choice}); broadcast(); return true;
}
function closeFactionRound() {
  if(!factionEndsAt || Date.now()<factionEndsAt)return;
  factionEndsAt=0;
  const counts={dragon:0,trap:0,heal:0,shield:0};
  for(const {choice} of factionVotes.values())counts[choice]++;
  const ranked=Object.entries(counts).filter(([,count])=>count>0).sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0]));
  // Each faction has a chance to win its own vote. No votes => no effect.
  const winners=[];
  for(const faction of FACTIONS){
    const pick=ranked.find(([choice])=>factionCommands[faction][choice]);
    if(pick){const [type, count]=pick; winners.push({id:crypto.randomUUID(),type,faction,count,round:factionRound,at:Date.now()});factionScores[faction]+=count;}
  }
  factionLastEvent=winners;
  for(const event of winners)emitGameEvent(event);
  broadcast();
}
setInterval(()=>{closeRound();closeFactionRound();},200);
io.on('connection', socket => {
  socket.emit('state', state());
  socket.emit('twitch:status', twitchStatus());
  socket.on('host:power:toggle', ({enabled}={}) => { if (!admin(socket.request) || typeof enabled !== 'boolean') return; powerEnabled=enabled; broadcast(); });
  socket.on('demo:power', ({userId}={}) => {
    if (process.env.NODE_ENV === 'production' || !admin(socket.request)) return;
    if (typeof userId !== 'string' || userId.length > 64 || !userId.trim()) return;
    contributePower('demo:'+userId.trim());
  });
  socket.on('host:faction:start',()=>{if(admin(socket.request))startFactionRound();});
  socket.on('host:start', () => {
    if (admin(socket.request)) startRound();
  });
  // Local simulator only. Do not expose these actions publicly in production.
  socket.on('demo:vote', ({ userId, choice } = {}) => {
    if (process.env.NODE_ENV === 'production' || !admin(socket.request)) return;
    vote(userId, choice);
  });
  socket.on('demo:faction:join',({userId,faction}={})=>{if(process.env.NODE_ENV!=='production' && admin(socket.request))joinFaction('demo:'+userId,faction);});
  socket.on('demo:faction:vote',({userId,choice}={})=>{if(process.env.NODE_ENV!=='production' && admin(socket.request))castFactionVote('demo:'+userId,choice);});
  socket.on('demo:start', () => {
    if (process.env.NODE_ENV === 'production' || !admin(socket.request)) return;
    startRound();
  });
});

// Adapter hook: call this from verified Twitch chat events (EventSub channel.chat.message).
export function onTwitchChatMessage(event) {
  const text = String(event?.message?.text || '').trim().toLowerCase();
  const join = /^!(chaos|hero)$/.exec(text);
  if(join){joinFaction(event?.chatter_user_id,join[1]);return;}
  if (/^!(power|charge)$/.test(text)) { contributePower(event?.chatter_user_id); return; }
  const factionMatch=/^!(dragon|trap|heal|shield)$/.exec(text);
  if(factionMatch && factionMembers.has(String(event?.chatter_user_id))){castFactionVote(event.chatter_user_id,factionMatch[1]);return;}
  const match = /^!(dragon|treasure|heal)$/.exec(text);
  if (match && event?.chatter_user_id && !factionMembers.has(String(event.chatter_user_id))) vote(event.chatter_user_id, match[1]);
}
attachTwitch(app, onTwitchChatMessage, () => io.emit('twitch:status', twitchStatus()));
server.listen(process.env.PORT || 3000, () => console.log('Chaos Engine running at http://localhost:' + (process.env.PORT || 3000)));
