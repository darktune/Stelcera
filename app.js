// ============================================================
// STELCERA — Trading Engine
// ============================================================
'use strict';

const gridCanvas = document.getElementById('gridCanvas');
const chartCanvas = document.getElementById('chartCanvas');
const gCtx = gridCanvas.getContext('2d');
const ctx  = chartCanvas.getContext('2d');
const wrapper = document.getElementById('chartWrapper');


// ---- CHART STATE ----
let currentTool = 'none';
let drawings = {};
let isDrawingTool = false;
let currentDrawing = null;

let blocks      = [];
let blockSize   = 40;
let cols = 0, rows = 0;
let offsetX = 0, offsetY = 0;
let isDragging  = false;
let dragStart   = { x: 0, y: 0 };
let dragOffset  = { x: 0, y: 0 };
let simInterval = null;
let simRunning  = false;
let currentCol  = 0;

// ---- LEVEL SYSTEM ----
let currentLevel    = 0;
let basePrice       = null;
let STEP_SIZE       = 10;
let cameraFollowing = true;

// ---- CURRENT ASSET ----
let currentPair      = 'BTC/USDT';
let currentWs        = null;
let wsReconnectTimer = null;
let livePrice        = null;
let liveBlockTimer   = null;
let wsActive         = false;
let noDataTimer      = null;
const iconUrlCache   = new Map();
const iconFailureSet = new Set();

// ---- TRADE SETTINGS ----
let stopLossEnabled = false;
let trailEnabled    = false;
let trailBlockCount = 3;
let lossPercent     = 0.001;
let speed           = 600;

// ---- BALANCE / MODE ----
let tradeMode   = 'demo';
let demoBalance = 10000;
let liveBalance = 0;

// ---- TRADE STATE ----
let activeTrade  = null;
let activeTrades = [];
let tradeHistory = [];
let pnl          = 0;
let currentStopLoss = 0;
let currentStopRow  = null;
let isDraggingStop  = false;

// ---- MISC ----
let popupBlock        = null;
let hoveredBlock      = null;
let pendingTradeType  = null;
let pendingTradeBlock = null;
let blockIcons        = [];
let demoTrades        = [];
let liveTrades        = [];
let notifTimer        = null;

// Theme initialization handled by switcher
// document.body.className = 'theme-black';

// ============================================================
// WINDOW BRIDGE — Critical for backend_bridge.js communication
// Variables declared with 'let' in strict mode are NOT on window.
// backend_bridge.js writes window.blocks, window.offsetX, etc.
// Without this bridge, those writes go to separate window props
// that the rendering loop never reads — causing a blank chart.
// ============================================================
Object.defineProperties(window, {
  blocks:           { get() { return blocks; },          set(v) { blocks = v; } },
  blockSize:        { get() { return blockSize; },       set(v) { blockSize = v; } },
  offsetX:          { get() { return offsetX; },         set(v) { offsetX = v; } },
  offsetY:          { get() { return offsetY; },         set(v) { offsetY = v; } },
  currentLevel:     { get() { return currentLevel; },    set(v) { currentLevel = v; } },
  currentCol:       { get() { return currentCol; },      set(v) { currentCol = v; } },
  cameraFollowing:  { get() { return cameraFollowing; }, set(v) { cameraFollowing = v; } },
  livePrice:        { get() { return livePrice; },       set(v) { livePrice = v; } },
  currentPair:      { get() { return currentPair; },     set(v) { currentPair = v; } },
  demoBalance:      { get() { return demoBalance; },     set(v) { demoBalance = v; } },
  liveBalance:      { get() { return liveBalance; },     set(v) { liveBalance = v; } },
  tradeMode:        { get() { return tradeMode; },       set(v) { tradeMode = v; } },
  activeTrade:      { get() { return activeTrade; },     set(v) { activeTrade = v; } },
  activeTrades:     { get() { return activeTrades; },    set(v) { activeTrades = v; } },
  tradeHistory:     { get() { return tradeHistory; },    set(v) { tradeHistory = v; } },
  currentStopLoss:  { get() { return currentStopLoss; }, set(v) { currentStopLoss = v; } },
  currentStopRow:   { get() { return currentStopRow; },  set(v) { currentStopRow = v; } },
  chartCanvas:      { get() { return chartCanvas; } },
  gridCanvas:       { get() { return gridCanvas; } },
  STEP_SIZE:        { get() { return STEP_SIZE; },       set(v) { STEP_SIZE = v; } },
});

// ---- PRICE ENGINE STATE ----
// lastPrice = price at which the last block was created
// Only updatePrice() creates blocks. Nothing else.
let lastPrice = null;

const KNOWN_QUOTES = ['USDT', 'USDC', 'BUSD', 'FDUSD', 'TUSD', 'USD', 'BTC', 'ETH', 'BNB', 'EUR', 'TRY'];

function normalizePairLabel(pair) {
  if (!pair) return 'BTC/USDT';
  const s = String(pair).toUpperCase();
  if (s.includes('/')) return s;
  for (const quote of KNOWN_QUOTES) {
    if (s.endsWith(quote) && s.length > quote.length) {
      return s.slice(0, -quote.length) + '/' + quote;
    }
  }
  return s;
}

function splitPairSymbols(pair) {
  const normalized = normalizePairLabel(pair);
  if (normalized.includes('/')) {
    const [base, quote] = normalized.split('/');
    return { base, quote: quote || 'USDT' };
  }

  for (const quote of KNOWN_QUOTES) {
    if (normalized.endsWith(quote) && normalized.length > quote.length) {
      return { base: normalized.slice(0, -quote.length), quote };
    }
  }

  return { base: normalized, quote: 'USDT' };
}

function buildFallbackIcon(symbol) {
  const text = encodeURIComponent((symbol || '?').slice(0, 4).toUpperCase());
  return `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="32" fill="%230f0f0f"/><text x="50%25" y="50%25" dominant-baseline="middle" text-anchor="middle" font-family="monospace" font-size="22" fill="%23ffe600">${text}</text></svg>`;
}

function getAssetIconUrl(symbol) {
  const normalized = String(symbol || '').trim().toLowerCase();
  if (!normalized) return buildFallbackIcon('?');
  if (iconFailureSet.has(normalized)) return buildFallbackIcon(normalized);
  if (!iconUrlCache.has(normalized)) {
    iconUrlCache.set(normalized, `https://cryptoicons.org/api/icon/${normalized}/64`);
  }
  return iconUrlCache.get(normalized);
}

function setAssetIconImage(img, symbol) {
  if (!img) return;
  const normalized = String(symbol || '').trim().toLowerCase();
  img.alt = `${String(symbol || 'asset').toUpperCase()} icon`;
  img.referrerPolicy = 'no-referrer';
  img.onerror = () => {
    if (normalized) iconFailureSet.add(normalized);
    img.onerror = null;
    img.src = '/fallback.svg';
  };
  img.src = getAssetIconUrl(symbol);
}

function updateAssetBadge(pair = currentPair) {
  const { base, quote } = splitPairSymbols(pair);
  const textEl = document.getElementById('assetBadgeText');
  if (textEl) textEl.textContent = `${base} / ${quote}`;
  
  const baseImg = document.getElementById('assetBaseIcon');
  const quoteImg = document.getElementById('assetQuoteIcon');
  
  if (baseImg) setAssetIconImage(baseImg, base);
  if (quoteImg) setAssetIconImage(quoteImg, quote);
}


// ============================================================
// BALANCE
// ============================================================
function getBalance()    { return tradeMode === 'demo' ? demoBalance : liveBalance; }
function setBalance(val) {
  if (tradeMode === 'demo') demoBalance = Math.max(0, val);
  else                      liveBalance = Math.max(0, val);
  refreshBalanceDisplay();
}
function refreshBalanceDisplay() {
  const el = document.getElementById('balanceDisplay');
  if (!el) return;
  const cashBal = (tradeMode === 'demo' ? demoBalance : liveBalance) || 0;
  let openMargin = 0;
  let unrealizedPL = 0;
  const price = getCurrentPrice();
  if (price && activeTrades) {
    activeTrades.forEach(t => {
      if (!t.isOpen || t.amount <= 0) return;
      const pl = t.type === 'buy'
        ? (price - t.entryPrice) * (t.amount / t.entryPrice)
        : (t.entryPrice - price) * (t.amount / t.entryPrice);
      openMargin += t.amount;
      unrealizedPL += pl;
    });
  }
  const equity = cashBal + openMargin + unrealizedPL;
  const mode = (tradeMode || 'demo').toUpperCase();
  el.textContent = `${mode}: $${equity.toFixed(2)}`;
  el.style.color = unrealizedPL >= 0 ? 'var(--green)' : 'var(--red)';
}

