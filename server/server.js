const express = require('express');
const crypto = require('crypto');
const http = require('http');
const WebSocket = require('ws');
const helmet = require('helmet');
const compression = require('compression');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const TEMP_UPLOAD_DIR = path.join(UPLOAD_DIR, '.chunks');
const DB = path.join(DATA_DIR, 'db.json');
const SECRET = process.env.JWT_SECRET || 'CHANGE_THIS_IN_PRODUCTION';
const REFRESH_SECRET = process.env.REFRESH_SECRET || crypto.createHash('sha256').update(SECRET+'-refresh').digest('hex');
const CHUNK_SIZE = Math.max(256 * 1024, Number(process.env.UPLOAD_CHUNK_SIZE || 2 * 1024 * 1024));
const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, 'starter_catalog.json'), 'utf8'));
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(TEMP_UPLOAD_DIR, { recursive: true });

const COLLECTIONS = ['users','videos','comments','follows','likes','stories','messages','notifications','bookmarks','reports','history','playlists','subscriptions','creatorSubscriptions','tips','adCampaigns','earnings','uploadSessions','musicProfiles','musicTracks','musicAlbums','aiThreads'];
const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const clean = (v, n=500) => String(v || '').trim().slice(0, n);

function save(d){ fs.writeFileSync(DB, JSON.stringify(d, null, 2)); }
function seed(d){
  let changed = false;
  d.users ??= []; d.videos ??= [];
  for (const c of CATALOG.creators){
    if (!d.users.some(u => u.id === c.id)){
      d.users.push({
        id:c.id, name:c.name, email:c.id+'@demo.zenithmax.app',
        password:bcrypt.hashSync('zenithmax-starter-library',8), bio:c.bio,
        followers:350+Math.floor(Math.random()*4200), following:12,
        role:'creator', createdAt:'2026-01-01T00:00:00.000Z', starter:true,
        verified:true, avatar:'', banner:'', notificationsEnabled:true
      });
      changed = true;
    }
  }
  // No bundled demo videos. Discover comes from user uploads and configured external sources.
  return changed;
}
function load(){
  if(!fs.existsSync(DB)) fs.writeFileSync(DB, JSON.stringify(Object.fromEntries(COLLECTIONS.map(k=>[k,[]])),null,2));
  const d=JSON.parse(fs.readFileSync(DB,'utf8'));
  for(const k of COLLECTIONS) if(!Array.isArray(d[k])) d[k]=[];
  if(seed(d)) save(d);
  return d;
}
function auth(req,res,next){
  try{ const p=jwt.verify((req.headers.authorization||'').replace('Bearer ',''),SECRET); if(p.type && p.type!=='access')throw new Error(); req.user=p; next(); }
  catch{ res.status(401).json({error:'Please sign in'}); }
}
function optional(req,res,next){
  try{ req.user=jwt.verify((req.headers.authorization||'').replace('Bearer ',''),SECRET); }
  catch{ req.user=null; }
  next();
}
function rankForFollowers(n){
  n=Math.max(0,Number(n||0));
  if(n<=10)return {name:'Beginners',min:0,max:10};
  if(n<=20)return {name:'Start',min:11,max:20};
  if(n<=100)return {name:'Entrance',min:21,max:100};
  if(n<1100)return {name:'Big',min:101,max:1099};
  if(n<1100000)return {name:'Bronze',min:1100,max:1099999};
  if(n<11000000)return {name:'Silver',min:1100000,max:10999999};
  if(n<111000000)return {name:'Gold',min:11000000,max:110999999};
  if(n<1100000000)return {name:'Kings',min:111000000,max:1099999999};
  return {name:'Lords',min:1100000000,max:100000000000};
}
function enrichUser(u){if(!u)return null;const {password,...rest}=u;return {...rest,rank:rankForFollowers(u.followers||0)};}
function accessToken(u){return jwt.sign({id:u.id,name:u.name,type:'access'},SECRET,{expiresIn:'30m'});}
function refreshToken(u){return jwt.sign({id:u.id,name:u.name,type:'refresh'},REFRESH_SECRET,{expiresIn:'90d'});}
function authPayload(u){return {token:accessToken(u),refreshToken:refreshToken(u),user:enrichUser(u)};}
function notify(d,userId,type,text,link='',actorId=''){
  if(!userId || userId===actorId) return;
  d.notifications.push({id:uid(),userId,type,text,link,actorId,read:false,createdAt:now()});
  if(d.notifications.length>3000) d.notifications=d.notifications.slice(-3000);
}
function pub(d,v,req){
  const u=d.users.find(x=>x.id===v.userId);
  return {...v,creator:u?.name||'ZenithMax Creator',creatorId:v.userId,creatorAvatar:u?.avatar||'',rank:rankForFollowers(u?.followers||0),verified:!!u?.verified,
    liked:!!req.user&&d.likes.some(x=>x.videoId===v.id&&x.userId===req.user.id),
    saved:!!req.user&&d.bookmarks.some(x=>x.videoId===v.id&&x.userId===req.user.id),
    following:!!req.user&&d.follows.some(x=>x.userId===req.user.id&&x.targetId===v.userId),
    commentCount:d.comments.filter(c=>c.videoId===v.id).length};
}
function affinity(d,userId){
  const out={};
  if(!userId) return out;
  const hist=d.history.filter(h=>h.userId===userId).slice(-120);
  for(const h of hist){ const v=d.videos.find(x=>x.id===h.videoId); if(v) out[v.category]=(out[v.category]||0)+1+Math.min(1,(h.progress||0)/100); }
  for(const b of d.bookmarks.filter(b=>b.userId===userId)){ const v=d.videos.find(x=>x.id===b.videoId); if(v) out[v.category]=(out[v.category]||0)+2.2; }
  return out;
}
function score(d,v,req,source){
  let s=Math.log10((v.views||0)+10)*26+Math.log10((v.likes||0)+5)*45+(v.starter?4:0);
  if(source&&v.category===source.category) s+=80;
  if(req.user){
    const a=affinity(d,req.user.id); s+=(a[v.category]||0)*18;
    if(d.follows.some(x=>x.userId===req.user.id&&x.targetId===v.userId)) s+=150;
    if(d.bookmarks.some(x=>x.userId===req.user.id&&x.videoId===v.id)) s+=35;
    if(d.history.some(x=>x.userId===req.user.id&&x.videoId===v.id&&x.progress>90)) s-=40;
  }
  const ageHours=Math.max(1,(Date.now()-new Date(v.createdAt))/36e5); s+=Math.max(0,50-Math.log10(ageHours+1)*20);
  return s;
}
function reasons(d,v,req){
  const r=[];
  if(req.user&&d.follows.some(x=>x.userId===req.user.id&&x.targetId===v.userId)) r.push('From a creator you follow');
  if(req.user&&(affinity(d,req.user.id)[v.category]||0)>1) r.push('Because you watch '+v.category.toLowerCase());
  if(v.views>100000) r.push('Popular on ZenithMax');
  if(!r.length) r.push('Recommended for you');
  return r.slice(0,2);
}

