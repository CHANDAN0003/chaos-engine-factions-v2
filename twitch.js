import crypto from 'node:crypto';
import WebSocket from 'ws';

const WS_URL = 'wss://eventsub.wss.twitch.tv/ws';
const scopes = 'user:read:chat';
const sessions = new Map();
let credentials = null, socket = null, reconnectTimer = null, refreshTimer = null;
let connectionStatus = 'Disconnected';
const seen = new Map();
const clientId = process.env.TWITCH_CLIENT_ID;
const clientSecret = process.env.TWITCH_CLIENT_SECRET;
const redirectUri = process.env.TWITCH_REDIRECT_URI || 'http://localhost:3000/auth/callback';
const configuredBroadcaster = process.env.TWITCH_BROADCASTER_ID;
const cookieName = 'chaos_admin';
const cookie = (req, name) => (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(name + '='))?.slice(name.length + 1);
export const admin = req => { const id = cookie(req, cookieName); return !!id && sessions.has(id) && sessions.get(id) === credentials?.userId; };
export const status = () => ({ connected: connectionStatus, channel: credentials?.login || null, authenticated: !!credentials });
export function attachTwitch(app, onChat, onStatus) {
  app.get('/api/auth/status', (req, res) => res.json({ ...status(), admin: admin(req), demo: process.env.NODE_ENV !== 'production' }));
  app.get('/auth/login', (req, res) => {
    if (!clientId || !clientSecret) return res.status(503).send('Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in .env');
    const state = crypto.randomBytes(24).toString('hex');
    res.cookie('twitch_oauth_state', state, { httpOnly: true, sameSite: 'lax', maxAge: 600000, secure: redirectUri.startsWith('https:') });
    const url = new URL('https://id.twitch.tv/oauth2/authorize');
    Object.entries({client_id: clientId, redirect_uri: redirectUri, response_type:'code', scope: scopes, state}).forEach(([k,v])=>url.searchParams.set(k,v));
    res.redirect(url.toString());
  });
  app.get('/auth/callback', async (req, res) => {
    if (!req.query.code || !req.query.state || req.query.state !== cookie(req, 'twitch_oauth_state')) return res.status(400).send('Invalid OAuth state');
    res.clearCookie('twitch_oauth_state');
    try {
      const response = await fetch('https://id.twitch.tv/oauth2/token', {method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,code:String(req.query.code),grant_type:'authorization_code',redirect_uri:redirectUri})});
      const token = await response.json();
      if (!response.ok) throw Error(JSON.stringify(token));
      const identity = await validate(token.access_token);
      if (!identity.scopes?.includes(scopes)) throw Error('Missing user:read:chat scope');
      if (configuredBroadcaster && identity.user_id !== configuredBroadcaster) throw Error('Logged-in user does not match TWITCH_BROADCASTER_ID');
      credentials = {access:token.access_token,refresh:token.refresh_token,userId:identity.user_id,login:identity.login,expiresAt:Date.now()+token.expires_in*1000};
      sessions.clear();
      const session = crypto.randomBytes(32).toString('hex'); sessions.set(session, credentials.userId);
      res.cookie(cookieName,session,{httpOnly:true,sameSite:'lax',secure:redirectUri.startsWith('https:'),maxAge:8*3600*1000});
      connect(onChat,onStatus);
      res.redirect('/');
    } catch (error) { console.error('Twitch OAuth:',error.message); res.status(400).send('Twitch authorization failed. Check server logs.'); }
  });
  app.post('/auth/logout', (req,res)=> { if(admin(req)){ sessions.clear();credentials=null;socket?.close();clearTimeout(reconnectTimer);clearTimeout(refreshTimer);connectionStatus='Disconnected';onStatus();}res.clearCookie(cookieName);res.json({ok:true}); });
}
async function validate(token) {
  const response = await fetch('https://id.twitch.tv/oauth2/validate',{headers:{Authorization:'OAuth '+token}});
  if (!response.ok) throw Error('Token validation failed');
  const data = await response.json(); if(data.client_id !== clientId) throw Error('Wrong Twitch client ID');return data;
}
async function ensureToken() {
  if (Date.now() < credentials.expiresAt - 120000) return;
  const response = await fetch('https://id.twitch.tv/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:credentials.refresh,client_id:clientId,client_secret:clientSecret})});
  const data = await response.json(); if(!response.ok)throw Error('Token refresh failed: '+JSON.stringify(data));
  credentials.access=data.access_token;credentials.refresh=data.refresh_token || credentials.refresh;credentials.expiresAt=Date.now()+data.expires_in*1000;
}
async function subscribe(sessionId) {
  await ensureToken();
  const response = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions',{method:'POST',headers:{'Authorization':'Bearer '+credentials.access,'Client-Id':clientId,'Content-Type':'application/json'},body:JSON.stringify({type:'channel.chat.message',version:'1',condition:{broadcaster_user_id:credentials.userId,user_id:credentials.userId},transport:{method:'websocket',session_id:sessionId}})});
  if(!response.ok) throw Error('EventSub subscribe: '+response.status+' '+await response.text());
}
function connect(onChat,onStatus, url = WS_URL, replacing = false) {
  if(!credentials)return;
  clearTimeout(reconnectTimer);
  const ws = new WebSocket(url);let welcomed = false;
  ws.on('message', async raw => {
    let packet;try{packet=JSON.parse(raw.toString());}catch{return;}
    const kind=packet.metadata?.message_type;
    if(kind==='session_welcome') {
      welcomed=true;
      try { if(!replacing)await subscribe(packet.payload.session.id);const previous=socket;socket=ws;connectionStatus='Connected';onStatus();if(previous && previous!==ws)previous.close(); }
      catch(e){connectionStatus=e.message;onStatus();console.error(e);ws.close();}
    } else if(kind==='session_reconnect') {
      const next=packet.payload?.session?.reconnect_url;if(next)connect(onChat,onStatus,next,true);
    } else if(kind==='notification' && packet.metadata?.subscription_type==='channel.chat.message') {
      const id=packet.metadata.message_id;
      if(!id || seen.has(id))return;
      seen.set(id,Date.now());if(seen.size>1000)for(const [key,t] of seen)if(Date.now()-t>600000)seen.delete(key);
      const e=packet.payload?.event;
      if(e?.broadcaster_user_id===credentials?.userId && e?.chatter_user_id && e?.message?.text)onChat(e);
    } else if(kind==='revocation'){connectionStatus='Subscription revoked';onStatus();console.error('EventSub revoked',packet.payload);}
  });
  ws.on('error',e=>console.error('Twitch WebSocket:',e.message));
  ws.on('close',()=>{if(socket===ws || (!welcomed && !replacing)){if(socket===ws)socket=null;if(credentials){connectionStatus='Reconnecting';onStatus();reconnectTimer=setTimeout(()=>connect(onChat,onStatus),5000);}}});
}