// ============================================================
// P&L
// ============================================================
function calcPnl(trade, price) {
  if (!trade || !trade.isOpen || !price || isNaN(price) || trade.amount <= 0) return;
  const pl = trade.type === 'buy'
    ? (price - trade.entryPrice) * (trade.amount / trade.entryPrice)
    : (trade.entryPrice - price) * (trade.amount / trade.entryPrice);
  trade.profitLoss        = pl;
  trade.currentValue      = trade.amount + pl;
  trade.profitLossPercent = (pl / trade.amount) * 100;
}

// ============================================================
// SETTLE TRADE
// ============================================================
function settleTrade(trade, reason) {
  if (!trade || !trade.isOpen) return;
  calcPnl(trade, getCurrentPrice());
  const finalReturn = trade.currentValue;
  setBalance(getBalance() + finalReturn);
  trade.isOpen = false;
  const plPct = trade.profitLossPercent || 0;
  const record = { type: trade.type.toUpperCase(), reason, pnl: plPct, amount: trade.amount, time: new Date().toLocaleTimeString(), mode: trade.mode };
  tradeHistory.unshift(record);
  renderHistory();
  pnl += plPct;
  updatePnl();
  removeTradeMarker(trade);
  if (trade.entryBlock) {
    blockIcons = blockIcons.filter(i => !(i.col === trade.entryBlock.col && i.row === trade.entryBlock.row));
    if (trade.entryBlock.state === 'yellow') trade.entryBlock.state = trade.entryBlock.type;
  }
  activeTrades = activeTrades.filter(t => t.id !== trade.id);
  if (activeTrade && activeTrade.tradeId === trade.id) {
    activeTrade = null;
    const _ael = document.getElementById('activeTrade');
    if (_ael) _ael.textContent = 'NONE';
    const _tse = document.getElementById('tradeStatus');
    if (_tse) { _tse.textContent = 'NO TRADE'; _tse.className = 'trade-status'; }
  }
  showNotification(`${trade.type.toUpperCase()} CLOSED | ${reason} | $${finalReturn.toFixed(2)} | ${plPct >= 0 ? '+' : ''}${plPct.toFixed(3)}%`, plPct >= 0 ? 'green' : 'red');
  if (window.ExchangeModule) window.ExchangeModule.persistRecord(record);
  refreshCloseButtons();
  drawChart();
}

// ============================================================
// CAMERA
// ============================================================
function centerCamera() {
  if (!cameraFollowing) return;
  const w = chartCanvas.width || wrapper.clientWidth || 1200;
  const h = chartCanvas.height || wrapper.clientHeight || 600;
  offsetY = (currentLevel * blockSize) - Math.floor(h / 2) + Math.floor(blockSize / 2);
  drawGrid();
  drawChart();
}

function centerCameraX() {
  if (!cameraFollowing) return;
  const w = chartCanvas.width || wrapper.clientWidth || 1200;
  offsetX = Math.max(0, currentCol * blockSize - w + blockSize * 6);
  drawGrid();
  drawChart();
}

// ============================================================
// RESIZE
// ============================================================
function resize() {
  const w = wrapper.clientWidth, h = wrapper.clientHeight;
  gridCanvas.width  = w; gridCanvas.height = h;
  chartCanvas.width = w; chartCanvas.height = h;
  cols = Math.ceil(w / blockSize) + 4;
  rows = Math.ceil(h / blockSize) + 4;
  centerCamera();
  centerCameraX();
  drawGrid();
  drawChart();
}

// ============================================================
// GRID DRAW
// ============================================================
function drawGrid() {
  const w = gridCanvas.width, h = gridCanvas.height;
  gCtx.clearRect(0, 0, w, h);
  const computedStyles = getComputedStyle(document.body);
  gCtx.fillStyle = computedStyles.getPropertyValue('--bg').trim() || '#131722';
  gCtx.fillRect(0, 0, w, h);
  const ox = ((offsetX % blockSize) + blockSize) % blockSize;
  const oy = ((offsetY % blockSize) + blockSize) % blockSize;
  const gridColor = computedStyles.getPropertyValue('--grid').trim() || 'rgba(255,255,255,0.06)';
  const majorGridColor = computedStyles.getPropertyValue('--major-grid').trim() || 'rgba(255,255,255,0.1)';
  gCtx.strokeStyle = gridColor; gCtx.lineWidth = 1;
  for (let x = -ox; x < w + blockSize; x += blockSize)
    for (let y = -oy; y < h + blockSize; y += blockSize)
      gCtx.strokeRect(Math.floor(x)+0.5, Math.floor(y)+0.5, blockSize, blockSize);
  gCtx.save();
  gCtx.strokeStyle = majorGridColor; gCtx.lineWidth = 1;
  for (let x = -ox; x < w + blockSize; x += blockSize * 5) {
    gCtx.beginPath(); gCtx.moveTo(Math.floor(x)+0.5,0); gCtx.lineTo(Math.floor(x)+0.5,h); gCtx.stroke();
  }
  for (let y = -oy; y < h + blockSize; y += blockSize * 5) {
    gCtx.beginPath(); gCtx.moveTo(0,Math.floor(y)+0.5); gCtx.lineTo(w,Math.floor(y)+0.5); gCtx.stroke();
  }
  gCtx.restore();
}

