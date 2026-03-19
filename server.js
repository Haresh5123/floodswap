// MrBruh FloodSwap Server — 0x Gasless API Proxy
const express = require('express');
const cors    = require('cors');
const ethers  = require('ethers');
const fetch   = require('node-fetch');

const app = express();
app.use(cors({ origin: ['https://bejewelled-mandazi-573036.netlify.app','https://floodswapmrb.netlify.app','*'], methods:['GET','POST','DELETE','OPTIONS'], allowedHeaders:['Content-Type','Authorization'] }));
app.options('*', cors());
app.use(express.json());

const PORT     = process.env.PORT || 3001;
const ZX_KEY   = process.env.ZX_KEY || '';
const SOLVER_PK= process.env.SOLVER_PK;
const RPC_URL  = process.env.RPC_URL || 'https://arb1.arbitrum.io/rpc';
const ZX_BASE  = 'https://api.0x.org';

const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
const solver   = SOLVER_PK ? new ethers.Wallet(SOLVER_PK, provider) : null;
const orders   = new Map();
let orderCounter = 0;
const stats = { totalSurplus: 0, totalSwaps: 0, startTime: Date.now() };
let batchTimer = null;

function zxH() {
  return { 'Content-Type':'application/json', '0x-api-key':ZX_KEY, '0x-version':'v2' };
}

app.get('/', (req,res) => {
  const all=[...orders.values()];
  res.json({
    status:'ok', name:'MrBruh FloodSwap',
    zxKey: ZX_KEY ? ZX_KEY.slice(0,8)+'...' : 'NOT SET — add ZX_KEY to Railway variables',
    pendingOrders: all.filter(o=>o.status==='pending').length,
    totalSurplus: '$'+stats.totalSurplus.toFixed(4),
    totalSwaps: stats.totalSwaps,
    uptime: Math.floor((Date.now()-stats.startTime)/1000)+'s',
    solver: solver ? solver.address : 'not configured',
  });
});

