// MrBruh FloodSwap Server — Single file for Railway
const express = require('express');
const cors    = require('cors');
const ethers  = require('ethers');
const fetch   = require('node-fetch');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const PORT       = process.env.PORT || 3001;
const CHAIN_ID   = 42161;
const RPC_URL    = process.env.RPC_URL || 'https://arb1.arbitrum.io/rpc';
const SOLVER_PK  = process.env.SOLVER_PK;
const WETH_ARB   = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
const NATIVE     = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const ROUTER     = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';
const ROUTER_KY  = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5';
const QUOTER     = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';

const provider   = new ethers.providers.JsonRpcProvider(RPC_URL);
const solver     = SOLVER_PK ? new ethers.Wallet(SOLVER_PK, provider) : null;

const QUOTER_ABI = ['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)'];
const ROUTER_ABI = ['function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)'];
const ERC20_ABI  = ['function allowance(address,address) view returns (uint256)'];

// ── Order book (in-memory) ──────────────────────────────────
const orders = new Map();
let orderCounter = 0;
const stats = { totalSurplus: 0, totalSwaps: 0, startTime: Date.now() };
let batchTimer = null;
const BATCH_MS = 30000;

// Token decimals map
const TOKEN_DEC = {
  '0xaf88d065e77c8cC2239327C5EDb3A432268e5831': 6,   // USDC
  '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9': 6,   // USDT
  '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1': 18,  // DAI
  '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1': 18,  // WETH
  '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f': 8,   // WBTC
  '0x5979D7b546E38E414F7E9822514be443A4800529': 18,  // wstETH
  '0x912CE59144191C1204E64559FE8253a0e49E6548': 18,  // ARB
  '0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a': 18,  // GMX
  '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4': 18,  // LINK
};
function getDec(addr) {
  return TOKEN_DEC[addr] || TOKEN_DEC[(addr||'').toLowerCase()] || 18;
}

// ── Health ──────────────────────────────────────────────────
app.get('/', (req, res) => {
  const allOrders = [...orders.values()];
  res.json({
    status:        'ok',
    name:          'MrBruh FloodSwap',
    pendingOrders: allOrders.filter(o => o.status === 'pending').length,
    totalSurplus:  stats.totalSurplus.toFixed(4),
    totalSwaps:    stats.totalSwaps,
    uptime:        Math.floor((Date.now() - stats.startTime) / 1000) + 's',
    solver:        solver ? solver.address : 'not configured (set SOLVER_PK)',
    chain:         'Arbitrum One (' + CHAIN_ID + ')',
  });
});