// ============================================================
// CHART DRAW
// sx = col * blockSize - offsetX
// sy = row * blockSize - offsetY
// ============================================================
function drawChart() {
  const w = chartCanvas.width, h = chartCanvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);

  if (window.chartType === 'candles') {
    // ---- CANDLESTICK MODE ----
    blocks.forEach((b, idx) => {
      const cx = Math.floor(b.col * blockSize - offsetX + blockSize / 2);
      if (cx + blockSize < 0 || cx - blockSize > w) return;
      
      const close = b.price || 0;
      const open = idx > 0 ? (blocks[idx-1].price || close) : close;
      const wickHigh = Math.max(open, close) + (STEP_SIZE * 0.4);
      const wickLow  = Math.min(open, close) - (STEP_SIZE * 0.4);
      
      // Map prices to Y coordinates via row system
      const yClose = Math.floor(b.row * blockSize - offsetY + blockSize / 2);
      const prevRow = idx > 0 ? blocks[idx-1].row : b.row;
      const yOpen  = Math.floor(prevRow * blockSize - offsetY + blockSize / 2);
      const yHigh  = Math.min(yOpen, yClose) - Math.floor(blockSize * 0.35);
      const yLow   = Math.max(yOpen, yClose) + Math.floor(blockSize * 0.35);
      
      const bullish = close >= open;
      const color = bullish ? '#089981' : '#f23645';
      const isHovered = (b === hoveredBlock);
      
      ctx.save();
      ctx.strokeStyle = isHovered ? '#FFD700' : color;
      ctx.fillStyle = color;
      ctx.shadowColor = isHovered ? '#FFD700' : color;
      ctx.shadowBlur = isHovered ? 12 : 4;
      ctx.lineWidth = 1.5;
      
      // Wick
      ctx.beginPath();
      ctx.moveTo(cx, yHigh);
      ctx.lineTo(cx, yLow);
      ctx.stroke();
      
      // Body
      const bodyW = Math.max(4, blockSize - 8);
      const bodyTop = Math.min(yOpen, yClose);
      const bodyH = Math.max(2, Math.abs(yOpen - yClose));
      if (bullish) {
        ctx.fillRect(cx - bodyW/2, bodyTop, bodyW, bodyH);
      } else {
        ctx.fillRect(cx - bodyW/2, bodyTop, bodyW, bodyH);
      }
      ctx.strokeRect(cx - bodyW/2, bodyTop, bodyW, bodyH);
      
      // Yellow highlight for trade entry
      if (b.state === 'yellow') {
        ctx.strokeStyle = '#FFD700'; ctx.lineWidth = 2.5; ctx.shadowColor = '#FFD700'; ctx.shadowBlur = 15;
        ctx.strokeRect(cx - bodyW/2 - 2, bodyTop - 2, bodyW + 4, bodyH + 4);
      }
      ctx.restore();
    });
  } else {
    // ---- SIGNAL BLOCKS MODE (default) ----
    blocks.forEach(b => {
      const sx = Math.floor(b.col * blockSize - offsetX);
      const sy = Math.floor(b.row * blockSize - offsetY);
      if (sx + blockSize < 0 || sx > w || sy + blockSize < 0 || sy > h) return;
      
      let fill, stroke, isHovered = (b === hoveredBlock);
      let shadowColor, shadowBlur = 10;
      
      if (b.state === 'yellow') {
        fill = 'rgba(255, 215, 0, 0.95)';
        stroke = '#ffe600';
        shadowColor = '#FFD700';
        shadowBlur = 15;
      } else if (b.type === 'green') {
        fill = 'rgba(8, 153, 129, 0.85)';
        stroke = '#089981';
        shadowColor = '#089981';
        shadowBlur = 12;
      } else {
        fill = 'rgba(242, 54, 69, 0.85)';
        stroke = '#f23645';
        shadowColor = '#f23645';
        shadowBlur = 12;
      }
      
      if (isHovered && b.state !== 'yellow') {
        fill = b.type === 'green' ? 'rgba(8, 153, 129, 0.95)' : 'rgba(242, 54, 69, 0.95)';
        stroke = '#FFD700';
        shadowColor = '#FFD700';
        shadowBlur = 18;
      }
      
      ctx.save();
      ctx.shadowColor = shadowColor;
      ctx.shadowBlur = shadowBlur;
      ctx.fillStyle = fill;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = isHovered ? 2.5 : 2;
      
      ctx.beginPath();
      ctx.roundRect(sx + 2, sy + 2, blockSize - 4, blockSize - 4, 6);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    });
  }

  if (currentStopRow !== null) {
    const lineY = Math.floor(currentStopRow * blockSize - offsetY + blockSize / 2);
    ctx.save();
    
    // Draw the glowing line
    ctx.strokeStyle = '#2962ff';
    ctx.lineWidth = 2;
    ctx.shadowColor = '#2962ff';
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.moveTo(0, lineY);
    ctx.lineTo(w, lineY);
    ctx.stroke();
    
    // Draw a premium label pill
    ctx.shadowBlur = 0; // Turn off glow for text block for sharp readability
    const label = 'STOP LOSS';
    ctx.font = 'bold 10px "Inter", -apple-system, sans-serif';
    const textWidth = ctx.measureText(label).width;
    const pillW = textWidth + 16;
    const pillH = 18;
    const pillX = 12;
    const pillY = lineY - Math.floor(pillH / 2);
    
    ctx.fillStyle = '#2962ff';
    ctx.beginPath();
    ctx.roundRect(pillX, pillY, pillW, pillH, 4);
    ctx.fill();
    
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, pillX + pillW / 2, pillY + pillH / 2);
    
    ctx.restore();
  }

  if (blocks.length > 0) {
    const last = blocks[blocks.length - 1];
    const lineY = Math.floor(last.row * blockSize - offsetY + blockSize / 2);
    ctx.save();
    ctx.strokeStyle = '#ffffff44'; ctx.lineWidth = 1;
    ctx.setLineDash([4, 6]);
    ctx.beginPath(); ctx.moveTo(0, lineY); ctx.lineTo(w, lineY); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  blockIcons.forEach(icon => {
    const sx = Math.floor(icon.col * blockSize - offsetX);
    const sy = Math.floor(icon.row * blockSize - offsetY);
    if (sx + blockSize < 0 || sx > w || sy + blockSize < 0 || sy > h) return;
    const color = icon.type === 'buy' ? '#00ff88' : '#ff2244';
    ctx.save();
    ctx.shadowColor = color; ctx.shadowBlur = 8;
    ctx.fillStyle = color;
    ctx.font = `bold ${Math.max(10, Math.floor(blockSize * 0.35))}px Share Tech Mono, monospace`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(icon.type === 'buy' ? '\u25B2' : '\u25BC', sx + blockSize/2, sy + blockSize/2);

    ctx.restore();
  });

  // ---- RENDER DRAWINGS ----
  if (currentPair && drawings[currentPair]) {
    drawings[currentPair].forEach(d => {
      ctx.save();
      ctx.strokeStyle = '#00e5ff'; ctx.lineWidth = 2; ctx.shadowColor = '#00e5ff'; ctx.shadowBlur = 5;
      
      if (d.type === 'trend' && d.points.length === 2) {
        ctx.beginPath();
        ctx.moveTo(d.points[0].x - offsetX, d.points[0].y - offsetY);
        ctx.lineTo(d.points[1].x - offsetX, d.points[1].y - offsetY);
        ctx.stroke();
      } else if (d.type === 'pen' && d.points.length > 1) {
        ctx.beginPath();
        ctx.moveTo(d.points[0].x - offsetX, d.points[0].y - offsetY);
        for(let i=1; i<d.points.length; i++) ctx.lineTo(d.points[i].x - offsetX, d.points[i].y - offsetY);
        ctx.stroke();
      } else if (d.type === 'hline') {
        ctx.beginPath(); ctx.moveTo(0, d.y - offsetY); ctx.lineTo(w, d.y - offsetY); ctx.stroke();
      } else if (d.type === 'vline') {
        ctx.beginPath(); ctx.moveTo(d.x - offsetX, 0); ctx.lineTo(d.x - offsetX, h); ctx.stroke();
      } else if (d.type === 'predictor' && d.points.length > 1) {
        ctx.strokeStyle = '#ff00ff'; ctx.shadowColor = '#ff00ff'; ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(d.points[0].x - offsetX, d.points[0].y - offsetY);
        for(let i=1; i<d.points.length; i++) ctx.lineTo(d.points[i].x - offsetX, d.points[i].y - offsetY);
        ctx.stroke();
      } else if (d.type === 'fib' && d.points.length === 2) {
        const y1 = d.points[0].y - offsetY, y2 = d.points[1].y - offsetY;
        const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0];
        const colors = ['#f23645','#ff9800','#4caf50','#00e5ff','#FFD700','#e040fb','#9c27b0'];
        levels.forEach((lvl, li) => {
          const yLvl = y2 + lvl * (y1 - y2);
          ctx.strokeStyle = colors[li]; ctx.lineWidth = 1; ctx.globalAlpha = 0.75;
          ctx.beginPath(); ctx.moveTo(0, yLvl); ctx.lineTo(w, yLvl); ctx.stroke();
          ctx.globalAlpha = 1; ctx.fillStyle = colors[li]; ctx.font = 'bold 9px monospace';
          ctx.fillText(`${(lvl*100).toFixed(1)}%`, w - 60, yLvl - 3);
        });
      } else if (d.type === 'rect' && d.points.length === 2) {
        const rx1 = d.points[0].x - offsetX, ry1 = d.points[0].y - offsetY;
        const rx2 = d.points[1].x - offsetX, ry2 = d.points[1].y - offsetY;
        ctx.fillStyle = 'rgba(255, 215, 0, 0.08)'; ctx.strokeStyle = '#FFD700'; ctx.lineWidth = 1.5;
        ctx.fillRect(rx1, ry1, rx2-rx1, ry2-ry1); ctx.strokeRect(rx1, ry1, rx2-rx1, ry2-ry1);
      }
      ctx.restore();
    });
  }
  
  if (currentDrawing) {
    ctx.save();
    ctx.strokeStyle = currentTool === 'predictor' ? '#ff00ff' : '#00e5ff'; 
    ctx.lineWidth = 2; ctx.shadowColor = currentTool === 'predictor' ? '#ff00ff' : '#00e5ff'; ctx.shadowBlur = 5;
    if (currentTool === 'predictor') ctx.setLineDash([5, 5]);
    
    if (currentDrawing.type === 'trend' && currentDrawing.points.length === 2) {
      ctx.beginPath();
      ctx.moveTo(currentDrawing.points[0].x - offsetX, currentDrawing.points[0].y - offsetY);
      ctx.lineTo(currentDrawing.points[1].x - offsetX, currentDrawing.points[1].y - offsetY);
      ctx.stroke();
    } else if ((currentDrawing.type === 'pen' || currentDrawing.type === 'predictor') && currentDrawing.points.length > 1) {
      ctx.beginPath();
      ctx.moveTo(currentDrawing.points[0].x - offsetX, currentDrawing.points[0].y - offsetY);
      for(let i=1; i<currentDrawing.points.length; i++) ctx.lineTo(currentDrawing.points[i].x - offsetX, currentDrawing.points[i].y - offsetY);
      ctx.stroke();
    } else if (currentDrawing.type === 'fib' && currentDrawing.points.length === 2) {
      const fy1 = currentDrawing.points[0].y - offsetY, fy2 = currentDrawing.points[1].y - offsetY;
      [0,0.236,0.382,0.5,0.618,0.786,1].forEach((lvl, li) => {
        const yy = fy2 + lvl * (fy1 - fy2);
        const clr = ['#f23645','#ff9800','#4caf50','#00e5ff','#FFD700','#e040fb','#9c27b0'][li];
        ctx.strokeStyle = clr; ctx.lineWidth = 1; ctx.globalAlpha = 0.6;
        ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(w, yy); ctx.stroke();
        ctx.globalAlpha = 1; ctx.fillStyle = clr; ctx.font = 'bold 9px monospace';
        ctx.fillText(`${(lvl*100).toFixed(1)}%`, w - 60, yy - 3);
      });
    } else if (currentDrawing.type === 'rect' && currentDrawing.points.length === 2) {
      const rx1 = currentDrawing.points[0].x - offsetX, ry1 = currentDrawing.points[0].y - offsetY;
      const rx2 = currentDrawing.points[1].x - offsetX, ry2 = currentDrawing.points[1].y - offsetY;
      ctx.fillStyle = 'rgba(255, 215, 0, 0.08)'; ctx.strokeStyle = '#FFD700'; ctx.lineWidth = 1.5;
      ctx.fillRect(rx1, ry1, rx2-rx1, ry2-ry1); ctx.strokeRect(rx1, ry1, rx2-rx1, ry2-ry1);
    }
    ctx.restore();
  }
  // -------------------------

  updateTradeMarkers();

}