const storage=multer.diskStorage({destination:UPLOAD_DIR,filename:(req,f,cb)=>cb(null,uid()+path.extname(f.originalname).toLowerCase())});
const upload=multer({storage,limits:{fileSize:250*1024*1024},fileFilter:(req,f,cb)=>cb(null,/^video\/(mp4|webm|quicktime)$/.test(f.mimetype))});
const mediaUpload=multer({storage,limits:{fileSize:100*1024*1024},fileFilter:(req,f,cb)=>{const ok=/^(video\/(mp4|webm|quicktime)|audio\/(mpeg|mp4|wav|ogg|webm)|image\/(jpeg|png|webp|gif))$/.test(f.mimetype);cb(null,ok)}});
const mediaType=m=>m.startsWith('video/')?'video':m.startsWith('audio/')?'audio':m.startsWith('image/')?'image':'file';
app.use(helmet({crossOriginResourcePolicy:false}));
app.use(compression());
app.use(express.json({limit:'4mb'}));
app.use(express.urlencoded({extended:true}));
app.use('/uploads',express.static(UPLOAD_DIR));
app.use(express.static(path.join(ROOT,'client')));

app.get('/api/health',(req,res)=>res.json({ok:true,version:'17.1.0',videos:load().videos.filter(v=>!v.removed).length,starterVideos:0}));
app.post('/api/auth/register',async(req,res)=>{
  const name=clean(req.body.name,60),email=clean(req.body.email,160).toLowerCase(),password=String(req.body.password||'');
  if(!name||!email||password.length<6)return res.status(400).json({error:'Name, email and a 6+ character password are required'});
  const d=load(); if(d.users.some(u=>u.email===email))return res.status(409).json({error:'Email already registered'});
  const humanUsers=d.users.filter(u=>!u.starter);
  const u={id:uid(),name,email,password:await bcrypt.hash(password,10),bio:'New ZenithMax creator',followers:0,following:0,role:humanUsers.length===0?'admin':'user',createdAt:now(),verified:false,notificationsEnabled:true};
  d.users.push(u); save(d);
  res.json(authPayload(u));
});
app.post('/api/auth/login',async(req,res)=>{
  const d=load(),u=d.users.find(x=>x.email===clean(req.body.email,160).toLowerCase());
  if(!u||!(await bcrypt.compare(req.body.password||'',u.password)))return res.status(401).json({error:'Invalid email or password'});
  res.json(authPayload(u));
});
app.get('/api/me',auth,(req,res)=>{const u=load().users.find(x=>x.id===req.user.id);if(!u)return res.sendStatus(404);res.json({user:enrichUser(u)});});
app.post('/api/auth/refresh',(req,res)=>{try{const p=jwt.verify(String(req.body.refreshToken||''),REFRESH_SECRET);if(p.type!=='refresh')throw new Error();const u=load().users.find(x=>x.id===p.id);if(!u)return res.sendStatus(404);res.json(authPayload(u));}catch{res.status(401).json({error:'Session expired. Please sign in again.'});}});
app.patch('/api/me',auth,(req,res)=>{
  const d=load(),u=d.users.find(x=>x.id===req.user.id); if(!u)return res.sendStatus(404);
  if(req.body.name)u.name=clean(req.body.name,60); if(req.body.bio!==undefined)u.bio=clean(req.body.bio,300);
  save(d); res.json({user:enrichUser(u)});
});
app.post('/api/me/avatar',auth,mediaUpload.single('avatar'),(req,res)=>{
  const d=load(),u=d.users.find(x=>x.id===req.user.id); if(!u)return res.sendStatus(404);
  if(!req.file || !req.file.mimetype.startsWith('image/'))return res.status(400).json({error:'Choose a JPG, PNG, WEBP or GIF image'});
  if(u.avatar && u.avatar.startsWith('/uploads/')){try{fs.unlinkSync(path.join(UPLOAD_DIR,path.basename(u.avatar)));}catch{}}
  u.avatar='/uploads/'+req.file.filename; save(d); res.json({user:enrichUser(u)});
});

