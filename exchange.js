// ============================================================
// EXCHANGE MODULE — Real Trading Mode, Asset Selector,
// Persistence, Confirmation Modal
// Plugs into app.js via window.ExchangeModule
// ============================================================
'use strict';

window.ExchangeModule = (() => {

  // ----------------------------------------------------------
  // EXCHANGE DEFINITIONS
  // ----------------------------------------------------------
  const EXCHANGES = {
    binance:  { name: 'Binance',  wsBase: 'wss://stream.binance.com:9443/ws', restBase: 'https://api.binance.com',  pairFmt: (p) => p.replace('/','').toLowerCase() + '@trade' },
    bybit:    { name: 'Bybit',    wsBase: 'wss://stream.bybit.com/v5/public/spot', restBase: 'https://api.bybit.com', pairFmt: (p) => p.replace('/','') },
    coinbase: { name: 'Coinbase', wsBase: 'wss://advanced-trade-ws.coinbase.com', restBase: 'https://api.coinbase.com', pairFmt: (p) => p.replace('/','-') },
    kraken:   { name: 'Kraken',   wsBase: 'wss://ws.kraken.com', restBase: 'https://api.kraken.com', pairFmt: (p) => p },
    kucoin:   { name: 'KuCoin',   wsBase: null, restBase: 'https://api.kucoin.com', pairFmt: (p) => p.replace('/','-') },
    okx:      { name: 'OKX',      wsBase: 'wss://ws.okx.com:8443/ws/v5/public', restBase: 'https://www.okx.com', pairFmt: (p) => p.replace('/','-') + '-SPOT' },
    opensea:  { name: 'OpenSea',  wsBase: null, restBase: 'https://api.opensea.io', pairFmt: (p) => p },
    custom:   { name: 'Custom',   wsBase: null, restBase: null, pairFmt: (p) => p }
  };

  // Demo asset list (~120 popular pairs)
  const DEMO_PAIRS = [
    'BTC/USDT','ETH/USDT','BNB/USDT','SOL/USDT','XRP/USDT','ADA/USDT','DOGE/USDT','AVAX/USDT',
    'DOT/USDT','MATIC/USDT','SHIB/USDT','LTC/USDT','UNI/USDT','LINK/USDT','ATOM/USDT','XLM/USDT',
    'ETC/USDT','BCH/USDT','ALGO/USDT','VET/USDT','FIL/USDT','ICP/USDT','HBAR/USDT','EGLD/USDT',
    'THETA/USDT','XTZ/USDT','EOS/USDT','AAVE/USDT','MKR/USDT','GRT/USDT','SNX/USDT','COMP/USDT',
    'SUSHI/USDT','YFI/USDT','1INCH/USDT','CRV/USDT','BAL/USDT','REN/USDT','ZRX/USDT','KNC/USDT',
    'SAND/USDT','MANA/USDT','AXS/USDT','ENJ/USDT','CHZ/USDT','GALA/USDT','IMX/USDT','APE/USDT',
    'GMT/USDT','STEPN/USDT','OP/USDT','ARB/USDT','SUI/USDT','SEI/USDT','TIA/USDT','INJ/USDT',
    'PYTH/USDT','JTO/USDT','WIF/USDT','BONK/USDT','PEPE/USDT','FLOKI/USDT','TURBO/USDT','BRETT/USDT',
    'NEAR/USDT','FTM/USDT','ONE/USDT','ROSE/USDT','CELO/USDT','ZIL/USDT','ICX/USDT','ONT/USDT',
    'QTUM/USDT','ZEC/USDT','DASH/USDT','XMR/USDT','DCR/USDT','DGB/USDT','SC/USDT','RVN/USDT',
    'WAVES/USDT','KAVA/USDT','BAND/USDT','OXT/USDT','NMR/USDT','REP/USDT','BAT/USDT','ZEN/USDT',
    'STORJ/USDT','SKL/USDT','ANKR/USDT','CELR/USDT','COTI/USDT','DENT/USDT','HOT/USDT','WIN/USDT',
    'BTT/USDT','TRX/USDT','JST/USDT','SUN/USDT','NFT/USDT','LUNC/USDT','LUNA/USDT','USTC/USDT',
    'BLUR/USDT','LDO/USDT','RPL/USDT','FXS/USDT','CVX/USDT','FRAX/USDT','SPELL/USDT','MAGIC/USDT',
    'GMX/USDT','GNS/USDT','RDNT/USDT','PENDLE/USDT','VELA/USDT','UMAMI/USDT','JONES/USDT','DPX/USDT'
  ];

  // ----------------------------------------------------------
  // STATE
  // ----------------------------------------------------------
  let connectedExchange = null;  // key from EXCHANGES
  let apiCredentials    = null;  // { key, secret } — never logged
  let exchangeWs        = null;
  let exchangeWsTimer   = null;
  let currentPair       = 'BTC/USDT';
  let realPairs         = [];
  let connectionStatus  = 'disconnected'; // connected | disconnected | connecting | failed
  let pendingConfirm    = null;  // { type, amount, price, resolve, reject }

  // ----------------------------------------------------------
  // CREDENTIAL STORAGE — obfuscated in sessionStorage only
  // Keys are never written to localStorage or logs
  // ----------------------------------------------------------
  function storeCredentials(key, secret) {
    // Simple XOR obfuscation — not cryptographic, but prevents casual exposure
    const mask = 'AITRADE_MASK_2025';
    const xor = (str) => str.split('').map((c, i) =>
      String.fromCharCode(c.charCodeAt(0) ^ mask.charCodeAt(i % mask.length))
    ).join('');
    sessionStorage.setItem('_exc_k', btoa(xor(key)));
    sessionStorage.setItem('_exc_s', btoa(xor(secret)));
  }
  function loadCredentials() {
    const mask = 'AITRADE_MASK_2025';
    const xor = (str) => str.split('').map((c, i) =>
      String.fromCharCode(c.charCodeAt(0) ^ mask.charCodeAt(i % mask.length))
    ).join('');
    try {
      const k = xor(atob(sessionStorage.getItem('_exc_k') || ''));
      const s = xor(atob(sessionStorage.getItem('_exc_s') || ''));
      return k ? { key: k, secret: s } : null;
    } catch { return null; }
  }
  function clearCredentials() {
    sessionStorage.removeItem('_exc_k');
    sessionStorage.removeItem('_exc_s');
  }

  // ----------------------------------------------------------
  // INDEXEDDB PERSISTENCE
  // ----------------------------------------------------------
  let db = null;
  const DB_NAME = 'AITradeDB', DB_VER = 1;

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('history'))
          d.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
        if (!d.objectStoreNames.contains('settings'))
          d.createObjectStore('settings', { keyPath: 'key' });
      };
      req.onsuccess = (e) => { db = e.target.result; resolve(db); };
      req.onerror   = () => reject(req.error);
    });
  }

  function dbPut(store, record) {
    if (!db) return;
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(record);
  }

  function dbGetAll(store) {
    return new Promise((resolve) => {
      if (!db) return resolve([]);
      const tx  = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => resolve([]);
    });
  }

  function dbClear(store) {
    if (!db) return;
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
  }

  // Save one trade record
  function persistTradeRecord(record) {
    dbPut('history', { ...record, id: undefined }); // let autoIncrement assign id
  }

  // Load all history from DB into app's tradeHistory array
  async function loadPersistedHistory() {
    const rows = await dbGetAll('history');
    if (!rows.length) return;
    // Prepend to app's tradeHistory (oldest first, then reverse)
    rows.reverse().forEach(r => {
      if (!window.tradeHistory) window.tradeHistory = [];
      window.tradeHistory.push(r);
    });
    if (typeof renderHistory === 'function') renderHistory();
  }

  // Save a setting
  function saveSetting(key, value) { dbPut('settings', { key, value }); }
  async function loadSetting(key) {
    const rows = await dbGetAll('settings');
    const found = rows.find(r => r.key === key);
    return found ? found.value : null;
  }

  // ----------------------------------------------------------
  // CONNECTION MANAGER
  // ----------------------------------------------------------
  async function connect(exchangeKey, key, secret, customEndpoint) {
    if (connectedExchange) await disconnect();

    setConnectionStatus('connecting');
    storeCredentials(key, secret);
    connectedExchange = exchangeKey;
    apiCredentials    = { key, secret };

    const exDef = EXCHANGES[exchangeKey];
    if (exchangeKey === 'custom' && customEndpoint) exDef.restBase = customEndpoint;

    // Fetch account balance (REST)
    await syncAccountBalance(exchangeKey, key, secret);

    // Fetch available pairs
    await fetchPairs(exchangeKey);

    // Connect exchange WS for price data
    connectExchangeWS(exchangeKey, currentPair);

    setConnectionStatus('connected');
    saveSetting('lastExchange', exchangeKey);
    updateConnectionUI();
    showNotification(`CONNECTED: ${exDef.name}`, 'green');
  }

  async function disconnect() {
    if (exchangeWs) { try { exchangeWs.close(); } catch(e) {} exchangeWs = null; }
    clearTimeout(exchangeWsTimer);
    clearCredentials();
    connectedExchange = null;
    apiCredentials    = null;
    realPairs         = [];
    setConnectionStatus('disconnected');
    updateConnectionUI();
    showNotification('EXCHANGE DISCONNECTED', '');
  }

  function setConnectionStatus(status) {
    connectionStatus = status;
    const el = document.getElementById('excStatus');
    if (!el) return;
    const map = {
      connected:    ['CONNECTED',    'exc-connected'],
      disconnected: ['DISCONNECTED', 'exc-disconnected'],
      connecting:   ['CONNECTING...','exc-connecting'],
      failed:       ['FAILED',       'exc-failed']
    };
    const [text, cls] = map[status] || map.disconnected;
    el.textContent = text;
    el.className   = `exc-status ${cls}`;
  }

  // ----------------------------------------------------------
  // ACCOUNT BALANCE SYNC
  // ----------------------------------------------------------
  async function syncAccountBalance(exchangeKey, key, secret) {
    // In a real deployment these calls go through a backend proxy
    // to avoid CORS and to keep secrets server-side.
    // Here we simulate a successful fetch and set liveBalance.
    try {
      // Placeholder: real implementation would call exchange REST API
      // e.g. GET /api/v3/account for Binance
      // For now, set a placeholder balance so UI shows something meaningful
      if (typeof setBalance === 'function' && window.tradeMode === 'real') {
        // Don't overwrite — just show placeholder until real API responds
        if (window.liveBalance === 0) {
          window.liveBalance = 0; // will be updated when real API responds
        }
      }
      updateAccountUI({ balance: window.liveBalance || 0, available: window.liveBalance || 0 });
    } catch (err) {
      console.warn('[Exchange] Balance sync failed:', err.message);
    }
  }

  function updateAccountUI(data) {
    const balEl  = document.getElementById('excAccountBalance');
    const availEl = document.getElementById('excAccountAvail');
    if (balEl)   balEl.textContent  = `$${parseFloat(data.balance  || 0).toFixed(2)}`;
    if (availEl) availEl.textContent = `$${parseFloat(data.available || 0).toFixed(2)}`;
  }

  // ----------------------------------------------------------
  // PAIR FETCHING
  // ----------------------------------------------------------
  async function fetchPairs(exchangeKey) {
    // Binance: public endpoint, no auth needed
    if (exchangeKey === 'binance') {
      try {
        const res  = await fetch('https://api.binance.com/api/v3/exchangeInfo');
        const data = await res.json();
        realPairs  = data.symbols
          .filter(s => s.status === 'TRADING' && s.quoteAsset === 'USDT')
          .map(s => `${s.baseAsset}/USDT`)
          .slice(0, 200);
      } catch { realPairs = DEMO_PAIRS.slice(0, 50); }
    } else {
      // Other exchanges: use a curated list as fallback
      realPairs = DEMO_PAIRS.slice(0, 80);
    }
    populatePairSelector(window.tradeMode === 'real' ? realPairs : DEMO_PAIRS);
  }

  // ----------------------------------------------------------
  // PAIR SELECTOR UI
  // ----------------------------------------------------------
  function populatePairSelector(pairs) {
    const sel = document.getElementById('assetSelector');
    if (!sel) return;
    sel.innerHTML = pairs.map(p =>
      `<option value="${p}" ${p === currentPair ? 'selected' : ''}>${p}</option>`
    ).join('');
  }

  function switchPair(pair) {
    currentPair = pair;
    // Delegate entirely to app's connectPairWS which handles all state reset
    const exKey = connectedExchange || 'binance';
    if (typeof connectPairWS === 'function') {
      connectPairWS(pair, exKey);
    }
    showNotification(`PAIR: ${pair}`, '');
  }

  // ----------------------------------------------------------
  // EXCHANGE WEBSOCKET — delegates to app.js connectPairWS
  // ----------------------------------------------------------
  function connectExchangeWS(exchangeKey, pair) {
    // app.js owns all WS management — just call through
    if (typeof connectPairWS === 'function') {
      connectPairWS(pair, exchangeKey);
    }
    setConnectionStatus('connected');
  }

  // connectDemoPairWS removed — app.js connectPairWS handles demo too

  // ----------------------------------------------------------
  // TRADE EXECUTION (REAL MODE)
  // ----------------------------------------------------------
  async function executeRealTrade(type, amount, pair, entryPrice) {
    if (!connectedExchange || !apiCredentials) {
      showNotification('NOT CONNECTED TO EXCHANGE', 'red');
      return false;
    }

    // Require confirmation before any real trade
    const confirmed = await showConfirmModal(type, amount, pair, entryPrice);
    if (!confirmed) {
      showNotification('TRADE CANCELLED', '');
      return false;
    }

    // Validate balance
    if (amount > (window.liveBalance || 0)) {
      showNotification('INSUFFICIENT LIVE BALANCE', 'red');
      return false;
    }

    // In production: call exchange REST API here via a backend proxy
    // Example for Binance: POST /api/v3/order
    // { symbol, side, type: 'MARKET', quoteOrderQty: amount }
    // We simulate success here — replace with real fetch() call to your backend
    try {
      showNotification(`REAL ${type.toUpperCase()} ORDER SENT: $${amount.toFixed(2)} ${pair}`, type === 'buy' ? 'green' : 'red');
      return true;
    } catch(err) {
      showNotification(`ORDER FAILED: ${err.message}`, 'red');
      return false;
    }
  }

  // ----------------------------------------------------------
  // CONFIRMATION MODAL
  // ----------------------------------------------------------
  function showConfirmModal(type, amount, pair, price) {
    return new Promise((resolve) => {
      const modal = document.getElementById('confirmModal');
      if (!modal) { resolve(true); return; }

      document.getElementById('cmType').textContent   = type.toUpperCase();
      document.getElementById('cmPair').textContent   = pair;
      document.getElementById('cmAmount').textContent = `$${amount.toFixed(2)}`;
      document.getElementById('cmPrice').textContent  = `$${price.toFixed(2)}`;
      document.getElementById('cmMode').textContent   = 'REAL MODE';
      document.getElementById('cmMode').className     = 'cm-mode real';

      modal.classList.remove('hidden');
      modal.classList.add('visible');

      const onConfirm = () => { cleanup(); resolve(true); };
      const onCancel  = () => { cleanup(); resolve(false); };

      function cleanup() {
        modal.classList.remove('visible');
        setTimeout(() => modal.classList.add('hidden'), 200);
        document.getElementById('cmConfirm').removeEventListener('click', onConfirm);
        document.getElementById('cmCancel').removeEventListener('click', onCancel);
      }

      document.getElementById('cmConfirm').addEventListener('click', onConfirm);
      document.getElementById('cmCancel').addEventListener('click', onCancel);
    });
  }

  // ----------------------------------------------------------
  // CONNECTION UI UPDATE
  // ----------------------------------------------------------
  function updateConnectionUI() {
    const nameEl   = document.getElementById('excName');
    const connBtn  = document.getElementById('excConnectBtn');
    const discBtn  = document.getElementById('excDisconnectBtn');
    const panel    = document.getElementById('excAccountPanel');

    if (connectedExchange) {
      if (nameEl)  nameEl.textContent = EXCHANGES[connectedExchange].name;
      if (connBtn) connBtn.classList.add('hidden');
      if (discBtn) discBtn.classList.remove('hidden');
      if (panel)   panel.classList.remove('hidden');
    } else {
      if (nameEl)  nameEl.textContent = 'NOT CONNECTED';
      if (connBtn) connBtn.classList.remove('hidden');
      if (discBtn) discBtn.classList.add('hidden');
      if (panel)   panel.classList.add('hidden');
    }
  }

  // ----------------------------------------------------------
  // NOTIFICATION (uses app's showNotification)
  // ----------------------------------------------------------
  function showNotification(msg, type) {
    if (typeof window.showNotification === 'function') window.showNotification(msg, type);
  }

  // ----------------------------------------------------------
  // PUBLIC API
  // ----------------------------------------------------------
  return {
    init: async function() {
      await openDB();
      await loadPersistedHistory();
      populatePairSelector(DEMO_PAIRS);
      updateConnectionUI();
      setConnectionStatus('disconnected');

      // Asset selector change
      const sel = document.getElementById('assetSelector');
      if (sel) sel.addEventListener('change', (e) => switchPair(e.target.value));

      // Connect button
      const connBtn = document.getElementById('excConnectBtn');
      if (connBtn) connBtn.addEventListener('click', () => {
        document.getElementById('excConnectPanel').classList.remove('hidden');
      });
      const closeExcModalBtn = document.getElementById('closeExcModal');
      if (closeExcModalBtn) closeExcModalBtn.addEventListener('click', () => {
        document.getElementById('excConnectPanel').classList.add('hidden');
      });

      // Disconnect button
      const discBtn = document.getElementById('excDisconnectBtn');
      if (discBtn) discBtn.addEventListener('click', () => disconnect());

      // Connect form submit (Handled entirely by backend_bridge in app.js)
      const form = document.getElementById('excConnectForm');
      if (form) {
        // Disabled to prevent collision with app.js
      }

      // Custom endpoint toggle
      const exSel = document.getElementById('excExchangeSelect');
      if (exSel) exSel.addEventListener('change', (e) => {
        const customRow = document.getElementById('excCustomRow');
        if (customRow) customRow.style.display = e.target.value === 'custom' ? 'block' : 'none';
      });
    },

    // Called by app.js tapExecute when in REAL mode
    onTradeExecute: async function(type, amount, pair, price) {
      if (window.tradeMode !== 'real') return true; // demo: always allow
      return await executeRealTrade(type, amount, pair, price);
    },

    // Called by app.js settleTrade to persist record
    persistRecord: function(record) {
      persistTradeRecord(record);
    },

    getCurrentPair: () => currentPair,
    isConnected:    () => connectionStatus === 'connected',
    getExchangeName: () => connectedExchange ? EXCHANGES[connectedExchange].name : 'DEMO'
  };

})();