// PRICE ENGINE REMOVED - LOGIC MOVED TO BACKEND
function generateBlock() {}

// ============================================================
// BACKEND-DRIVEN CHART STUBS
// ============================================================
function resetChartForAsset() {}
function connectPairWS(p) {
  if (!p) return;
  window.currentPair = p;
  const priceEl = document.getElementById('priceDisplay');
  if (priceEl) priceEl.textContent = `${normalizePairLabel(p)}: ${livePrice ? `$${Number(livePrice).toFixed(2)}` : '--'}`;
}
function startLiveBlockEmitter() {}
function stopLiveBlockEmitter() { if (liveBlockTimer) { clearInterval(liveBlockTimer); liveBlockTimer = null; } }
function activateFallbackSim() {}
function setWsStatus(s) {
  const el = document.getElementById('wsStatus');
  if (!el) return;
  const m = { connected:['CONNECTED','ws-status connected'], disconnected:['DISCONNECTED','ws-status disconnected'], sim:['SIMULATION','ws-status sim'] };
  const [t,c] = m[s] || m.disconnected;
  el.textContent = t; el.className = c;
}
function connectBinanceWS() {}

// TRAIL & STOP REMOVED - LOGIC MOVED TO BACKEND
function checkTrailAndStop(newBlock) {
  // Handled by backend
}

function closeTradeById(tradeId, reason) {
  if (window.BackendBridge && window.BackendBridge.isConnected && window.BackendBridge.isConnected()) {
      window.BackendBridge.closeTrade(tradeId);
  } else {
      // Local demo close
      const trade = activeTrades.find(t => t.id === tradeId && t.isOpen);
      if (trade) settleTrade(trade, reason || 'MANUAL CLOSE');
  }
}

function openTrade(type, block, tradeAmount) {
  const stopOffset = type === 'buy' ? 3 : -3;
  const stopRow    = block.row + stopOffset;
  const ep         = getCurrentPrice();
  const tradeId    = Date.now();
  const amt        = tradeAmount || 0;
  if (amt > 0) setBalance(getBalance() - amt);
  const tradeObj   = { id: tradeId, type, entryPrice: ep, amount: amt, currentValue: amt, profitLoss: 0, profitLossPercent: 0, stopRow, isOpen: true, mode: tradeMode, timestamp: tradeId, entryBlock: block, trailBlocks: trailBlockCount, markerEl: null };
  activeTrades.push(tradeObj);
  activeTrade = { type, entryBlock: block, stopRow, trailBlocks: trailBlockCount, entryPrice: ep, amount: amt, tradeId };
  block.state = 'yellow';
  blockIcons.push({ col: block.col, row: block.row, type: type });
  createTradeMarker(tradeObj);
  const statusEl = document.getElementById('tradeStatus');
  if (statusEl) { statusEl.textContent = type.toUpperCase(); statusEl.className = `trade-status ${type}`; }
  const _atEl = document.getElementById('activeTrade');
  if (_atEl) _atEl.textContent = `${type.toUpperCase()} $${amt.toFixed(2)}\nENTRY: $${ep.toFixed(2)}`;
  showNotification(`${type.toUpperCase()} $${amt.toFixed(2)} @ $${ep.toFixed(2)}`, type === 'buy' ? 'green' : 'red');
  refreshCloseButtons();
  refreshBalanceDisplay();
  drawChart();
}

function getCurrentPrice() {
  if (livePrice && !isNaN(livePrice)) return livePrice;
  if (basePrice) return basePrice;
  return 50000;
}

// ============================================================
// TRADE MARKERS
// ============================================================
function createTradeMarker(trade) {
  const layer = document.getElementById('tradeMarkersLayer');
  if (!layer) return;
  const el = document.createElement('div');
  el.className = `trade-marker ${trade.type}`;
  el.dataset.tradeId = trade.id;
  el.innerHTML = `<span class="tm-arrow">${trade.type === 'buy' ? '&#9650;' : '&#9660;'}</span><span class="tm-val" id="tmVal_${trade.id}">$${trade.amount.toFixed(2)}</span><span class="tm-pct" id="tmPct_${trade.id}">+0.000%</span>`;
  layer.appendChild(el);
  trade.markerEl = el;
}
function removeTradeMarker(trade) {
  if (!trade.markerEl || !trade.markerEl.parentNode) return;
  trade.markerEl.style.opacity = '0';
  trade.markerEl.style.transition = 'opacity 0.3s';
  setTimeout(() => { if (trade.markerEl && trade.markerEl.parentNode) trade.markerEl.parentNode.removeChild(trade.markerEl); }, 320);
}
function updateTradeMarkers() {
  const price = getCurrentPrice();
  const h     = chartCanvas.height;
  activeTrades.forEach(trade => {
    if (!trade.isOpen) return;
    const prevPl = trade.profitLoss;
    calcPnl(trade, price);
    if (trade.markerEl) {
      const markerY = Math.floor(currentLevel * blockSize - offsetY + blockSize / 2);
      trade.markerEl.style.top = `${Math.max(16, Math.min(h - 16, markerY))}px`;
      const valEl = document.getElementById(`tmVal_${trade.id}`);
      const pctEl = document.getElementById(`tmPct_${trade.id}`);
      if (valEl && pctEl) {
        const pl = trade.profitLoss, pct = trade.profitLossPercent;
        valEl.textContent = `$${trade.currentValue.toFixed(2)}`;
        pctEl.textContent = `${pl >= 0 ? '+' : ''}${pct.toFixed(3)}%`;
        trade.markerEl.classList.toggle('profit', pl >= 0);
        trade.markerEl.classList.toggle('loss',   pl < 0);
        if (prevPl !== undefined && Math.abs(pl - (prevPl || 0)) > 0.0001) {
          trade.markerEl.classList.remove('pulse');
          void trade.markerEl.offsetWidth;
          trade.markerEl.classList.add('pulse');
        }
      }
    }
    if (activeTrade && activeTrade.tradeId === trade.id) {
      const pl = trade.profitLoss, pct = trade.profitLossPercent;
      document.getElementById('activeTrade').textContent =
        `${trade.type.toUpperCase()} $${trade.amount.toFixed(2)}\nENTRY: $${trade.entryPrice.toFixed(2)}\nVALUE: $${trade.currentValue.toFixed(2)}\nP&L: ${pl >= 0 ? '+' : ''}${pct.toFixed(3)}%`;
    }
  });
  refreshCloseButtonLabels();
}

// ============================================================
// CLOSE TRADE BUTTONS
// ============================================================
function refreshCloseButtons() {
  const tbody = document.getElementById('positionsTableBody');
  const open = activeTrades.filter(t => t.isOpen && t.amount > 0);
  if (!tbody) return;
  if (open.length === 0) {
    tbody.innerHTML = '<tr class="positions-empty-row"><td colspan="9" style="text-align:center; color:var(--text-muted); font-style:italic; padding:24px;">No open positions</td></tr>';
    return;
  }
  tbody.innerHTML = '';
  open.forEach(trade => {
    const tr = document.createElement('tr');
    tr.className = 'position-row';
    tr.id = `posRow_${trade.id}`;
    const price = getCurrentPrice();
    const pl = trade.profitLoss || 0;
    const pct = trade.profitLossPercent || 0;
    const plColor = pl >= 0 ? 'var(--green)' : 'var(--red)';
    const typeColor = trade.type === 'buy' ? 'var(--green)' : 'var(--red)';
    const volume = trade.entryPrice > 0 ? (trade.amount / trade.entryPrice).toFixed(6) : '0.000000';
    const slPrice = trade.stopRow !== null && trade.stopRow !== undefined 
      ? (trade.entryPrice + (trade.stopRow - (trade.entryBlock ? trade.entryBlock.row : 0)) * STEP_SIZE).toFixed(2) 
      : '--';
    
    tr.innerHTML = `
      <td class="pos-symbol">${currentPair || 'BTC/USDT'}</td>
      <td class="pos-type" style="color:${typeColor}; font-weight:800;">${trade.type.toUpperCase()}</td>
      <td class="pos-volume">${volume}</td>
      <td class="pos-entry">${trade.entryPrice.toFixed(2)}</td>
      <td class="pos-current" id="posCur_${trade.id}">${price ? price.toFixed(2) : '--'}</td>
      <td class="pos-sl">${slPrice}</td>
      <td class="pos-tp">--</td>
      <td class="pos-profit" id="posPL_${trade.id}" style="color:${plColor}; font-weight:700;">
        ${pl >= 0 ? '+' : ''}$${pl.toFixed(2)} <span style="opacity:0.7">(${pl >= 0 ? '+' : ''}${pct.toFixed(2)}%)</span>
      </td>
      <td class="pos-close">
        <button class="pos-close-btn" id="closeBtn_${trade.id}" title="Close Position">✕</button>
      </td>
    `;
    tr.querySelector(`#closeBtn_${trade.id}`).addEventListener('click', () => closeTradeById(trade.id, 'MANUAL CLOSE'));
    tbody.appendChild(tr);
  });
}