app.get('/api/videos',optional,(req,res)=>{
  const d=load(),q=clean(req.query.q,120).toLowerCase(),cat=clean(req.query.category,50),sort=req.query.sort||'latest',page=Math.max(1,Number(req.query.page||1)),limit=Math.min(40,Math.max(1,Number(req.query.limit||18)));
  let vs=d.videos.filter(v=>v.status!=='removed'&&(!cat||cat==='ALL'||v.category===cat)&&(!q||v.title.toLowerCase().includes(q)||(v.description||'').toLowerCase().includes(q)||(v.tags||[]).join(' ').toLowerCase().includes(q)));
  if(sort==='trending'||sort==='recommended')vs.sort((a,b)=>score(d,b,req)-score(d,a,req)); else vs.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  const total=vs.length; vs=vs.slice((page-1)*limit,page*limit).map(v=>({...pub(d,v,req),reason:reasons(d,v,req)[0]}));
  res.json({videos:vs,page,limit,total,hasMore:page*limit<total});
});
app.get('/api/search/suggestions',(req,res)=>{
  const d=load(),q=clean(req.query.q,80).toLowerCase(); if(!q)return res.json({suggestions:[]});
  const suggestions=[...new Set(d.videos.flatMap(v=>[v.title,...(v.tags||[])]).filter(x=>String(x).toLowerCase().includes(q)))].slice(0,8);
  res.json({suggestions});
});
app.get('/api/discover',optional,(req,res)=>{
  const d=load(); const videos=d.videos.filter(v=>v.status!=='removed').map(v=>({...pub(d,v,req),score:score(d,v,req),reasons:reasons(d,v,req)})).sort((a,b)=>b.score-a.score).slice(0,120);
  const categories=[...new Set(d.videos.map(v=>v.category))].sort();
  res.json({videos,categories});
});
app.get('/api/trending',optional,(req,res)=>{
  const d=load(); const videos=[...d.videos].filter(v=>v.status!=='removed').sort((a,b)=>(b.views||0)+(b.likes||0)*18-((a.views||0)+(a.likes||0)*18)).slice(0,40).map(v=>pub(d,v,req));
  res.json({videos});
});
app.get('/api/recommendations',optional,(req,res)=>{
  const d=load(),source=d.videos.find(v=>v.id===clean(req.query.videoId,100));
  const videos=d.videos.filter(v=>v.status!=='removed'&&v.id!==source?.id).map(v=>({...pub(d,v,req),score:score(d,v,req,source),reasons:reasons(d,v,req)})).sort((a,b)=>b.score-a.score).slice(0,80);
  res.json({videos});
});
app.get('/api/creators',optional,(req,res)=>{
  const d=load(); const creators=d.users.filter(u=>u.role==='creator'||u.starter||d.videos.some(v=>v.userId===u.id)).map(u=>({id:u.id,name:u.name,bio:u.bio,followers:u.followers,avatar:u.avatar||'',rank:rankForFollowers(u.followers||0),videoCount:d.videos.filter(v=>v.userId===u.id&&v.status!=='removed').length,verified:!!u.verified,following:!!req.user&&d.follows.some(f=>f.userId===req.user.id&&f.targetId===u.id)})).sort((a,b)=>b.followers-a.followers);
  res.json({creators});
});
app.get('/api/users/:id',optional,(req,res)=>{
  const d=load(),u=d.users.find(x=>x.id===req.params.id);if(!u)return res.sendStatus(404);
  res.json({user:enrichUser(u),videos:d.videos.filter(v=>v.userId===u.id&&v.status!=='removed').map(v=>pub(d,v,req)),following:!!req.user&&d.follows.some(f=>f.userId===req.user.id&&f.targetId===u.id)});
});

app.post('/api/uploads/init',auth,(req,res)=>{
  const name=clean(req.body.name,180)||'video.mp4';const size=Math.max(1,Number(req.body.size||0));
  if(!Number.isFinite(size)||size>2*1024*1024*1024)return res.status(413).json({error:'Maximum video size is 2 GB'});
  const d=load(),existing=d.uploadSessions.find(x=>x.userId===req.user.id&&x.name===name&&x.size===size&&x.status==='uploading');
  if(existing)return res.json({uploadId:existing.id,offset:existing.offset,size:existing.size,chunkSize:CHUNK_SIZE});
  const id=uid(),filePath=path.join(TEMP_UPLOAD_DIR,id+'.part');fs.closeSync(fs.openSync(filePath,'w'));
  const session={id,userId:req.user.id,name,size,offset:0,filePath,status:'uploading',createdAt:now(),updatedAt:now()};d.uploadSessions.push(session);save(d);
  res.json({uploadId:id,offset:0,size,chunkSize:CHUNK_SIZE});
});
app.get('/api/uploads/:id',auth,(req,res)=>{const d=load(),s=d.uploadSessions.find(x=>x.id===req.params.id&&x.userId===req.user.id);if(!s)return res.sendStatus(404);res.json({uploadId:s.id,offset:s.offset,size:s.size,status:s.status,chunkSize:CHUNK_SIZE});});
app.put('/api/uploads/:id/chunk',auth,(req,res)=>{
  const d=load(),s=d.uploadSessions.find(x=>x.id===req.params.id&&x.userId===req.user.id&&x.status==='uploading');if(!s)return res.sendStatus(404);
  const start=Number(req.headers['x-upload-offset']||s.offset);if(!Number.isInteger(start)||start!==s.offset)return res.status(409).json({error:'Upload offset mismatch',offset:s.offset});
  let written=0;const fd=fs.openSync(s.filePath,'r+');
  req.on('data',chunk=>{fs.writeSync(fd,chunk,0,chunk.length,start+written);written+=chunk.length;});
  req.on('end',()=>{try{fs.closeSync(fd);}catch{}s.offset+=written;s.updatedAt=now();save(d);res.json({uploadId:s.id,offset:s.offset,size:s.size,done:s.offset>=s.size});});
  req.on('error',()=>{try{fs.closeSync(fd);}catch{}});
});
app.post('/api/uploads/:id/complete',auth,(req,res)=>{
  const d=load(),s=d.uploadSessions.find(x=>x.id===req.params.id&&x.userId===req.user.id&&x.status==='uploading');if(!s)return res.sendStatus(404);
  if(s.offset!==s.size)return res.status(409).json({error:'Upload is incomplete',offset:s.offset,size:s.size});
  const ext=path.extname(s.name).toLowerCase()||'.mp4',destName=uid()+ext,dest=path.join(UPLOAD_DIR,destName);fs.renameSync(s.filePath,dest);
  const v={id:uid(),userId:req.user.id,title:clean(req.body.title,120)||path.basename(s.name,ext)||'Untitled video',description:clean(req.body.description,2000),category:clean(req.body.category,40).toUpperCase()||'GENERAL',tags:clean(req.body.tags,240).split(',').map(x=>x.trim()).filter(Boolean).slice(0,8),url:'/uploads/'+destName,likes:0,views:0,createdAt:now(),status:'published',resumeable:true,storage:'local'};
  d.videos.push(v);s.status='complete';s.videoId=v.id;s.updatedAt=now();save(d);res.json({video:v});
});
app.delete('/api/uploads/:id',auth,(req,res)=>{const d=load(),i=d.uploadSessions.findIndex(x=>x.id===req.params.id&&x.userId===req.user.id);if(i<0)return res.sendStatus(404);const s=d.uploadSessions[i];try{fs.unlinkSync(s.filePath);}catch{}d.uploadSessions.splice(i,1);save(d);res.json({ok:true});});