// 0x PROXY — fixes CORS
app.get('/zx/gasless/quote', async(req,res) => {
  if(!ZX_KEY) return res.status(400).json({error:'ZX_KEY not set on server. Add to Railway variables.'});
  try {
    const url=ZX_BASE+'/gasless/quote?'+new URLSearchParams(req.query).toString();
    const r=await fetch(url,{headers:zxH()});
    const d=await r.json();
    res.status(r.status).json(d);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/zx/gasless/submit', async(req,res) => {
  if(!ZX_KEY) return res.status(400).json({error:'ZX_KEY not set'});
  try {
    const r=await fetch(ZX_BASE+'/gasless/submit',{method:'POST',headers:zxH(),body:JSON.stringify(req.body)});
    const d=await r.json();
    res.status(r.status).json(d);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/zx/gasless/status/:hash', async(req,res) => {
  if(!ZX_KEY) return res.status(400).json({error:'ZX_KEY not set'});
  try {
    const r=await fetch(ZX_BASE+'/gasless/status/'+req.params.hash,{headers:zxH()});
    const d=await r.json();
    res.status(r.status).json(d);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/zx/swap/price', async(req,res) => {
  if(!ZX_KEY) return res.status(400).json({error:'ZX_KEY not set'});
  try {
    const r=await fetch(ZX_BASE+'/swap/permit2/price?'+new URLSearchParams(req.query).toString(),{headers:zxH()});
    const d=await r.json();
    res.status(r.status).json(d);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/zx/swap/quote', async(req,res) => {
  if(!ZX_KEY) return res.status(400).json({error:'ZX_KEY not set'});
  try {
    const r=await fetch(ZX_BASE+'/swap/permit2/quote?'+new URLSearchParams(req.query).toString(),{headers:zxH()});
    const d=await r.json();
    res.status(r.status).json(d);
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ORDER BOOK
app.post('/orders', async(req,res) => {
  try {
    const {sellToken,buyToken,sellAmount,minBuyAmount,deadline,nonce,signature,from}=req.body;
    if(!sellToken||!buyToken||!sellAmount||!from) return res.status(400).json({error:'Missing fields'});
    const uid='0x'+(++orderCounter).toString(16).padStart(8,'0')+Date.now().toString(16);
    const order={uid,sellToken,buyToken,sellAmount,minBuyAmount,deadline:+deadline,nonce:+(nonce||0),signature,from,status:'pending',createdAt:Date.now()};
    orders.set(uid,order);
    const cow=await tryCow(order);
    if(cow) return res.json({uid,status:'matched',message:'CoW matched!'});
    if(!batchTimer) batchTimer=setTimeout(runBatch,30000);
    res.json({uid,status:'pending',message:'Order queued'});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/orders/:uid',(req,res)=>{ const o=orders.get(req.params.uid); if(!o) return res.status(404).json({error:'Not found'}); res.json(o); });
app.get('/orders',(req,res)=>res.json([...orders.values()].filter(o=>o.status==='pending')));
app.delete('/orders/:uid',(req,res)=>{ const o=orders.get(req.params.uid); if(!o) return res.status(404).json({error:'Not found'}); if(o.status!=='pending') return res.status(400).json({error:'Cannot cancel'}); o.status='cancelled'; res.json({status:'cancelled'}); });
app.get('/stats',(req,res)=>{ const a=[...orders.values()]; res.json({total:a.length,pending:a.filter(o=>o.status==='pending').length,filled:a.filter(o=>o.status==='filled').length,cow:a.filter(o=>o.cowMatched).length,surplus:'$'+stats.totalSurplus.toFixed(4),swaps:stats.totalSwaps}); });

async function tryCow(n) {
  const now=Math.floor(Date.now()/1000);
  for(const e of orders.values()) {
    if(e.uid===n.uid||e.status!=='pending'||e.deadline<=now) continue;
    if(e.sellToken.toLowerCase()!==n.buyToken.toLowerCase()) continue;
    if(e.buyToken.toLowerCase() !==n.sellToken.toLowerCase()) continue;
    try {
      const eS=ethers.BigNumber.from(e.sellAmount),nM=ethers.BigNumber.from(n.minBuyAmount||'0');
      const nS=ethers.BigNumber.from(n.sellAmount),eM=ethers.BigNumber.from(e.minBuyAmount||'0');
      if(!eS.gte(nM)||!nS.gte(eM)) continue;
    } catch(err){ continue; }
    n.status='matched'; n.cowMatched=true;
    e.status='matched'; e.cowMatched=true;
    console.log('[CoW]',n.uid.slice(0,10),'<->',e.uid.slice(0,10));
    return true;
  }
  return false;
}

async function runBatch() {
  batchTimer=null;
  const now=Math.floor(Date.now()/1000);
  const pending=[...orders.values()].filter(o=>o.status==='pending'&&o.deadline>now);
  for(const o of orders.values()) if(o.status==='pending'&&o.deadline<=now) o.status='expired';
  if(!pending.length) return;
  console.log('[BATCH]',pending.length,'orders');
  for(const order of pending) {
    if(order.status!=='pending') continue;
    try { await solveOrder(order); } catch(e) { console.error('[SOLVE]',e.message); }
    await new Promise(r=>setTimeout(r,1000));
  }
  if([...orders.values()].some(o=>o.status==='pending')) batchTimer=setTimeout(runBatch,30000);
}

async function solveOrder(order) {
  if(!solver||!ZX_KEY) { console.log('[SOLVE] No solver/key'); return; }
  try {
    const params=new URLSearchParams({chainId:42161,sellToken:order.sellToken,buyToken:order.buyToken,sellAmount:order.sellAmount,taker:order.from,tradeSurplusRecipient:order.from});
    const r=await fetch(ZX_BASE+'/gasless/quote?'+params,{headers:zxH()});
    const d=await r.json();
    if(!d.trade) return;
    order.status='filled'; order.filledAt=Date.now();
    stats.totalSwaps++;
    console.log('[FILLED]',order.uid.slice(0,10));
  } catch(e) { console.error('[SOLVE]',e.message); }
}

app.listen(PORT,()=>{
  console.log('\n🌊 MrBruh FloodSwap Server');
  console.log('   Port:',PORT);
  console.log('   0x Key:',ZX_KEY?ZX_KEY.slice(0,8)+'...':'NOT SET');
  console.log('   Solver:',solver?solver.address:'not configured');
  console.log('\nRoutes: /zx/gasless/quote /zx/gasless/submit /zx/gasless/status/:h /zx/swap/price /zx/swap/quote\n');
});