function refreshCloseButtonLabels() {
  const price = getCurrentPrice();
  activeTrades.forEach(trade => {
    if (!trade.isOpen || trade.amount <= 0) return;
    const plEl = document.getElementById(`posPL_${trade.id}`);
    const curEl = document.getElementById(`posCur_${trade.id}`);
    if (plEl) {
      const pl = trade.profitLoss || 0;
      const pct = trade.profitLossPercent || 0;
      const plColor = pl >= 0 ? 'var(--green)' : 'var(--red)';
      plEl.style.color = plColor;
      plEl.innerHTML = `${pl >= 0 ? '+' : ''}$${pl.toFixed(2)} <span style="opacity:0.7">(${pl >= 0 ? '+' : ''}${pct.toFixed(2)}%)</span>`;
    }
    if (curEl && price) {
      curEl.textContent = price.toFixed(2);
    }
  });
}

// ============================================================
// CANVAS INTERACTION
// ============================================================

// ============================================================
// TOOLS INITIALIZATION
// ============================================================
document.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    if (e.currentTarget.id === 'resetToolsBtn') {
      if (currentPair) drawings[currentPair] = [];
      if (typeof drawChart === 'function') drawChart();
      return;
    }
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
    e.currentTarget.classList.add('active');
    currentTool = e.currentTarget.getAttribute('data-tool') || 'none';
    chartCanvas.style.cursor = currentTool === 'none' ? 'crosshair' : 'crosshair';
  });
});

chartCanvas.addEventListener('click', (e) => {

  if (isDragging) return;
  const rect = chartCanvas.getBoundingClientRect();
  const col = Math.floor((e.clientX - rect.left + offsetX) / blockSize);
  const row = Math.floor((e.clientY - rect.top  + offsetY) / blockSize);

  if (stopLossEnabled) {
    fetch("http://localhost:8000/set-stop", {
      method: "POST",
      body: JSON.stringify({ level: row }),
      headers: { "Content-Type": "application/json" }
    });
    document.getElementById('stopLossToggle').checked = false;
    stopLossEnabled = false;
    showNotification('STOP LOSS SET TO LEVEL ' + row, 'green');
    return;
  }

  const hit = blocks.find(b => b.col === col && b.row === row);
  if (hit) {
    if (popupBlock && popupBlock !== hit && popupBlock.state === 'yellow') {
      popupBlock.state = popupBlock.type;
    }
    popupBlock = hit;
    popupBlock.state = 'yellow';
    drawChart();
    showPopup(e.clientX, e.clientY);

    // Open right Order panel if collapsed
    const rightPanel = document.getElementById('rightPanel');
    if (rightPanel) {
      rightPanel.classList.remove('collapsed');
    }
  }
});

chartCanvas.addEventListener('mousedown', (e) => {
  const rect = chartCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left + offsetX;
  const y = e.clientY - rect.top + offsetY;
  const clientY = e.clientY - rect.top;

  // Check if mouse is close to stop-loss line
  if (currentStopRow !== null) {
    const lineY = currentStopRow * blockSize - offsetY + blockSize / 2;
    if (Math.abs(clientY - lineY) < 12) {
      isDraggingStop = true;
      chartCanvas.style.cursor = 'ns-resize';
      return;
    }
  }

  if (currentTool !== 'none') {
    isDrawingTool = true;
    if (!drawings[currentPair]) drawings[currentPair] = [];
    
    if (currentTool === 'trend') {
      currentDrawing = { type: 'trend', points: [{x, y}, {x, y}] };
    } else if (currentTool === 'pen' || currentTool === 'predictor') {
      currentDrawing = { type: currentTool, points: [{x, y}] };
    } else if (currentTool === 'fib' || currentTool === 'rect') {
      currentDrawing = { type: currentTool, points: [{x, y}, {x, y}] };
    } else if (currentTool === 'hline') {
      drawings[currentPair].push({ type: 'hline', y });
      isDrawingTool = false;
      drawChart();
    } else if (currentTool === 'vline') {
      drawings[currentPair].push({ type: 'vline', x });
      isDrawingTool = false;
      drawChart();
    }
    return;
  }

  isDragging = false;

  dragStart  = { x: e.clientX, y: e.clientY };
  dragOffset = { x: offsetX, y: offsetY };
  chartCanvas.style.cursor = 'grabbing';
});

chartCanvas.addEventListener('mousemove', (e) => {
  const rect = chartCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left + offsetX;
  const y = e.clientY - rect.top + offsetY;
  const clientY = e.clientY - rect.top;

  if (isDraggingStop) {
    const newStopRow = Math.floor((e.clientY - rect.top + offsetY) / blockSize);
    if (newStopRow !== currentStopRow) {
      currentStopRow = newStopRow;
      drawChart();
    }
    return;
  }

  if (isDrawingTool && currentDrawing) {
    if (currentDrawing.type === 'trend' || currentDrawing.type === 'fib' || currentDrawing.type === 'rect') {
      currentDrawing.points[1] = {x, y};
    } else if (currentDrawing.type === 'pen' || currentDrawing.type === 'predictor') {
      currentDrawing.points.push({x, y});
    }
    drawChart();
    return;
  }

  // Hover block detection
  if (isDragging || isDrawingTool) {
    if (hoveredBlock !== null) {
      hoveredBlock = null;
      drawChart();
    }
  } else {
    const col = Math.floor((e.clientX - rect.left + offsetX) / blockSize);
    const row = Math.floor((e.clientY - rect.top + offsetY) / blockSize);
    const hit = blocks.find(b => b.col === col && b.row === row);
    if (hit !== hoveredBlock) {
      hoveredBlock = hit;
      drawChart();
    }
  }

  // Cursor update when hovering over stop-loss line
  if (currentStopRow !== null && !isDragging && !isDrawingTool && !isDraggingStop) {
    const lineY = currentStopRow * blockSize - offsetY + blockSize / 2;
    if (Math.abs(clientY - lineY) < 12) {
      chartCanvas.style.cursor = 'ns-resize';
    } else {
      chartCanvas.style.cursor = currentTool === 'none' ? 'crosshair' : 'crosshair';
    }
  }

  if (Math.abs(e.clientX - dragStart.x) > 4 || Math.abs(e.clientY - dragStart.y) > 4) isDragging = true;

  if (isDragging && e.buttons === 1) {
    cameraFollowing = false;
    offsetX = Math.max(0, dragOffset.x - (e.clientX - dragStart.x));
    offsetY = dragOffset.y - (e.clientY - dragStart.y);
    drawGrid(); drawChart();
  }
});

chartCanvas.addEventListener('mouseup', () => {
  if (isDraggingStop) {
    isDraggingStop = false;
    chartCanvas.style.cursor = 'crosshair';
    
    // Send updated stop loss level to backend
    fetch("http://localhost:8000/set-stop", {
      method: "POST",
      body: JSON.stringify({ level: currentStopRow }),
      headers: { "Content-Type": "application/json" }
    })
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        showNotification('STOP LOSS UPDATED TO LEVEL ' + currentStopRow, 'green');
      } else {
        showNotification('FAILED TO UPDATE STOP LOSS: ' + (data.error || 'Unknown error'), 'red');
      }
    })
    .catch(err => {
      showNotification('FAILED TO CONNECT TO BACKEND', 'red');
    });
    return;
  }

  if (isDrawingTool) {
    if (currentDrawing) {
      if (!drawings[currentPair]) drawings[currentPair] = [];
      drawings[currentPair].push(currentDrawing);
      currentDrawing = null;
    }
    isDrawingTool = false;
    drawChart();
    return;
  }

  chartCanvas.style.cursor = 'crosshair';

  setTimeout(() => { isDragging = false; }, 50);
});
chartCanvas.addEventListener('dblclick', () => {
  cameraFollowing = true; centerCamera(); centerCameraX(); drawGrid(); drawChart();
  showNotification('CAMERA LOCKED TO PRICE', '');
});