app.post('/api/videos',auth,upload.single('video'),(req,res)=>{
  if(!req.file)return res.status(400).json({error:'Choose an MP4/WebM/MOV video'});
  const d=load();const v={id:uid(),userId:req.user.id,title:clean(req.body.title,120)||'Untitled video',description:clean(req.body.description,2000),category:clean(req.body.category,40).toUpperCase()||'GENERAL',tags:clean(req.body.tags,240).split(',').map(x=>x.trim()).filter(Boolean).slice(0,8),url:'/uploads/'+req.file.filename,likes:0,views:0,createdAt:now(),status:'published'};
  d.videos.push(v); save(d); res.json({video:v});
});
app.post('/api/videos/:id/view',optional,(req,res)=>{
  const d=load(),v=d.videos.find(x=>x.id===req.params.id);if(!v)return res.sendStatus(404);v.views=(v.views||0)+1;
  if(req.user){let h=d.history.find(x=>x.userId===req.user.id&&x.videoId===v.id);if(h)h.watchedAt=now();else d.history.push({id:uid(),userId:req.user.id,videoId:v.id,watchedAt:now(),progress:0});}
  save(d);res.json({ok:true,views:v.views});
});
app.post('/api/videos/:id/progress',auth,(req,res)=>{
  const d=load();let h=d.history.find(x=>x.userId===req.user.id&&x.videoId===req.params.id);const progress=Math.max(0,Math.min(100,Number(req.body.progress||0)));
  if(h){h.progress=progress;h.watchedAt=now();}else d.history.push({id:uid(),userId:req.user.id,videoId:req.params.id,watchedAt:now(),progress});save(d);res.json({ok:true});
});
app.get('/api/history',auth,(req,res)=>{
  const d=load();res.json({videos:d.history.filter(h=>h.userId===req.user.id).sort((a,b)=>new Date(b.watchedAt)-new Date(a.watchedAt)).map(h=>{const v=d.videos.find(x=>x.id===h.videoId);return v?{...pub(d,v,req),progress:h.progress,watchedAt:h.watchedAt}:null}).filter(Boolean).slice(0,100)});
});
app.post('/api/videos/:id/like',auth,(req,res)=>{
  const d=load(),v=d.videos.find(x=>x.id===req.params.id);if(!v)return res.sendStatus(404);const i=d.likes.findIndex(x=>x.videoId===v.id&&x.userId===req.user.id);
  if(i>=0){d.likes.splice(i,1);v.likes=Math.max(0,(v.likes||0)-1);}else{d.likes.push({videoId:v.id,userId:req.user.id,createdAt:now()});v.likes=(v.likes||0)+1;notify(d,v.userId,'like',`${req.user.name} liked your video`,v.id,req.user.id);}
  save(d);res.json({liked:i<0,likes:v.likes});
});
app.post('/api/videos/:id/bookmark',auth,(req,res)=>{const d=load(),i=d.bookmarks.findIndex(b=>b.userId===req.user.id&&b.videoId===req.params.id);if(i>=0)d.bookmarks.splice(i,1);else d.bookmarks.push({userId:req.user.id,videoId:req.params.id,createdAt:now()});save(d);res.json({saved:i<0});});
app.get('/api/bookmarks',auth,(req,res)=>{const d=load();res.json({videos:d.videos.filter(v=>d.bookmarks.some(b=>b.userId===req.user.id&&b.videoId===v.id)).map(v=>pub(d,v,req))});});