// ── POST /orders ────────────────────────────────────────────
app.post('/orders', async (req, res) => {
  try {
    const { sellToken, buyToken, sellAmount, minBuyAmount, deadline, nonce, signature, from } = req.body;
    if (!sellToken || !buyToken || !sellAmount || !minBuyAmount || !deadline || !signature || !from)
      return res.status(400).json({ error: 'Missing fields: sellToken buyToken sellAmount minBuyAmount deadline nonce signature from' });

    // Verify EIP-712 signature
    const domain = { name: 'MrBruhFlood', version: '1', chainId: CHAIN_ID, verifyingContract: ROUTER };
    const types = {
      SwapIntent: [
        { name: 'sellToken',     type: 'address' },
        { name: 'buyToken',      type: 'address' },
        { name: 'sellAmount',    type: 'uint256' },
        { name: 'minBuyAmount',  type: 'uint256' },
        { name: 'deadline',      type: 'uint256' },
        { name: 'nonce',         type: 'uint256' },
      ]
    };
    const value = { sellToken, buyToken, sellAmount, minBuyAmount, deadline: +deadline, nonce: +(nonce||0) };
    let recovered;
    try { recovered = ethers.utils.verifyTypedData(domain, types, value, signature); }
    catch (e) { return res.status(400).json({ error: 'Invalid signature: ' + e.message }); }
    if (recovered.toLowerCase() !== from.toLowerCase())
      return res.status(400).json({ error: 'Signature mismatch' });
    if (+deadline < Math.floor(Date.now() / 1000))
      return res.status(400).json({ error: 'Order expired' });

    const uid = '0x' + (++orderCounter).toString(16).padStart(8,'0') + Date.now().toString(16);
    const order = { uid, sellToken, buyToken, sellAmount, minBuyAmount, deadline: +deadline, nonce: +(nonce||0), signature, from, status: 'pending', createdAt: Date.now() };
    orders.set(uid, order);
    console.log('[ORDER]', uid.slice(0,14), from.slice(0,10), sellAmount, '->', minBuyAmount);

    // Try CoW match immediately
    const cowResult = await tryCow(order);
    if (cowResult) {
      return res.json({ uid, status: 'matched', message: 'CoW match! Orders matched with no gas.' });
    }

    // Schedule batch
    if (!batchTimer) batchTimer = setTimeout(runBatch, BATCH_MS);

    res.json({ uid, status: 'pending', message: 'Order queued. Solver running every 30s.' });
  } catch (e) {
    console.error('[POST /orders]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /orders/:uid ────────────────────────────────────────
app.get('/orders/:uid', (req, res) => {
  const o = orders.get(req.params.uid);
  if (!o) return res.status(404).json({ error: 'Not found' });
  res.json(o);
});

// ── GET /orders ─────────────────────────────────────────────
app.get('/orders', (req, res) => {
  res.json([...orders.values()].filter(o => o.status === 'pending').map(o => ({
    uid: o.uid, from: o.from, sellToken: o.sellToken, buyToken: o.buyToken,
    sellAmount: o.sellAmount, minBuyAmount: o.minBuyAmount, deadline: o.deadline
  })));
});

// ── DELETE /orders/:uid ─────────────────────────────────────
app.delete('/orders/:uid', (req, res) => {
  const o = orders.get(req.params.uid);
  if (!o) return res.status(404).json({ error: 'Not found' });
  if (o.status !== 'pending') return res.status(400).json({ error: 'Cannot cancel: ' + o.status });
  o.status = 'cancelled';
  res.json({ status: 'cancelled' });
});

// ── GET /quote ──────────────────────────────────────────────
app.get('/quote', async (req, res) => {
  try {
    const { sellToken, buyToken, sellAmount } = req.query;
    if (!sellToken || !buyToken || !sellAmount)
      return res.status(400).json({ error: 'Need sellToken, buyToken, sellAmount' });
    const result = await getBestQuote(sellToken, buyToken, ethers.BigNumber.from(sellAmount));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /stats ──────────────────────────────────────────────
app.get('/stats', (req, res) => {
  const all = [...orders.values()];
  res.json({
    total:    all.length,
    pending:  all.filter(o => o.status === 'pending').length,
    filled:   all.filter(o => o.status === 'filled').length,
    cow:      all.filter(o => o.cowMatched).length,
    surplus:  '$' + stats.totalSurplus.toFixed(4),
    swaps:    stats.totalSwaps,
    uptime:   Math.floor((Date.now() - stats.startTime) / 1000) + 's',
  });
});

// ── QUOTE ENGINE ────────────────────────────────────────────
async function getBestQuote(sellToken, buyToken, amtIn) {
  const fA = sellToken.toLowerCase() === NATIVE.toLowerCase() ? WETH_ARB : sellToken;
  const tA = buyToken.toLowerCase()  === NATIVE.toLowerCase() ? WETH_ARB : buyToken;
  const buyDec = getDec(buyToken);

  const tasks = [
    // Uniswap V3 — all fee tiers
    (async () => {
      const q = new ethers.Contract(QUOTER, QUOTER_ABI, provider);
      let best = null;
      await Promise.allSettled([100,500,3000,10000].map(async fee => {
        try {
          const r = await q.callStatic.quoteExactInputSingle({ tokenIn:fA, tokenOut:tA, amountIn:amtIn, fee, sqrtPriceLimitX96:0 });
          if (!best || r.amountOut.gt(best.out)) best = { out: r.amountOut, source: 'Uni '+(fee===100?'0.01':fee===500?'0.05':fee===3000?'0.30':'1.00')+'%', type: 'uni', fee };
        } catch(e){}
      }));
      return best;
    })(),
    // KyberSwap
    (async () => {
      const r = await fetch(
        `https://aggregator-api.kyberswap.com/arbitrum/api/v1/routes?tokenIn=${sellToken}&tokenOut=${buyToken}&amountIn=${amtIn.toString()}`,
        { headers: { 'x-client-id': 'mrbflood' }, timeout: 5000 }
      );
      const d = await r.json();
      if (!d.data || !d.data.routeSummary) throw new Error('no route');
      return { out: ethers.BigNumber.from(d.data.routeSummary.amountOut), source: 'KyberSwap', type: 'ky', routeSummary: d.data.routeSummary };
    })(),
    // OpenOcean
    (async () => {
      const sellDec = getDec(sellToken);
      const amt = parseFloat(ethers.utils.formatUnits(amtIn, sellDec));
      const r = await fetch(
        `https://open-api.openocean.finance/v3/arbitrum/quote?inTokenAddress=${sellToken}&outTokenAddress=${buyToken}&amount=${amt}&gasPrice=400000000&slippage=1`,
        { timeout: 5000 }
      );
      const d = await r.json();
      if (!d.data || !d.data.outAmount) throw new Error('no route');
      return { out: ethers.BigNumber.from(d.data.outAmount), source: 'OpenOcean', type: 'oo' };
    })(),
  ];

  const results = await Promise.allSettled(tasks);
  const quotes  = results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value).sort((a,b) => b.out.gt(a.out) ? 1 : -1);
  if (!quotes.length) throw new Error('No liquidity for this pair');

  const best   = quotes[0];
  const second = quotes.find(q => q !== best && q.out.gte(best.out.mul(95).div(100)));

  return {
    best:   { out: best.out.toString(), source: best.source, type: best.type, fee: best.fee },
    second: second ? { out: second.out.toString(), source: second.source } : null,
    allQuotes: quotes.map(q => ({ source: q.source, out: q.out.toString() })),
  };
}

// ── COW MATCHING ────────────────────────────────────────────
async function tryCow(newOrder) {
  const now = Math.floor(Date.now() / 1000);
  for (const existing of orders.values()) {
    if (existing.uid === newOrder.uid) continue;
    if (existing.status !== 'pending') continue;
    if (existing.deadline <= now) continue;
    // Opposite direction check
    if (existing.sellToken.toLowerCase() !== newOrder.buyToken.toLowerCase()) continue;
    if (existing.buyToken.toLowerCase()  !== newOrder.sellToken.toLowerCase()) continue;
    // Can they satisfy each other?
    const exSell   = ethers.BigNumber.from(existing.sellAmount);
    const exMinBuy = ethers.BigNumber.from(existing.minBuyAmount);
    const newSell  = ethers.BigNumber.from(newOrder.sellAmount);
    const newMinBuy= ethers.BigNumber.from(newOrder.minBuyAmount);
    if (!exSell.gte(newMinBuy) || !newSell.gte(exMinBuy)) continue;

    console.log('[CoW MATCH]', newOrder.uid.slice(0,10), '<->', existing.uid.slice(0,10));
    // Mark both matched
    newOrder.status   = 'matched'; newOrder.cowMatched  = true;
    existing.status   = 'matched'; existing.cowMatched  = true;

    // Execute on-chain if solver available
    if (solver) {
      setTimeout(() => executeCow(newOrder, existing), 1000);
    }
    return true;
  }
  return false;
}

async function executeCow(orderA, orderB) {
  try {
    // Direct token swap between users (no DEX needed!)
    const tokenA = new ethers.Contract(orderA.sellToken, ['function transferFrom(address,address,uint256) returns (bool)'], solver);
    const tokenB = new ethers.Contract(orderB.sellToken, ['function transferFrom(address,address,uint256) returns (bool)'], solver);
    const fd = await provider.getFeeData();
    const gas = { maxFeePerGas: fd.maxFeePerGas, maxPriorityFeePerGas: fd.maxPriorityFeePerGas || '1000000', gasLimit: 200000 };

    await tokenA.transferFrom(orderA.from, orderB.from, orderA.sellAmount, gas);
    await tokenB.transferFrom(orderB.from, orderA.from, orderB.sellAmount, gas);

    orderA.status = 'filled'; orderA.filledAt = Date.now();
    orderB.status = 'filled'; orderB.filledAt = Date.now();
    stats.totalSwaps += 2;
    console.log('[CoW FILLED]', orderA.uid.slice(0,10), orderB.uid.slice(0,10));
  } catch(e) {
    console.error('[CoW exec]', e.message);
    orderA.status = 'pending'; orderB.status = 'pending';
    if (!batchTimer) batchTimer = setTimeout(runBatch, BATCH_MS);
  }
}

// ── BATCH SOLVER ─────────────────────────────────────────────
async function runBatch() {
  batchTimer = null;
  const now     = Math.floor(Date.now() / 1000);
  const pending = [...orders.values()].filter(o => o.status === 'pending' && o.deadline > now);
  // Expire old
  for (const o of orders.values()) { if (o.status === 'pending' && o.deadline <= now) o.status = 'expired'; }

  if (!pending.length) { console.log('[BATCH] No pending orders'); return; }
  console.log('[BATCH] Processing', pending.length, 'orders...');

  for (const order of pending) {
    if (order.status !== 'pending') continue;
    try { await solveOrder(order); }
    catch (e) { console.error('[BATCH order]', e.message); }
    await new Promise(r => setTimeout(r, 1000));
  }
  const stillPending = [...orders.values()].filter(o => o.status === 'pending');
  if (stillPending.length) batchTimer = setTimeout(runBatch, BATCH_MS);
}

async function solveOrder(order) {
  if (!solver) { console.log('[SOLVE] No SOLVER_PK set'); return; }

  const amtIn  = ethers.BigNumber.from(order.sellAmount);
  const minOut = ethers.BigNumber.from(order.minBuyAmount);
  const fA = order.sellToken.toLowerCase() === NATIVE.toLowerCase() ? WETH_ARB : order.sellToken;
  const tA = order.buyToken.toLowerCase()  === NATIVE.toLowerCase() ? WETH_ARB : order.buyToken;

  const { best } = await getBestQuote(order.sellToken, order.buyToken, amtIn);
  const bestOut  = ethers.BigNumber.from(best.out);
  if (bestOut.lt(minOut)) { console.log('[SOLVE] No profitable route'); return; }

  const surplus    = bestOut.sub(minOut);
  const buyDec     = getDec(order.buyToken);
  const surplusAmt = parseFloat(ethers.utils.formatUnits(surplus, buyDec));
  console.log('[SOLVE]', order.uid.slice(0,10), best.source, 'surplus:', surplusAmt);

  const fd     = await provider.getFeeData();
  let maxFee   = fd.maxFeePerGas || ethers.utils.parseUnits('0.1','gwei');
  const cap    = ethers.utils.parseUnits('1','gwei');
  if (maxFee.gt(cap)) maxFee = cap;
  const maxPrio = fd.maxPriorityFeePerGas || ethers.BigNumber.from('1000000');

  let tx;
  if (best.type === 'uni' && best.fee) {
    const router = new ethers.Contract(ROUTER, ROUTER_ABI, solver);
    tx = await router.exactInputSingle({
      tokenIn: fA, tokenOut: tA, fee: best.fee,
      recipient: order.from, // user gets ALL output including surplus
      amountIn: amtIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0
    }, { gasLimit: 350000, maxFeePerGas: maxFee, maxPriorityFeePerGas: maxPrio });
  } else if (best.type === 'ky' && best.routeSummary) {
    const br  = await fetch('https://aggregator-api.kyberswap.com/arbitrum/api/v1/route/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-client-id': 'mrbflood' },
      body: JSON.stringify({ routeSummary: best.routeSummary, sender: solver.address, recipient: order.from, slippageTolerance: 50, deadline: order.deadline })
    });
    const bd = await br.json();
    if (!bd.data || !bd.data.data) throw new Error('KY build failed');
    tx = await solver.sendTransaction({ to: ROUTER_KY, data: bd.data.data, gasLimit: 500000, maxFeePerGas: maxFee, maxPriorityFeePerGas: maxPrio });
  } else {
    throw new Error('No execution path');
  }

  const rec = await tx.wait();
  if (rec.status === 0) throw new Error('Reverted');

  const surpUSD = surplusAmt * (await getPrice(order.buyToken));
  order.status            = 'filled';
  order.txHash            = tx.hash;
  order.executedBuyAmount = bestOut.toString();
  order.surplusUSD        = surpUSD;
  order.filledAt          = Date.now();
  stats.totalSurplus     += surpUSD;
  stats.totalSwaps++;
  console.log('[FILLED]', order.uid.slice(0,10), 'surplus $'+surpUSD.toFixed(4), tx.hash);
}

// ── Price helper ─────────────────────────────────────────────
const priceCache = {};
async function getPrice(addr) {
  try {
    const cached = priceCache[addr];
    if (cached && Date.now()-cached.ts < 60000) return cached.p;
    const stables = ['0xaf88d065','0xfd086bc7','0xda100090'];
    if (stables.some(s => addr.toLowerCase().startsWith(s))) return 1;
    const r = await fetch('https://api.coingecko.com/api/v3/simple/token_price/arbitrum-one?contract_addresses='+addr+'&vs_currencies=usd', { timeout: 3000 });
    const d = await r.json();
    const p = Object.values(d)[0]?.usd || 0;
    priceCache[addr] = { p, ts: Date.now() };
    return p;
  } catch(e) { return 0; }
}

// ── Start ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n🌊 MrBruh FloodSwap Server');
  console.log('   Port:  ', PORT);
  console.log('   Solver:', solver ? solver.address : 'NOT SET — add SOLVER_PK variable');
  console.log('   Batch: every', BATCH_MS/1000, 'seconds\n');
});