// ============================================================
// POPUP
// ============================================================
function showPopup(x, y) {
  const p = document.getElementById('tradePopup');
  p.style.left = `${x + 8}px`; p.style.top = `${y - 20}px`;
  p.classList.remove('hidden');
}
function hidePopup(preserveHighlight = false) {
  if (popupBlock && !preserveHighlight && popupBlock.state === 'yellow') {
    popupBlock.state = popupBlock.type;
    drawChart();
  }
  document.getElementById('tradePopup').classList.add('hidden');
  popupBlock = null;
}
document.getElementById('buyBtn').addEventListener('click', () => {
  if (!popupBlock) return;
  pendingTradeType = 'buy'; pendingTradeBlock = popupBlock;
  hidePopup(true); openAmountPopup('buy');
});
document.getElementById('sellBtn').addEventListener('click', () => {
  if (!popupBlock) return;
  pendingTradeType = 'sell'; pendingTradeBlock = popupBlock;
  hidePopup(true); openAmountPopup('sell');
});
document.getElementById('closePopup').addEventListener('click', hidePopup);

// ============================================================
// AMOUNT POPUP
// ============================================================
function openAmountPopup(type) {
  const popup   = document.getElementById('tradeAmountPopup');
  const title   = document.getElementById('tapTitle');
  const execBtn = document.getElementById('tapExecute');
  const entryEl = document.getElementById('tapEntryPrice');
  const balEl   = document.getElementById('tapBalance');
  const input   = document.getElementById('tradeAmountInput');
  const entryPrice = pendingTradeBlock?.price || getCurrentPrice();
  title.textContent   = type === 'buy' ? 'BUY TRADE' : 'SELL TRADE';
  title.className     = `tap-title ${type}`;
  execBtn.className   = `tap-exec-btn ${type}`;
  execBtn.textContent = type === 'buy' ? 'EXECUTE BUY' : 'EXECUTE SELL';
  entryEl.textContent = `$${entryPrice.toFixed(2)}`;
  balEl.textContent   = `$${getBalance().toFixed(2)}`;
  input.value = '';
  document.getElementById('tapError').classList.add('hidden');
  popup.style.left = '50%'; popup.style.top = '50%';
  popup.style.transform = 'translate(-50%,-50%) scale(0.85)';
  popup.style.transformOrigin = 'center center';
  popup.classList.remove('hidden');
  requestAnimationFrame(() => popup.classList.add('visible'));
  input.focus();
}
function closeAmountPopup() {
  const popup = document.getElementById('tradeAmountPopup');
  popup.classList.remove('visible');
  setTimeout(() => popup.classList.add('hidden'), 160);
  pendingTradeType = null; pendingTradeBlock = null;
}
function showTapError(msg) {
  const el = document.getElementById('tapError');
  el.textContent = msg; el.classList.remove('hidden');
  clearTimeout(showTapError._t);
  showTapError._t = setTimeout(() => el.classList.add('hidden'), 2500);
}

document.getElementById('tapExecute').addEventListener('click', async () => {
  const rawVal = document.getElementById('tradeAmountInput').value.trim();
  const amount = parseFloat(rawVal);
  if (!rawVal || isNaN(amount) || amount < 0.01) { showTapError('ENTER A VALID AMOUNT (MIN $0.01)'); return; }
  
  const type  = pendingTradeType;
  const selectedBlockPrice = Number(pendingTradeBlock?.price || 0);
  
  if (window.BackendBridge && window.BackendBridge.isConnected && window.BackendBridge.isConnected()) {
      window.BackendBridge.executeTrade(type, amount, undefined, stopLossEnabled ? currentStopLoss : 0, trailEnabled, trailBlockCount, selectedBlockPrice);
  } else {
      // Local demo trade
      const block = pendingTradeBlock || blocks[blocks.length - 1];
      if (block) {
        openTrade(type, block, amount);
      } else {
        showTapError('NO BLOCK DATA AVAILABLE');
      }
  }
  
  closeAmountPopup();
});

document.getElementById('tapClose').addEventListener('click', closeAmountPopup);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeAmountPopup(); hidePopup(); } });

// ============================================================
// CONTROLS
// ============================================================
document.getElementById('startBtn').addEventListener('click', () => {
  if (window.BackendBridge && window.BackendBridge.isConnected()) {
    window.BackendBridge.setSimPaused(false);
    showNotification('SIMULATION PLAYING', 'green');
    return;
  }
  if (simRunning) return;
  simRunning = true;
  simInterval = setInterval(updatePrice, speed);
  showNotification('LOCAL SIMULATION STARTED', 'green');
});
document.getElementById('stopBtn').addEventListener('click', () => {
  if (window.BackendBridge && window.BackendBridge.isConnected()) {
    window.BackendBridge.setSimPaused(true);
    showNotification('SIMULATION PAUSED', 'red');
    return;
  }
  simRunning = false; clearInterval(simInterval);
  showNotification('LOCAL SIMULATION PAUSED', 'red');
});
document.getElementById('clearBtn').addEventListener('click', () => {
  simRunning = false; clearInterval(simInterval);
  stopLiveBlockEmitter();
  clearTimeout(wsReconnectTimer); clearTimeout(noDataTimer);
  activeTrades.forEach(t => { t.isOpen = false; removeTradeMarker(t); });
  activeTrades = []; blockIcons = [];
  activeTrade = null; livePrice = null;
  const _clAEl = document.getElementById('activeTrade');
  if (_clAEl) _clAEl.textContent = 'NONE';
  document.getElementById('tradeStatus').textContent = 'NO TRADE';
  document.getElementById('tradeStatus').className = 'trade-status';
  const cs = document.getElementById('closeTradeSection');
  const cb = document.getElementById('closeTradeButtons');
  if (cs) cs.style.display = 'none';
  if (cb) cb.innerHTML = '';
  drawGrid(); drawChart();
});

// UI Logic migrated to index.html inline script or simplified

document.getElementById('stopLossToggle').addEventListener('change', (e) => { stopLossEnabled = e.target.checked; });
document.getElementById('trailToggle').addEventListener('change', (e) => {
  trailEnabled = e.target.checked;
  document.getElementById('trailOptions').classList.toggle('hidden', !trailEnabled);
});

document.getElementById('speedSlider').addEventListener('input', (e) => {
  speed = parseInt(e.target.value);
  document.getElementById('speedVal').textContent = speed;
  if (window.BackendBridge && window.BackendBridge.isConnected()) {
    window.BackendBridge.setSimSpeed(speed);
  } else {
    if (simRunning) {
      clearInterval(simInterval);
      simInterval = setInterval(updatePrice, speed);
    }
  }
});

document.querySelectorAll('.tb-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tb-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    trailBlockCount = parseInt(btn.dataset.blocks);
    if (activeTrade) activeTrade.trailBlocks = trailBlockCount;
  });
});


// ============================================================
// MODE SWITCH
// ============================================================
const exchangeConnection = {
  connected: false,
  exchange: null,
  status: 'disconnected',
};
const panel = document.getElementById('exchangePanel');
const btn = document.getElementById('starBtn');
let exchangeInfo = null;
let activeExchangeType = 'spot';

function closeExchangePanel() {
  if (panel) panel.classList.remove('open');
  if (btn) btn.classList.remove('active');
}

function syncRemoteButtonVisibility() {
  if (!btn) return;
  const shouldShow = tradeMode === 'real' && exchangeConnection.connected;
  btn.classList.toggle('hidden', !shouldShow);
  if (!shouldShow) closeExchangePanel();
}

function setExchangeConnectionState(next) {
  exchangeConnection.connected = !!next.connected;
  exchangeConnection.exchange = next.exchange || null;
  exchangeConnection.status = next.status || (exchangeConnection.connected ? 'connected' : 'disconnected');

  const statusEl = document.getElementById('excStatus');
  if (statusEl) {
    const map = {
      connected: ['CONNECTED', 'exc-status exc-connected'],
      connecting: ['CONNECTING...', 'exc-status exc-connecting'],
      failed: ['FAILED', 'exc-status exc-failed'],
      disconnected: ['DISCONNECTED', 'exc-status exc-disconnected'],
    };
    const [text, cls] = map[exchangeConnection.status] || map.disconnected;
    statusEl.textContent = text;
    statusEl.className = cls;
  }

  const nameEl = document.getElementById('excName');
  if (nameEl) {
    nameEl.textContent = exchangeConnection.connected && exchangeConnection.exchange
      ? exchangeConnection.exchange.toUpperCase()
      : 'NOT CONNECTED';
  }

  const connectBtn = document.getElementById('excConnectBtn');
  const disconnectBtn = document.getElementById('excDisconnectBtn');
  const accountPanel = document.getElementById('excAccountPanel');
  if (connectBtn) connectBtn.classList.toggle('hidden', exchangeConnection.connected);
  if (disconnectBtn) disconnectBtn.classList.toggle('hidden', !exchangeConnection.connected);
  if (accountPanel) accountPanel.classList.toggle('hidden', !exchangeConnection.connected);

  if (!exchangeConnection.connected) {
    exchangeInfo = null;
    closeExchangePanel();
  }

  syncRemoteButtonVisibility();
}