app.get('/api/videos/:id/comments',(req,res)=>{
  const d=load();const comments=d.comments.filter(c=>c.videoId===req.params.id).sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt)).map(c=>({...c,user:d.users.find(u=>u.id===c.userId)?.name||'User',verified:!!d.users.find(u=>u.id===c.userId)?.verified}));res.json({comments});
});
app.post('/api/videos/:id/comments',auth,(req,res)=>{
  const d=load(),text=clean(req.body.text,500),v=d.videos.find(x=>x.id===req.params.id);if(!text)return res.status(400).json({error:'Comment must be 1–500 characters'});if(!v)return res.sendStatus(404);
  const c={id:uid(),videoId:req.params.id,userId:req.user.id,text,createdAt:now()};d.comments.push(c);notify(d,v.userId,'comment',`${req.user.name} commented on your video`,v.id,req.user.id);save(d);res.json({comment:c});
});
app.delete('/api/comments/:id',auth,(req,res)=>{const d=load(),i=d.comments.findIndex(c=>c.id===req.params.id&&(c.userId===req.user.id||d.users.find(u=>u.id===req.user.id)?.role==='admin'));if(i<0)return res.sendStatus(404);d.comments.splice(i,1);save(d);res.json({ok:true});});

app.post('/api/users/:id/follow',auth,(req,res)=>{
  const d=load();if(req.params.id===req.user.id)return res.status(400).json({error:'You cannot follow yourself'});const i=d.follows.findIndex(f=>f.userId===req.user.id&&f.targetId===req.params.id);
  if(i>=0)d.follows.splice(i,1);else{d.follows.push({userId:req.user.id,targetId:req.params.id,createdAt:now()});notify(d,req.params.id,'follow',`${req.user.name} followed you`,'',req.user.id);}
  for(const u of d.users){u.followers=d.follows.filter(f=>f.targetId===u.id).length;u.following=d.follows.filter(f=>f.userId===u.id).length;}save(d);res.json({following:i<0});
});
app.get('/api/following',auth,optional,(req,res)=>{const d=load(),ids=d.follows.filter(f=>f.userId===req.user.id).map(f=>f.targetId);res.json({videos:d.videos.filter(v=>ids.includes(v.userId)).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).map(v=>pub(d,v,req))});});

app.post('/api/playlists',auth,(req,res)=>{const d=load(),name=clean(req.body.name,80);if(!name)return res.status(400).json({error:'Playlist name required'});const p={id:uid(),userId:req.user.id,name,description:clean(req.body.description,200),videoIds:[],createdAt:now()};d.playlists.push(p);save(d);res.json({playlist:p});});
app.get('/api/playlists',auth,(req,res)=>{const d=load();res.json({playlists:d.playlists.filter(p=>p.userId===req.user.id).map(p=>({...p,count:p.videoIds.length,cover:d.videos.find(v=>v.id===p.videoIds[0])?.url||''}))});});
app.get('/api/playlists/:id',auth,(req,res)=>{const d=load(),p=d.playlists.find(x=>x.id===req.params.id&&x.userId===req.user.id);if(!p)return res.sendStatus(404);res.json({playlist:p,videos:p.videoIds.map(id=>d.videos.find(v=>v.id===id)).filter(Boolean).map(v=>pub(d,v,req))});});
app.post('/api/playlists/:id/videos/:videoId',auth,(req,res)=>{const d=load(),p=d.playlists.find(x=>x.id===req.params.id&&x.userId===req.user.id);if(!p)return res.sendStatus(404);const i=p.videoIds.indexOf(req.params.videoId);if(i>=0)p.videoIds.splice(i,1);else p.videoIds.push(req.params.videoId);save(d);res.json({playlist:p,added:i<0});});
app.delete('/api/playlists/:id',auth,(req,res)=>{const d=load(),i=d.playlists.findIndex(p=>p.id===req.params.id&&p.userId===req.user.id);if(i<0)return res.sendStatus(404);d.playlists.splice(i,1);save(d);res.json({ok:true});});

