// ============================================================
// CHART ENGINE v6 — Staircase candle blocks, persistence, WS
// SINGLE SOURCE OF TRUTH: blocks[] rows are ALWAYS +-1 staircase.
// priceToRow() is NEVER used for block positioning.
// ============================================================
'use strict';

window.ChartEngine = (() => {

  const MAX_CANDLES = 2000;
  const HIST_LIMIT  = 500;
  const STORAGE_KEY = 'aitrade_v6';
  const INTERVALS   = ['1m','5m','15m','1h','4h','1d'];
  const USE_BACKEND_BLOCKS = true;

  let symbol      = 'BTCUSDT';
  let pair        = 'BTC/USDT';
  let interval    = '1m';
  let isSwitching = false;
  let fetchingOld = false;

  let candleHistory = [];
  let colTimestamps = {};

  let ws          = null;
  let wsTimer     = null;
  let intentClose = false;
  let reconnectN  = 0;

  // ----------------------------------------------------------
  // UTILS
  // ----------------------------------------------------------
  function pairToSym(p) { return p.replace('/','').toUpperCase(); }

  function fmtTime(ts) {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  }
  function fmtDate(ts) {
    const d = new Date(ts);
    return `${d.getDate()}/${d.getMonth()+1}/${d.getFullYear()}`;
  }

  function calibrate(price) {
    if (typeof window.calibrateStepSize === 'function') window.calibrateStepSize(price);
  }

  function notify(msg, type) {
    if (typeof window.showNotification === 'function') window.showNotification(msg, type || '');
  }

  // ----------------------------------------------------------
  // CONNECTION STATUS
  // ----------------------------------------------------------
  function setConnUI(state) {
    const el = document.getElementById('wsStatus');
    if (!el) return;
    const map = {
      connected:    ['CONNECTED',    'ws-status connected'],
      reconnecting: ['RECONNECTING', 'ws-status disconnected'],
      disconnected: ['DISCONNECTED', 'ws-status disconnected'],
      loading:      ['LOADING',      'ws-status sim']
    };
    const [t, c] = map[state] || map.disconnected;
    el.textContent = t; el.className = c;
  }

  function setSpinner(show) {
    let el = document.getElementById('chartSpinner');
    if (!el) {
      el = document.createElement('span');
      el.id = 'chartSpinner'; el.className = 'chart-spinner';
      const hdr = document.querySelector('.chart-header');
      if (hdr) hdr.appendChild(el);
    }
    el.style.display = show ? 'inline-block' : 'none';
    el.textContent   = show ? 'loading' : '';
  }

  // ----------------------------------------------------------
  // PERSISTENCE
  // ----------------------------------------------------------
  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        pair, symbol, interval,
        basePrice: window.basePrice,
        candles:   candleHistory.slice(-MAX_CANDLES),
        savedAt:   Date.now()
      }));
    } catch(e) {}
  }

  function loadSaved() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (Date.now() - s.savedAt > 86400000) { localStorage.removeItem(STORAGE_KEY); return null; }
      return s;
    } catch(e) { return null; }
  }

  function clearSaved() { localStorage.removeItem(STORAGE_KEY); }

  // ----------------------------------------------------------
  // CANDLE HELPERS
  // ----------------------------------------------------------
  function klineToCandle(k) {
    return {
      openTime:  parseInt(k[0]),
      closeTime: parseInt(k[6]),
      open:      parseFloat(k[1]),
      high:      parseFloat(k[2]),
      low:       parseFloat(k[3]),
      close:     parseFloat(k[4])
    };
  }

  // ----------------------------------------------------------
  // REBUILD BLOCKS FROM CANDLE HISTORY
  // Uses STAIRCASE logic: each block row = prev row +/-1.
  // Green candle (close >= open) = row-1 (up).
  // Red candle (close < open) = row+1 (down).
  // NEVER uses priceToRow or absolute price mapping.
  // ----------------------------------------------------------
  function rebuildBlocks() {
    window.blocks     = [];
    window.currentCol = 0;
    colTimestamps     = {};

    candleHistory.forEach((c, i) => {
      const prev    = window.blocks.length > 0 ? window.blocks[window.blocks.length - 1] : null;
      const prevRow = prev ? prev.row : 0;
      const type    = c.close >= c.open ? 'green' : 'red';
      const newRow  = type === 'green' ? prevRow - 1 : prevRow + 1;
      window.blocks.push({ col: i, row: newRow, type, state: 'normal' });
      colTimestamps[i] = c.openTime;
    });

    window.currentCol   = candleHistory.length;
    window.currentLevel = window.blocks.length > 0
      ? window.blocks[window.blocks.length - 1].row : 0;

    console.log('[REBUILD] blocks:', window.blocks.length, '| lastRow:', window.currentLevel);
  }

  // ----------------------------------------------------------
  // RESTORE FROM STORAGE
  // ----------------------------------------------------------
  function restoreFromStorage(saved) {
    if (!saved || !saved.candles || saved.candles.length === 0) return false;

    pair     = saved.pair;
    symbol   = saved.symbol;
    interval = saved.interval || '1m';
    window.currentPair = saved.pair;
    window.basePrice   = saved.basePrice;
    calibrate(window.basePrice);

    candleHistory = saved.candles;
    rebuildBlocks();
    scrollToLatest();
    window.drawGrid();
    window.drawChart();
    console.log('[RESTORE]', candleHistory.length, 'candles | pair:', pair);
    return true;
  }

  // ----------------------------------------------------------
  // FETCH
  // ----------------------------------------------------------
  async function fetchKlines(sym, iv, limit, endTime) {
    let url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${iv}&limit=${limit}`;
    if (endTime) url += `&endTime=${endTime}`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch(e) {
      console.warn('[FETCH] failed:', e.message);
      return null;
    }
  }

  // ----------------------------------------------------------
  // LOAD ASSET
  // ----------------------------------------------------------
  async function loadAsset(newPair, newInterval) {
    if (isSwitching) return;
    isSwitching = true;

    pair     = newPair;
    symbol   = pairToSym(newPair);
    interval = newInterval || interval;
    window.currentPair = newPair;

    // Reset lastPrice so updatePrice() re-initialises for new asset
    window.lastPrice = null;

    wsStop();
    setSpinner(true);
    setConnUI('loading');

    if (USE_BACKEND_BLOCKS) {
      if (window.BackendBridge && window.BackendBridge.switchSymbol) {
        window.BackendBridge.switchSymbol(pair);
      }
      setSpinner(false);
      isSwitching = false;
      return;
    }

    const klines = await fetchKlines(symbol, interval, HIST_LIMIT);

    if (klines && klines.length > 0) {
      const first = klineToCandle(klines[0]);
      window.basePrice = first.open;
      calibrate(window.basePrice);

      candleHistory = klines.map(klineToCandle);
      rebuildBlocks();
      scrollToLatest();
      window.drawGrid();
      window.drawChart();
      saveState();
      notify(`${newPair} loaded`, 'green');
    } else {
      notify(`${newPair} history unavailable`, '');
    }

    setSpinner(false);
    isSwitching = false;
    wsStart();
  }

  // ----------------------------------------------------------
  // FETCH OLDER HISTORY
  // ----------------------------------------------------------
  async function fetchOlderHistory() {
    if (fetchingOld || candleHistory.length === 0 || isSwitching || USE_BACKEND_BLOCKS) return;
    fetchingOld = true;
    setSpinner(true);

    const oldest = candleHistory[0].openTime;
    const klines = await fetchKlines(symbol, interval, HIST_LIMIT, oldest - 1);

    if (klines && klines.length > 0) {
      const older = klines.map(klineToCandle);
      candleHistory = [...older, ...candleHistory];
      if (candleHistory.length > MAX_CANDLES) candleHistory = candleHistory.slice(-MAX_CANDLES);

      const addedCols = older.length;
      rebuildBlocks();
      const bp = window.blockSize || 40;
      window.offsetX = Math.max(0, window.offsetX + addedCols * bp);
      window.drawGrid();
      window.drawChart();
      saveState();
    } else {
      notify('No older data', '');
    }

    setSpinner(false);
    fetchingOld = false;
  }

  // ----------------------------------------------------------
  // SCROLL TO LATEST
  // ----------------------------------------------------------
  function scrollToLatest() {
    if (!window.blocks || window.blocks.length === 0) return;
    const bp = window.blockSize || 40;
    const cw = (window.chartCanvas && window.chartCanvas.width) || 800;
    window.offsetX = Math.max(0, (window.currentCol - 1) * bp - cw + bp * 3);
    window.cameraFollowing = true;
    if (typeof window.centerCamera === 'function') window.centerCamera();
  }

  function nearLeftEdge() {
    const bp = window.blockSize || 40;
    return window.offsetX < bp * 8;
  }

  // ----------------------------------------------------------
  // WEBSOCKET
  // ----------------------------------------------------------
  function wsStart() {
    // Disabled: pure renderer, handled by backend
  }

  function wsStop() {
    // Disabled
  }

  function onKline(k) {
    // Disabled: pure renderer, handled by backend
  }

  // ----------------------------------------------------------
  // TIME AXIS
  // ----------------------------------------------------------
  function drawTimeAxis() {
    const cvs = window.chartCanvas;
    const c   = window.ctx;
    if (!cvs || !c) return;

    const w = cvs.width, h = cvs.height, axisH = 20;
    const bp = window.blockSize || 40;

    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = 'rgba(0,0,0,0.75)';
    c.fillRect(0, h - axisH, w, axisH);
    c.font = '9px Share Tech Mono, monospace';
    c.textBaseline = 'middle';

    const step     = Math.max(1, Math.floor(80 / bp));
    const startCol = Math.floor((window.offsetX || 0) / bp);
    const endCol   = startCol + Math.ceil(w / bp) + 2;
    let   lastDay  = '';

    for (let col = startCol; col <= endCol; col += step) {
      const ts = colTimestamps[col];
      if (!ts) continue;
      const sx = Math.floor(col * bp - (window.offsetX || 0) + bp / 2);
      if (sx < 4 || sx > w - 4) continue;

      const d      = new Date(ts);
      const dayKey = `${d.getDate()}/${d.getMonth()}/${d.getFullYear()}`;
      const isNew  = dayKey !== lastDay;
      const label  = isNew
        ? `${d.getDate()}/${d.getMonth()+1}/${d.getFullYear()}`
        : fmtTime(ts);

      c.fillStyle = isNew ? '#ffe600cc' : '#ffe60066';
      c.fillText(label, sx - (isNew ? 20 : 13), h - axisH / 2);
      c.strokeStyle = '#ffe60044'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(sx, h - axisH); c.lineTo(sx, h - axisH + (isNew ? 5 : 3)); c.stroke();
      if (isNew) lastDay = dayKey;
    }
    c.restore();
  }

  // ----------------------------------------------------------
  // PATCH drawChart
  // ----------------------------------------------------------
  function patchDrawChart() {
    if (window.drawChart && window.drawChart._ce) return;
    const orig = window.drawChart;
    if (!orig) return;
    const patched = function() {
      orig();
      drawTimeAxis();
      if (nearLeftEdge() && !fetchingOld && !isSwitching) fetchOlderHistory();
    };
    patched._ce = true;
    window.drawChart = patched;
  }

  // ----------------------------------------------------------
  // INTERVAL SELECTOR
  // ----------------------------------------------------------
  function buildIntervalSelector() {
    if (document.getElementById('intervalSelector')) return;
    const sel = document.createElement('select');
    sel.id = 'intervalSelector'; sel.className = 'asset-selector'; sel.title = 'Interval';
    INTERVALS.forEach(iv => {
      const opt = document.createElement('option');
      opt.value = iv; opt.textContent = iv;
      if (iv === interval) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', (e) => {
      if (isSwitching) { e.target.value = interval; return; }
      interval = e.target.value;
      loadAsset(pair, interval);
    });
    const assetSel = document.getElementById('assetSelector');
    if (assetSel && assetSel.parentNode) {
      assetSel.parentNode.insertBefore(sel, assetSel.nextSibling);
    }
  }

  // ----------------------------------------------------------
  // ASSET SELECTOR
  // ----------------------------------------------------------
  function wireAssetSelector() {
    const sel = document.getElementById('assetSelector');
    if (!sel) return;
    sel.addEventListener('change', (e) => {
      const p = e.target.value;
      if (!p || p === pair || isSwitching) return;
      console.log('[ASSET SWITCH]', p);
      loadAsset(p, interval);
    });
  }

  // ----------------------------------------------------------
  // PUBLIC API
  // ----------------------------------------------------------
  return {
    init() {
      ['viewBadge','jumpLiveBtn'].forEach(id => {
        const el = document.getElementById(id);
        if (el && el.parentNode) el.parentNode.removeChild(el);
      });

      buildIntervalSelector();
      patchDrawChart();
      wireAssetSelector();

      const saved    = loadSaved();
      const restored = restoreFromStorage(saved);

      if (restored) {
        notify('Chart restored', '');
        wsStart();
      } else {
        loadAsset(pair, interval);
      }
    },

    clearStorage() { clearSaved(); },

    switchAsset(p, iv) {
      if (isSwitching) return;
      loadAsset(p, iv || interval);
    },

    getState: () => ({ symbol, pair, interval, isSwitching })
  };

})();