function setMode(mode) {
  tradeMode = mode;
  document.getElementById('modeDemoBtn').classList.toggle('active', mode === 'demo');
  document.getElementById('modeRealBtn').classList.toggle('active', mode === 'real');
  refreshBalanceDisplay();
  const badge = document.getElementById('modeBadge');
  if (badge) { badge.textContent = mode === 'real' ? 'REAL MODE' : 'DEMO MODE'; badge.className = `mode-badge ${mode}`; }
  showNotification(mode === 'demo' ? 'DEMO MODE ACTIVE' : 'REAL MODE ACTIVE', mode === 'demo' ? 'green' : 'red');

  // Real Mode constraints
  const selector = document.getElementById('assetSelector');
  if (selector) {
      selector.style.display = mode === 'real' ? 'none' : 'inline-block';
  }

  if (mode !== 'real') closeExchangePanel();
  syncRemoteButtonVisibility();
}
document.getElementById('modeDemoBtn').addEventListener('click', () => setMode('demo'));
document.getElementById('modeRealBtn').addEventListener('click', () => setMode('real'));

// ============================================================
// EXCHANGE PANEL (REMOTE CONTROL)
// ============================================================
if (btn && panel) {
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();

    if (tradeMode !== 'real' || !exchangeConnection.connected) {
      showNotification('CONNECT A VALID EXCHANGE FIRST', 'red');
      return;
    }

    const opening = !panel.classList.contains('open');
    panel.classList.toggle('open', opening);
    btn.classList.toggle('active', opening);

    if (opening) {
      try {
        const res = await fetch('http://localhost:8000/exchange-info');
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Failed to load exchange info');
        }
        exchangeInfo = data;
        activeExchangeType = (data.types && data.types[0]) || 'spot';
        renderExchangePanel();
      } catch(err) {
        console.error('Failed to fetch exchange info', err);
        closeExchangePanel();
        showNotification(`EXCHANGE INFO FAILED: ${err.message}`, 'red');
      }
    }
  });

  document.addEventListener('click', (e) => {
    if (!panel.contains(e.target) && e.target !== btn) {
      closeExchangePanel();
    }
  });
}

function renderExchangePanel() {
  if (!exchangeInfo || !exchangeInfo.exchange) return;
  const nameEl = document.getElementById('epExchangeName');
  if (nameEl) nameEl.textContent = exchangeInfo.exchange.toUpperCase();

  const statusEl = document.getElementById('epExchangeStatus');
  if (statusEl) {
    statusEl.textContent = exchangeConnection.connected ? 'CONNECTED' : 'DISCONNECTED';
    statusEl.className = `ep-status ${exchangeConnection.connected ? 'connected' : 'disconnected'}`;
  }

  const typeContainer = document.getElementById('epTypeSelector');
  if (typeContainer) {
    typeContainer.innerHTML = '';
    (exchangeInfo.types || []).forEach((t, i) => {
      const typeBtn = document.createElement('button');
      const isActive = t === activeExchangeType || (i === 0 && !activeExchangeType);
      typeBtn.className = 'ep-type-btn' + (isActive ? ' active' : '');
      typeBtn.textContent = t.toUpperCase();
      typeBtn.onclick = () => {
        document.querySelectorAll('.ep-type-btn').forEach(b => b.classList.remove('active'));
        typeBtn.classList.add('active');
        activeExchangeType = t;
        renderExchangePairs(filterExchangePairs());
      };
      typeContainer.appendChild(typeBtn);
    });
  }

  renderExchangePairs(filterExchangePairs());

  const searchInp = document.getElementById('epSearch');
  if (searchInp) {
    searchInp.oninput = (e) => {
      renderExchangePairs(filterExchangePairs(e.target.value));
    };
  }
}

function getPairsForType(type) {
  if (!exchangeInfo) return [];
  const typeMap = exchangeInfo.pairs_by_type || {};
  return typeMap[type] || exchangeInfo.pairs || [];
}

function filterExchangePairs(query = '') {
  const q = query.toLowerCase().trim();
  const pairs = getPairsForType(activeExchangeType);
  if (!q) return pairs;
  return pairs.filter(p => p.toLowerCase().includes(q));
}

function renderExchangePairs(pairs) {
  const container = document.getElementById('epPairList');
  if (!container) return;
  container.innerHTML = '';
  if (!pairs.length) {
    const empty = document.createElement('div');
    empty.className = 'ep-empty';
    empty.textContent = 'NO PAIRS AVAILABLE';
    container.appendChild(empty);
    return;
  }
  pairs.forEach(p => {
    const { base, quote } = splitPairSymbols(p);
    const pairBtn = document.createElement('button');
    pairBtn.className = 'ep-pair-btn' + (p === window.currentPair ? ' active' : '');
    pairBtn.innerHTML = `
      <span class="ep-pair-btn-content">
        <span class="ep-pair-icons">
          <img class="asset-icon ep-base-icon" alt="${base} icon"/>
          <span class="asset-divider">/</span>
          <img class="asset-icon ep-quote-icon" alt="${quote} icon"/>
        </span>
        <span class="ep-pair-label">${p}</span>
      </span>
    `;
    pairBtn.onclick = async () => {
      try {
        const res = await fetch('http://localhost:8000/set-market', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol: p, type: activeExchangeType })
        });
        const data = await res.json();
        if (res.ok) {
          window.currentPair = p;
          document.querySelectorAll('.ep-pair-btn').forEach(b => b.classList.remove('active'));
          pairBtn.classList.add('active');
          closeExchangePanel();
          if (Array.isArray(data.blocks)) {
            window.blocks = data.blocks.map(block => ({
              col: block.col,
              row: block.row,
              type: block.type,
              state: 'normal',
              price: block.price,
              timestamp: block.timestamp,
            }));
            if (window.blocks.length > 0) {
              const last = window.blocks[window.blocks.length - 1];
              window.currentCol = last.col;
              window.currentLevel = last.row;
              if (typeof window.centerCamera === 'function') window.centerCamera();
            }
          }
          if (data.price) window.livePrice = data.price;
          if (typeof window.drawChart === 'function') window.drawChart();
          showNotification(`PAIR: ${p} (${activeExchangeType.toUpperCase()})`, 'green');
        } else {
          showNotification(data.error || 'FAILED TO SWITCH MARKET', 'red');
        }
      } catch(err) {
        console.error('Failed to set market', err);
        showNotification(`FAILED TO SWITCH MARKET: ${err.message}`, 'red');
      }
    };
    setAssetIconImage(pairBtn.querySelector('.ep-base-icon'), base);
    setAssetIconImage(pairBtn.querySelector('.ep-quote-icon'), quote);
    container.appendChild(pairBtn);
  });
}