app.get('/api/notifications',auth,(req,res)=>{const d=load();res.json({notifications:d.notifications.filter(n=>n.userId===req.user.id).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).slice(0,100)});});
app.post('/api/notifications/read',auth,(req,res)=>{const d=load();for(const n of d.notifications)if(n.userId===req.user.id)n.read=true;save(d);res.json({ok:true});});
app.get('/api/media/pexels/search',async(req,res)=>{
  if(!process.env.PEXELS_API_KEY)return res.status(503).json({error:'PEXELS_API_KEY is not configured'});
  const q=clean(req.query.q,100)||'nature',page=Math.max(1,Number(req.query.page||1)),perPage=Math.min(24,Math.max(1,Number(req.query.perPage||12)));
  try{
    const u='https://api.pexels.com/v1/videos/search?'+new URLSearchParams({query:q,page:String(page),per_page:String(perPage)});
    const r=await fetch(u,{headers:{Authorization:process.env.PEXELS_API_KEY}});if(!r.ok)throw new Error();const j=await r.json();
    const results=(j.videos||[]).map(v=>{const files=[...(v.video_files||[])].filter(x=>x.file_type==='video/mp4').sort((a,b)=>(b.width||0)-(a.width||0));const f=files.find(x=>(x.width||0)<=1920)||files[0];return{id:'pexels-'+v.id,title:`${q} · Pexels #${v.id}`,url:f?.link||'',creator:v.user?.name||'Pexels creator',sourceUrl:v.url,source:'Pexels',duration:v.duration||0,width:f?.width||0,height:f?.height||0};}).filter(x=>x.url);
    res.json({source:'Pexels',attribution:'Videos provided by Pexels',results});
  }catch{res.status(502).json({error:'Could not reach Pexels'});}
});
app.get('/api/music/search',async(req,res)=>{
  const term=clean(req.query.term,100)||'afrobeats',country=clean(req.query.country,2).toLowerCase()||'ng',limit=Math.min(50,Math.max(1,Number(req.query.limit||24)));
  try{const url='https://itunes.apple.com/search?'+new URLSearchParams({term,country,media:'music',entity:'song',limit:String(limit),explicit:'No'});const r=await fetch(url,{headers:{'User-Agent':'ZenithMax/17.0'}});if(!r.ok)throw new Error();const j=await r.json();res.json({source:'Apple/iTunes promotional catalog',results:(j.results||[]).map(x=>({id:String(x.trackId||x.collectionId),title:x.trackName||'',artist:x.artistName||'',album:x.collectionName||'',genre:x.primaryGenreName||'',year:x.releaseDate?String(x.releaseDate).slice(0,4):'',artwork:x.artworkUrl100||'',preview:x.previewUrl||'',storeUrl:x.trackViewUrl||x.collectionViewUrl||'',country:x.country||country.toUpperCase(),explicit:x.trackExplicitness==='explicit'}))});}catch{res.status(502).json({error:'Could not reach the music discovery provider'});}
});
app.get('/api/music/profile',auth,(req,res)=>{const d=load(),p=d.musicProfiles.find(x=>x.userId===req.user.id)||null;res.json({profile:p});});
app.post('/api/music/profile',auth,(req,res)=>{const d=load(),existing=d.musicProfiles.find(x=>x.userId===req.user.id),p=existing||{id:uid(),userId:req.user.id,createdAt:now()};p.artistName=clean(req.body.artistName,80);p.genre=clean(req.body.genre,80);p.bio=clean(req.body.bio,500);if(!p.artistName)return res.status(400).json({error:'Artist name is required'});if(!existing)d.musicProfiles.push(p);save(d);res.json({profile:p});});
const musicFieldUpload=multer({storage,limits:{fileSize:150*1024*1024},fileFilter:(req,f,cb)=>cb(null,/^(audio\/(mpeg|mp4|wav|ogg|webm)|image\/(jpeg|png|webp|gif))$/.test(f.mimetype))});
app.post('/api/music/tracks',auth,musicFieldUpload.fields([{name:'audio',maxCount:1},{name:'cover',maxCount:1}]),(req,res)=>{const d=load(),audio=req.files?.audio?.[0],cover=req.files?.cover?.[0];if(!audio)return res.status(400).json({error:'Choose an audio file'});let profile=d.musicProfiles.find(x=>x.userId===req.user.id);if(!profile){profile={id:uid(),userId:req.user.id,artistName:clean(req.body.artistName,80)||req.user.name,genre:clean(req.body.genre,80)||'Independent',bio:'',createdAt:now()};d.musicProfiles.push(profile);}const t={id:uid(),userId:req.user.id,profileId:profile.id,title:clean(req.body.title,140)||'Untitled track',genre:clean(req.body.genre,80)||profile.genre,album:clean(req.body.album,120),audioUrl:'/uploads/'+audio.filename,coverUrl:cover?'/uploads/'+cover.filename:'',mime:audio.mimetype,createdAt:now(),plays:0};d.musicTracks.push(t);save(d);res.json({track:t});});
app.get('/api/music/mine',auth,(req,res)=>{const d=load();res.json({profile:d.musicProfiles.find(x=>x.userId===req.user.id)||null,tracks:d.musicTracks.filter(x=>x.userId===req.user.id)});});
app.get('/api/ai/threads',auth,(req,res)=>{const d=load();res.json({threads:d.aiThreads.filter(x=>x.userId===req.user.id).slice(-50)});});
app.post('/api/ai/chat',auth,async(req,res)=>{const d=load(),message=clean(req.body.message,6000);if(!message)return res.status(400).json({error:'Message required'});let answer='I am Zenith AI. I can help plan code, product features, game systems, animations and creative workflows. Connect an AI provider in Render environment variables to enable model-backed generation.';if(process.env.AI_API_URL&&process.env.AI_API_KEY){try{const r=await fetch(process.env.AI_API_URL,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+process.env.AI_API_KEY},body:JSON.stringify({model:process.env.AI_MODEL||'default',messages:[{role:'system',content:'You are Zenith AI, a helpful creative engineering assistant inside ZenithMax. Provide safe, practical technical plans and code. Do not claim capabilities you do not have.'},{role:'user',content:message}]})});const j=await r.json();answer=j.choices?.[0]?.message?.content||j.output_text||answer;}catch{answer+=' The configured AI provider did not respond, so I returned the offline assistant response.';}}const item={id:uid(),userId:req.user.id,message,answer,createdAt:now()};d.aiThreads.push(item);if(d.aiThreads.length>5000)d.aiThreads=d.aiThreads.slice(-5000);save(d);res.json({item});});
app.get('/api/calls/room',auth,(req,res)=>res.json({roomId:uid(),maxPeers:6}));

app.get('/api/messages/conversations',auth,(req,res)=>{
  const d=load(),msgs=d.messages.filter(m=>m.fromId===req.user.id||m.toId===req.user.id);const map=new Map();
  for(const m of msgs.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt))){const other=m.fromId===req.user.id?m.toId:m.fromId;if(!map.has(other))map.set(other,{user:enrichUser(d.users.find(u=>u.id===other)),last:m});}
  res.json({conversations:[...map.values()].filter(x=>x.user)});
});
app.get('/api/messages/:userId',auth,(req,res)=>{const d=load();res.json({messages:d.messages.filter(m=>(m.fromId===req.user.id&&m.toId===req.params.userId)||(m.fromId===req.params.userId&&m.toId===req.user.id)).sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt)),user:enrichUser(d.users.find(u=>u.id===req.params.userId))});});
app.post('/api/messages/:userId',auth,(req,res)=>{const d=load(),text=clean(req.body.text,1000);if(!text)return res.status(400).json({error:'Message cannot be empty'});if(!d.users.some(u=>u.id===req.params.userId))return res.sendStatus(404);const m={id:uid(),fromId:req.user.id,toId:req.params.userId,text,kind:'text',createdAt:now()};d.messages.push(m);notify(d,req.params.userId,'message',`${req.user.name} sent you a message`,'messages',req.user.id);save(d);res.json({message:m});});
app.post('/api/messages/:userId/media',auth,mediaUpload.single('media'),(req,res)=>{const d=load(),target=d.users.find(u=>u.id===req.params.userId);if(!target)return res.sendStatus(404);if(!req.file)return res.status(400).json({error:'Choose an image, video, or audio file'});const m={id:uid(),fromId:req.user.id,toId:target.id,text:clean(req.body.caption,300),kind:'media',mediaType:mediaType(req.file.mimetype),mime:req.file.mimetype,fileName:req.file.originalname.slice(0,160),url:'/uploads/'+req.file.filename,createdAt:now()};d.messages.push(m);notify(d,target.id,'message',`${req.user.name} sent you ${m.mediaType==='audio'?'music/audio':m.mediaType}`,'messages',req.user.id);save(d);res.json({message:m});});

app.post('/api/videos/:id/report',auth,(req,res)=>{const d=load();if(d.reports.some(r=>r.videoId===req.params.id&&r.userId===req.user.id))return res.status(409).json({error:'You already reported this video'});d.reports.push({id:uid(),videoId:req.params.id,userId:req.user.id,reason:clean(req.body.reason,200)||'Other',status:'open',createdAt:now()});save(d);res.json({ok:true});});
app.get('/api/admin/overview',auth,(req,res)=>{const d=load(),u=d.users.find(x=>x.id===req.user.id);if(u?.role!=='admin')return res.status(403).json({error:'Admin only'});res.json({users:d.users.filter(x=>!x.starter).length,videos:d.videos.length,reports:d.reports.filter(r=>r.status==='open').length,comments:d.comments.length,recentReports:d.reports.slice(-30).reverse().map(r=>({...r,title:d.videos.find(v=>v.id===r.videoId)?.title||'Unknown'}))});});
app.post('/api/admin/reports/:id/resolve',auth,(req,res)=>{const d=load(),u=d.users.find(x=>x.id===req.user.id);if(u?.role!=='admin')return res.status(403).json({error:'Admin only'});const r=d.reports.find(x=>x.id===req.params.id);if(!r)return res.sendStatus(404);r.status='resolved';r.resolvedAt=now();save(d);res.json({ok:true});});

app.post('/api/creator/apply',auth,(req,res)=>{const d=load(),u=d.users.find(x=>x.id===req.user.id);if(!u)return res.sendStatus(404);u.role='creator';u.creatorSince=u.creatorSince||now();u.bio=u.bio||'ZenithMax creator';notify(d,u.id,'creator','Welcome to Creator Mode! Start publishing original content.','studio');save(d);res.json({ok:true,user:enrichUser(u)});});
app.get('/api/stats',auth,(req,res)=>{
  const d=load(),vs=d.videos.filter(v=>v.userId===req.user.id),totalViews=vs.reduce((n,v)=>n+(v.views||0),0),totalLikes=vs.reduce((n,v)=>n+(v.likes||0),0);
  const top=[...vs].sort((a,b)=>(b.views||0)-(a.views||0)).slice(0,5).map(v=>({id:v.id,title:v.title,views:v.views,likes:v.likes}));
  const cats={};for(const v of vs)cats[v.category]=(cats[v.category]||0)+v.views;
  res.json({videos:vs.length,views:totalViews,likes:totalLikes,followers:d.users.find(u=>u.id===req.user.id)?.followers||0,comments:d.comments.filter(c=>vs.some(v=>v.id===c.videoId)).length,topVideos:top,categories:cats});
});
app.get('/api/developer',(req,res)=>res.json({name:'Zenith Oluwambe',alias:'Spark',summary:'Creator and student building ZenithMax as an independent project.',publicBio:'ZenithMax was created as a teen coding project focused on social, video, music and creator tools. For safety and privacy, personal school and birth-date details are not published in the public app profile.'}));
app.get('/api/live/status',(req,res)=>res.json({enabled:false,version:'17.1',message:'WebRTC calling signaling is available; production group calling should use a TURN server and dedicated media architecture.'}));