// ============================================================
// HISTORY + PNL + NOTIFICATION
// ============================================================
function renderHistory() {
  document.getElementById('tradeHistoryList').innerHTML = tradeHistory.slice(0, 50).map(t => `
    <div class="history-item ${t.pnl >= 0 ? 'win' : 'loss'}">
      ${t.time} | ${t.type} | ${t.reason}${t.amount ? ` | $${parseFloat(t.amount).toFixed(2)}` : ''}${t.mode ? ` [${t.mode.toUpperCase()}]` : ''}
      <br/>P&L: ${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(3)}%
    </div>`).join('');
}
function updatePnl() {
  const el = document.getElementById('pnlDisplay');
  el.textContent = `${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)}%`;
  el.className = `pnl-display ${pnl > 0 ? 'positive' : pnl < 0 ? 'negative' : ''}`;
}
function showNotification(msg, type = '') {
  const el = document.getElementById('notification');
  if (!el) return;
  el.textContent = msg; el.className = `notification ${type}`;
  el.classList.remove('hidden');
  clearTimeout(notifTimer);
  notifTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

// ============================================================
// WINDOW BRIDGE
// app.js uses 'use strict' so let/const are NOT on window.
// Getters/setters keep both sides in sync with chart.js.
// ============================================================
(function bridgeToWindow() {
  window.drawChart         = drawChart;
  window.drawGrid          = drawGrid;
  window.centerCamera      = centerCamera;
  window.centerCameraX     = centerCameraX;
  window.showNotification  = showNotification;
  window.renderHistory     = renderHistory;
  window.refreshBalanceDisplay = refreshBalanceDisplay;
  window.setMode           = setMode;
  window.setExchangeConnectionState = setExchangeConnectionState;
  window.createTradeMarker = createTradeMarker;
  window.removeTradeMarker = removeTradeMarker;
  window.refreshCloseButtons = refreshCloseButtons;
  window.updateTradeMarkers = updateTradeMarkers;
  window.chartCanvas       = chartCanvas;
  window.ctx               = ctx;
  window.openTrade         = openTrade;
  window.settleTrade       = settleTrade;
  window.closeTradeById    = closeTradeById;
  window.getCurrentPrice   = getCurrentPrice;
  window.drawings          = drawings;

  const props = {
    blocks:         { get: () => blocks,          set: (v) => { blocks = v; } },
    currentCol:     { get: () => currentCol,      set: (v) => { currentCol = v; } },
    currentLevel:   { get: () => currentLevel,    set: (v) => { currentLevel = v; } },
    basePrice:      { get: () => basePrice,        set: (v) => { basePrice = v; } },
    STEP_SIZE:      { get: () => STEP_SIZE,        set: (v) => { STEP_SIZE = v; } },
    blockSize:      { get: () => blockSize,        set: (v) => { blockSize = v; } },
    offsetX:        { get: () => offsetX,          set: (v) => { offsetX = v; } },
    offsetY:        { get: () => offsetY,          set: (v) => { offsetY = v; } },
    cameraFollowing:{ get: () => cameraFollowing,  set: (v) => { cameraFollowing = v; } },
    livePrice:      { get: () => livePrice,        set: (v) => { livePrice = v; } },
    currentPair:    { get: () => currentPair,      set: (v) => {
      currentPair = normalizePairLabel(v);
      const selector = document.getElementById('assetSelector');
      if (selector) {
        const matching = Array.from(selector.options || []).find(option => option.value === currentPair);
        if (matching) selector.value = matching.value;
      }
      updateAssetBadge(currentPair);
    } },
    tradeMode:      { get: () => tradeMode,        set: (v) => { tradeMode = v; } },
    demoBalance:    { get: () => demoBalance,      set: (v) => { demoBalance = v; } },
    liveBalance:    { get: () => liveBalance,      set: (v) => { liveBalance = v; } },
    activeTrade:    { get: () => activeTrade,      set: (v) => { activeTrade = v; } },
    activeTrades:   { get: () => activeTrades,     set: (v) => { activeTrades = v; } },
    currentStopLoss:{ get: () => currentStopLoss,  set: (v) => { currentStopLoss = Number(v) || 0; } },
    currentStopRow: { get: () => currentStopRow,   set: (v) => { currentStopRow = Number.isFinite(v) ? v : null; } },
    tradeHistory:   { get: () => tradeHistory,     set: (v) => { tradeHistory = v; } },
    blockIcons:     { get: () => blockIcons,       set: (v) => { blockIcons = v; } },
    lastPrice:      { get: () => lastPrice,        set: (v) => { lastPrice = v; } },
    stopLossEnabled:{ get: () => stopLossEnabled,  set: (v) => {
      stopLossEnabled = v;
      const el = document.getElementById('stopLossToggle');
      if (el) el.checked = !!v;
    } },
    trailEnabled:   { get: () => trailEnabled,     set: (v) => {
      trailEnabled = v;
      const el = document.getElementById('trailToggle');
      if (el) {
        el.checked = !!v;
        const opt = document.getElementById('trailOptions');
        if (opt) opt.classList.toggle('hidden', !v);
      }
    } },
    trailBlockCount:{ get: () => trailBlockCount,  set: (v) => {
      trailBlockCount = v;
      document.querySelectorAll('.tb-btn').forEach(btn => {
        const active = parseInt(btn.dataset.blocks) === v;
        btn.classList.toggle('active', active);
      });
    } },
    BLOCK_PX:       { get: () => blockSize,        set: () => {} },
    zoomLevel:      { get: () => 1,                set: () => {} },
  };

  Object.keys(props).forEach(key => {
    Object.defineProperty(window, key, {
      get: props[key].get, set: props[key].set,
      configurable: true, enumerable: true
    });
  });
})();

// ============================================================
// INIT
// ============================================================
window.addEventListener('resize', resize);
resize();
setTimeout(resize, 100);
refreshBalanceDisplay();
updateAssetBadge(currentPair);
setExchangeConnectionState({ connected: false, exchange: null, status: 'disconnected' });

if (window.ExchangeModule) window.ExchangeModule.init();

(function patchClearBtn() {
  const btn = document.getElementById('clearBtn');
  if (btn) btn.addEventListener('click', () => {
    lastPrice = null;
    basePrice = null;
    blocks    = [];
    currentCol = 0;
    currentLevel = 0;
    drawGrid();
    drawChart();
  });
})();

// ============================================================
// BACKEND BRIDGE INTEGRATION
// Routes real-mode trades through Python backend.
// Demo mode continues to use existing JS logic unchanged.
// ============================================================
(function wireBackendBridge() {
  // Patch asset selector to also notify backend on symbol switch
  const assetSel = document.getElementById('assetSelector');
  if (assetSel) {
    assetSel.addEventListener('change', (e) => {
      const pair = e.target.value;
      window.currentPair = pair;
      connectPairWS(pair);
      if (pair && window.BackendBridge && window.BackendBridge.isConnected()) {
        window.BackendBridge.switchSymbol(pair);
      }
    });
  }

  // Patch exchange connect form to route through backend via fetch (not WS)
  const excForm = document.getElementById('excConnectForm');
  if (excForm) {
    excForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const exchange = document.getElementById('excExchangeSelect').value;
      const key      = document.getElementById('excApiKey').value.trim();
      const secret   = document.getElementById('excApiSecret').value.trim();

      if (!key)    { showNotification('API KEY REQUIRED', 'red'); return; }
      if (!secret) { showNotification('API SECRET REQUIRED', 'red'); return; }

      // Clear fields immediately — keys must not linger in DOM
      document.getElementById('excApiKey').value    = '';
      document.getElementById('excApiSecret').value = '';

      // Hide the connect panel
      const panel = document.getElementById('excConnectPanel');
      if (panel) panel.classList.add('hidden');

      setExchangeConnectionState({ connected: false, exchange, status: 'connecting' });
      showNotification('CONNECTING...', '');

      try {
        const res  = await fetch('http://localhost:8000/connect', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ exchange, api_key: key, api_secret: secret }),
        });
        const data = await res.json();

        if (res.ok && data.success) {
          const balEl  = document.getElementById('excAccountBalance');
          if (balEl)   balEl.textContent = `$${data.balance}`;
          const availEl = document.getElementById('excAccountAvail');
          if (availEl) availEl.textContent = `$${data.balance}`;
          setExchangeConnectionState({ connected: true, exchange, status: 'connected' });
          if (typeof setMode === 'function') setMode('real');
          showNotification(`CONNECTED: ${exchange.toUpperCase()} | $${data.balance}`, 'green');
          console.log('[EXCHANGE] connected via backend:', exchange, 'balance:', data.balance);
        } else {
          const err = data.error || data.detail || 'Connection failed';
          setExchangeConnectionState({ connected: false, exchange: null, status: 'failed' });
          showNotification(`FAILED: ${err}`, 'red');
          const statEl = document.getElementById('excStatus');
          if (statEl) { statEl.textContent = 'FAILED'; statEl.className = 'exc-status exc-failed'; }
        }
      } catch (err) {
        setExchangeConnectionState({ connected: false, exchange: null, status: 'failed' });
        showNotification('BACKEND NOT RUNNING — demo mode only', '');
        console.warn('[EXCHANGE] backend unreachable:', err.message);
      }
    });
  }

  // Patch disconnect button
  const discBtn = document.getElementById('excDisconnectBtn');
  if (discBtn) {
    discBtn.addEventListener('click', () => {
      setExchangeConnectionState({ connected: false, exchange: null, status: 'disconnected' });
      if (window.BackendBridge) window.BackendBridge.disconnectExchange();
    });
  }

  // Patch mode buttons to also notify backend
  const demoBtn = document.getElementById('modeDemoBtn');
  const realBtn = document.getElementById('modeRealBtn');
  if (demoBtn) demoBtn.addEventListener('click', () => {
    if (window.BackendBridge && window.BackendBridge.isConnected()) window.BackendBridge.setMode('demo');
  });
  if (realBtn) realBtn.addEventListener('click', () => {
    if (window.BackendBridge && window.BackendBridge.isConnected()) window.BackendBridge.setMode('real');
  });
})();

// ============================================================
// FUNCTION BRIDGE — Expose to window for backend_bridge.js
// Function declarations in strict mode are NOT on window.
// ============================================================
window.drawGrid              = drawGrid;
window.drawChart             = drawChart;
window.centerCamera          = centerCamera;
window.centerCameraX         = centerCameraX;
window.resize                = resize;
window.openTrade             = openTrade;
window.settleTrade           = settleTrade;
window.closeTradeById        = closeTradeById;
window.showNotification      = showNotification;
window.refreshCloseButtons   = refreshCloseButtons;
window.refreshBalanceDisplay = refreshBalanceDisplay;
window.getCurrentPrice       = getCurrentPrice;
window.setMode               = setMode;
window.renderHistory         = renderHistory;
window.createTradeMarker     = createTradeMarker;
window.removeTradeMarker     = removeTradeMarker;
window.updateTradeMarkers    = updateTradeMarkers;
window.refreshCloseButtonLabels = refreshCloseButtonLabels;
window.setExchangeConnectionState = setExchangeConnectionState;