// V14 monetization architecture. This is a safe demo ledger: it does NOT process real money.
function monetizationSummary(d,userId){
  const rows=d.earnings.filter(e=>e.creatorId===userId);
  const tips=rows.filter(e=>e.type==='tip').reduce((n,e)=>n+e.amount,0);
  const subs=rows.filter(e=>e.type==='subscription').reduce((n,e)=>n+e.amount,0);
  const ads=rows.filter(e=>e.type==='ad').reduce((n,e)=>n+e.amount,0);
  const sponsorships=rows.filter(e=>e.type==='sponsorship').reduce((n,e)=>n+e.amount,0);
  return {tips,subscriptions:subs,ads,sponsorships,total:tips+subs+ads+sponsorships};
}
app.get('/api/monetization/dashboard',auth,(req,res)=>{
  const d=load(), u=d.users.find(x=>x.id===req.user.id); if(!u)return res.sendStatus(404);
  const summary=monetizationSummary(d,u.id);
  const creatorSubs=d.creatorSubscriptions.filter(x=>x.creatorId===u.id&&x.status==='active').length;
  const campaigns=d.adCampaigns.filter(x=>x.creatorId===u.id);
  res.json({mode:'demo',summary,creatorSubscribers:creatorSubs,campaigns,history:d.earnings.filter(e=>e.creatorId===u.id).slice(-50).reverse(),eligible:(u.followers||0)>=100});
});
app.post('/api/monetization/tip',auth,(req,res)=>{
  const d=load(), creator=d.users.find(x=>x.id===clean(req.body.creatorId,100));
  const amount=Math.min(100,Math.max(1,Number(req.body.amount||1)));
  if(!creator)return res.sendStatus(404); if(creator.id===req.user.id)return res.status(400).json({error:'You cannot tip yourself'});
  // Demo credits only; no card/payment is touched.
  const platform=Math.round(amount*0.10*100)/100, net=Math.round((amount-platform)*100)/100;
  d.tips.push({id:uid(),fromId:req.user.id,creatorId:creator.id,amount,platformFee:platform,net,createdAt:now(),mode:'demo'});
  d.earnings.push({id:uid(),creatorId:creator.id,sourceUserId:req.user.id,type:'tip',amount:net,gross:amount,createdAt:now(),mode:'demo'});
  notify(d,creator.id,'tip',`${req.user.name} sent you a demo tip of ${amount} credits`,'monetization',req.user.id); save(d);
  res.json({ok:true,mode:'demo',gross:amount,platformFee:platform,creatorEarned:net});
});
app.post('/api/monetization/subscribe',auth,(req,res)=>{
  const d=load(), creator=d.users.find(x=>x.id===clean(req.body.creatorId,100)); if(!creator)return res.sendStatus(404);
  if(creator.id===req.user.id)return res.status(400).json({error:'You cannot subscribe to yourself'});
  const existing=d.creatorSubscriptions.find(x=>x.creatorId===creator.id&&x.userId===req.user.id);
  if(existing){existing.status=existing.status==='active'?'cancelled':'active'; existing.updatedAt=now(); save(d); return res.json({active:existing.status==='active',mode:'demo'});}
  const price=5, fee=.5, sub={id:uid(),creatorId:creator.id,userId:req.user.id,price,platformFee:fee,status:'active',createdAt:now()};
  d.creatorSubscriptions.push(sub); d.earnings.push({id:uid(),creatorId:creator.id,sourceUserId:req.user.id,type:'subscription',amount:price-fee,gross:price,createdAt:now(),mode:'demo'});
  creator.followers=(creator.followers||0)+1; notify(d,creator.id,'subscription',`${req.user.name} subscribed to your creator channel`,'monetization',req.user.id); save(d);
  res.json({active:true,mode:'demo',price});
});
app.post('/api/monetization/campaigns',auth,(req,res)=>{
  const d=load(), title=clean(req.body.title,100), budget=Math.min(10000,Math.max(10,Number(req.body.budget||10)));
  if(!title)return res.status(400).json({error:'Campaign title required'});
  const c={id:uid(),creatorId:req.user.id,title,budget,status:'draft',createdAt:now(),impressions:0,clicks:0}; d.adCampaigns.push(c); save(d); res.json({campaign:c,mode:'demo'});
});
app.post('/api/monetization/campaigns/:id/activate',auth,(req,res)=>{
  const d=load(),c=d.adCampaigns.find(x=>x.id===req.params.id&&x.creatorId===req.user.id); if(!c)return res.sendStatus(404); c.status=c.status==='active'?'paused':'active'; save(d); res.json({campaign:c,mode:'demo'});
});
app.post('/api/monetization/ads/impression',optional,(req,res)=>{
  const d=load(), id=clean(req.body.campaignId,100), c=d.adCampaigns.find(x=>x.id===id&&x.status==='active');
  if(!c)return res.status(404).json({error:'Campaign not active'});
  c.impressions=(c.impressions||0)+1; if(c.impressions%100===0){const amount=.20; d.earnings.push({id:uid(),creatorId:c.creatorId,type:'ad',amount,gross:amount,createdAt:now(),mode:'demo'});} save(d); res.json({ok:true});
});
app.get('/api/monetization/eligibility',auth,(req,res)=>{const d=load(),u=d.users.find(x=>x.id===req.user.id);res.json({followers:u?.followers||0,verified:!!u?.verified,eligible:(u?.followers||0)>=100,requirements:['Build a real audience','Publish original or licensed content','Follow applicable platform/payment rules','Complete adult-assisted business/payment setup when required'],mode:'demo'});});

app.use((req,res)=>res.sendFile(path.join(ROOT,'client/index.html')));
const server=http.createServer(app);
const wss=new WebSocket.Server({server,path:'/ws'});
const callRooms=new Map();
wss.on('connection',(socket,req)=>{
  let user=null,room=null;try{const u=new URL(req.url,'http://localhost');const p=jwt.verify(u.searchParams.get('token')||'',SECRET);user=p.id;}catch{}
  socket.on('message',raw=>{let msg;try{msg=JSON.parse(raw.toString())}catch{return}
    if(msg.type==='join'&&msg.room){room=String(msg.room).slice(0,120);if(!callRooms.has(room))callRooms.set(room,new Set());const peers=callRooms.get(room);for(const peer of peers){if(peer.readyState===WebSocket.OPEN)peer.send(JSON.stringify({type:'peer-joined',peerId:user}));}peers.add(socket);}
    if(msg.type==='signal'&&room){for(const peer of (callRooms.get(room)||[])){if(peer!==socket&&peer.readyState===WebSocket.OPEN)peer.send(JSON.stringify({type:'signal',from:user,data:msg.data}));}}
  });
  socket.on('close',()=>{if(room&&callRooms.has(room)){callRooms.get(room).delete(socket);if(callRooms.get(room).size===0)callRooms.delete(room);}});
});
server.listen(PORT,'0.0.0.0',()=>console.log(`ZenithMax V17 running on http://localhost:${PORT}`));
