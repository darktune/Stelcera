// ============================================================
// BACKEND BRIDGE
// Connects frontend to Python backend WebSocket.
// When backend is available: routes price + trade data through it.
// When backend is unavailable: falls back to existing demo mode.
// Does NOT break any existing functionality.
// ============================================================
'use strict';

window.BackendBridge = (() => {

  const WS_URL     = 'ws://localhost:8000/ws';
  const RETRY_MAX  = 5;

  let socket       = null;
  let retryCount   = 0;
  let retryTimer   = null;
  let connected    = false;
  let useBackend   = false; // true only when backend WS is confirmed open
  const sendQueue  = [];

  function setEngineOverlay(show) {
    let overlay = document.getElementById('engineOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'engineOverlay';
      overlay.style.position = 'fixed';
      overlay.style.top = '0'; overlay.style.left = '0'; overlay.style.width = '100vw'; overlay.style.height = '100vh';
      overlay.style.background = 'rgba(5,5,5,0.9)';
      overlay.style.backdropFilter = 'blur(10px)';
      overlay.style.zIndex = '99999';
      overlay.style.display = 'flex';
      overlay.style.flexDirection = 'column';
      overlay.style.alignItems = 'center';
      overlay.style.justifyContent = 'center';
      overlay.style.color = '#ffe600';
      overlay.style.fontFamily = '"Share Tech Mono", monospace';
      
      const text = document.createElement('div');
      text.id = 'engineOverlayText';
      text.textContent = 'CONNECTING TO STELCERA TRADING ENGINE...';
      text.style.fontSize = '24px';
      text.style.letterSpacing = '2px';
      text.style.textShadow = '0 0 10px rgba(255, 230, 0, 0.5)';
      
      const hint = document.createElement('div');
      hint.textContent = 'Ensure Python backend is running (python -m uvicorn main:app)';
      hint.style.fontSize = '14px';
      hint.style.marginTop = '15px';
      hint.style.color = '#888';
      
      overlay.appendChild(text);
      overlay.appendChild(hint);
      document.body?.appendChild(overlay);
    }
    overlay.style.display = show ? 'flex' : 'none';
  }

  // ----------------------------------------------------------
  // CONNECT
  // ----------------------------------------------------------
  function connect() {
    setEngineOverlay(true);
    if (socket && socket.readyState === WebSocket.OPEN) return;

    try {
      socket = new WebSocket(WS_URL);

      socket.onopen = () => {
        setEngineOverlay(false);
        connected   = true;
        useBackend  = true;
        retryCount  = 0;
        console.log('[BRIDGE] connected to backend');
        updateBadge('BACKEND', 'green');
        
        // Request current state
        send({ action: 'get_state' });
        
        // Flush queue
        while (sendQueue.length > 0) {
          const msg = sendQueue.shift();
          send(msg);
        }
      };

      socket.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          handleMessage(msg);
        } catch(e) { /* ignore */ }
      };

      socket.onerror = () => {
        console.error('[BRIDGE] Backend connection error');
        useBackend = false;
      };

      socket.onclose = () => {
        setEngineOverlay(true);
        connected  = false;
        useBackend = false;
        updateBadge('DISCONNECTED', 'demo');
        if (retryCount < RETRY_MAX) {
          retryCount++;
          const delay = Math.min(1000 * retryCount, 10000);
          const overlayText = document.getElementById('engineOverlayText');
          if (overlayText) overlayText.textContent = `CONNECTION LOST. RECONNECTING IN ${delay/1000}s...`;
          retryTimer = setTimeout(connect, delay);
        } else {
          const overlayText = document.getElementById('engineOverlayText');
          if (overlayText) overlayText.textContent = 'ENGINE UNAVAILABLE. PLEASE RESTART BACKEND.';
        }
      };

    } catch(e) {
      console.error('[BRIDGE] WebSocket instantiation failed', e);
      useBackend = false;
    }
  }

  // ----------------------------------------------------------
  // SEND
  // ----------------------------------------------------------
  function send(msg) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg));
    } else {
      sendQueue.push(msg);
    }
  }

  // ----------------------------------------------------------
  // MESSAGE HANDLER
  // Routes backend messages into the existing app state.
  // ----------------------------------------------------------
  function handleMessage(msg) {
    switch (msg.type) {

      case 'price_update':
        // Only process updates for the current symbol
        const updateSymbol = msg.symbol || msg.pair;
        const currentSymbol = (window.currentPair || 'BTC/USDT').replace('/', '').toUpperCase();
        if (updateSymbol && updateSymbol.replace('/', '').toUpperCase() !== currentSymbol) {
          console.log(`[BRIDGE] Ignoring price update for ${updateSymbol}, current is ${currentSymbol}`);
          return;
        }
        
        if (msg.price > 0) {
          window.livePrice = msg.price;
          const priceEl = document.getElementById('priceDisplay');
          if (priceEl) {
            priceEl.textContent = `${window.currentPair || 'BTC/USDT'}: $${msg.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
          }
        }
        if (Array.isArray(msg.blocks)) applyBlocks(msg.blocks);
        if (msg.stop_loss !== undefined) {
          window.currentStopLoss = msg.stop_loss || 0;
        }
        
        if (msg.balance !== undefined) {
          if (window.tradeMode === 'real') {
            window.liveBalance = msg.balance;
          }
          if (typeof window.refreshBalanceDisplay === 'function') {
            window.refreshBalanceDisplay();
          }
        }
        syncTradesFromBackend(msg.trades || [], msg.trade || null);
        
        if (typeof window.drawGrid === 'function') window.drawGrid();
        if (typeof window.drawChart === 'function') window.drawChart();
        break;

      case 'sim_paused_result':
        console.log('[BRIDGE] Sim paused result:', msg.paused);
        break;

      case 'sim_speed_result':
        console.log('[BRIDGE] Sim speed result:', msg.speed);
        break;

      case 'state':
        applyState(msg);
        break;

      case 'trade_result':
      case 'close_result':
        if (!msg.success && msg.error) {
          if (typeof window.showNotification === 'function') {
            window.showNotification(`TRADE ERROR: ${msg.error}`, 'red');
          }
        }
        break;

      case 'trade_opened':
        if (msg.trade) syncTradesFromBackend([msg.trade], msg.trade);
        if (msg.balance !== undefined) updateBalance(msg.balance);
        if (typeof window.showNotification === 'function') {
          window.showNotification(`${msg.trade.side.toUpperCase()} opened @ $${msg.trade.entry_price}`, 'green');
        }
        break;

      case 'trade_closed':
        if (msg.record) {
          removeClosedTrade(msg.record.id);
        }
        if (msg.record) {
          // Add to trade history
          if (window.tradeHistory) {
            window.tradeHistory.unshift({
              type:   msg.record.side.toUpperCase(),
              reason: msg.record.reason,
              pnl:    msg.record.pnl_pct,
              amount: msg.record.amount,
              time:   new Date(msg.record.timestamp * 1000).toLocaleTimeString(),
              mode:   msg.record.mode,
            });
            if (typeof window.renderHistory === 'function') window.renderHistory();
          }
        }
        if (msg.balance !== undefined) updateBalance(msg.balance);
        break;

      case 'exchange_connected':
        if (typeof window.setExchangeConnectionState === 'function') {
          window.setExchangeConnectionState({
            connected: true,
            exchange: msg.exchange || null,
            status: 'connected',
          });
        }
        if (typeof window.showNotification === 'function') {
          window.showNotification(`CONNECTED: ${msg.exchange.toUpperCase()} | $${msg.balance}`, 'green');
        }
        updateBalance(msg.balance);
        updateBadge('REAL', 'red');
        break;

      case 'exchange_disconnected':
        if (typeof window.setExchangeConnectionState === 'function') {
          window.setExchangeConnectionState({
            connected: false,
            exchange: null,
            status: 'disconnected',
          });
        }
        updateBadge('DEMO', '');
        break;

      case 'exchange_error':
        if (typeof window.setExchangeConnectionState === 'function') {
          window.setExchangeConnectionState({
            connected: false,
            exchange: null,
            status: 'failed',
          });
        }
        if (typeof window.showNotification === 'function') {
          window.showNotification(`EXCHANGE ERROR: ${msg.message}`, 'red');
        }
        break;

      case 'mode_changed':
        if (typeof window.setMode === 'function') window.setMode(msg.mode);
        updateBalance(msg.balance);
        break;

      case 'ws_status':
        const statusEl = document.getElementById('wsStatus');
        if (statusEl) {
          if (msg.status === 'connected') {
            statusEl.textContent = 'CONNECTED'; statusEl.className = 'ws-badge connected';
          } else {
            statusEl.textContent = 'RECONNECTING'; statusEl.className = 'ws-badge disconnected';
          }
        }
        break;

      case 'symbol_switched':
        if (msg.symbol) {
          window.currentPair = msg.pair || msg.symbol;
          console.log(`[BRIDGE] Symbol switched to: ${window.currentPair}`);
          const pEl = document.getElementById('priceDisplay');
          if (pEl) pEl.textContent = `${window.currentPair}: Loading...`;
          updateAssetBadge(window.currentPair);
        }
        if (typeof window.showNotification === 'function') {
          window.showNotification(`PAIR: ${msg.symbol}`, 'green');
        }
        break;

      case 'history':
        if (msg.records && window.tradeHistory !== undefined) {
          window.tradeHistory = msg.records.map(r => ({
            type:   r.side.toUpperCase(),
            reason: r.reason,
            pnl:    r.pnl_pct,
            amount: r.amount,
            time:   new Date(r.timestamp * 1000).toLocaleTimeString(),
            mode:   r.mode,
          }));
          if (typeof window.renderHistory === 'function') window.renderHistory();
        }
        break;

      case 'stop_loss_updated':
        window.currentStopLoss = msg.stop_loss || 0;
        window.currentStopRow = msg.stop_row ?? window.currentStopRow ?? null;
        if (window.activeTrade && window.activeTrade.tradeId === msg.trade_id) {
          window.activeTrade = {
            ...window.activeTrade,
            stopRow: msg.stop_row ?? window.activeTrade.stopRow,
          };
        }
        if (window.activeTrades && msg.trade_id) {
          window.activeTrades = window.activeTrades.map(trade => (
            trade.id === msg.trade_id
              ? { ...trade, stopRow: msg.stop_row ?? trade.stopRow }
              : trade
          ));
        }
        if (typeof window.drawChart === 'function') window.drawChart();
        break;
    }
  }

  // ----------------------------------------------------------
  // APPLY FULL STATE
  // ----------------------------------------------------------
  function applyState(s) {
    if (s.mode && typeof window.setMode === 'function') {
      window.setMode(s.mode);
    }
    if (typeof window.setExchangeConnectionState === 'function') {
      window.setExchangeConnectionState({
        connected: !!s.is_exchange_connected,
        exchange: s.exchange || null,
        status: s.exchange_status || 'disconnected',
      });
    }
    if (s.demo_balance !== undefined) window.demoBalance = s.demo_balance;
    if (s.live_balance !== undefined) window.liveBalance = s.live_balance;
    if (typeof window.refreshBalanceDisplay === 'function') window.refreshBalanceDisplay();
    if (s.selected_pair && window.currentPair !== s.selected_pair) {
      window.currentPair = s.selected_pair;
    }
    if (Array.isArray(s.blocks)) applyBlocks(s.blocks);
    window.currentStopLoss = 0;
    window.currentStopRow = null;
    syncTradesFromBackend(s.active_trades || [], (s.active_trades || [])[0] || null);

    // Draw chart immediately upon loading the state
    if (typeof window.drawGrid === 'function') window.drawGrid();
    if (typeof window.drawChart === 'function') window.drawChart();
  }

  function updateBalance(bal) {
    if (window.tradeMode === 'real') {
      window.liveBalance = bal;
    } else {
      window.demoBalance = bal;
    }
    if (typeof window.refreshBalanceDisplay === 'function') window.refreshBalanceDisplay();
  }

  function applyBlocks(rawBlocks) {
    window.blocks = rawBlocks.map(b => ({
      col: b.col ?? b.x,
      row: b.row ?? b.y,
      type: b.type,
      state: 'normal',
      price: b.price,
      timestamp: b.timestamp,
    }));
    if (window.blocks.length > 0) {
      const last = window.blocks[window.blocks.length - 1];
      window.currentLevel = last.row;
      window.currentCol = last.col;
      
      // Data-driven viewport: calculate offsets directly from block data
      // This mirrors how TradingView/MT5 always compute viewport from data
      if (window.cameraFollowing) {
        const bp = window.blockSize || 40;
        const canvas = window.chartCanvas;
        const cw = (canvas && canvas.width > 100) ? canvas.width : 1200;
        const ch = (canvas && canvas.height > 100) ? canvas.height : 600;
        
        // X: Show latest blocks with 5-block right margin
        window.offsetX = Math.max(0, last.col * bp - cw + bp * 6);
        // Y: Center vertically on current price level
        window.offsetY = last.row * bp - Math.floor(ch / 2) + Math.floor(bp / 2);
      }
    }
  }

  function findStopRow(stopPrice) {
    if (!stopPrice || !window.blocks || window.blocks.length === 0) return null;
    let best = window.blocks[0];
    let bestDelta = Math.abs((best.price || stopPrice) - stopPrice);
    window.blocks.forEach(block => {
      const delta = Math.abs((block.price || stopPrice) - stopPrice);
      if (delta < bestDelta) {
        best = block;
        bestDelta = delta;
      }
    });
    return best.row;
  }

  function syncTradesFromBackend(trades, primaryTrade = null) {
    const existing = new Map((window.activeTrades || []).map(t => [t.id, t]));
    const nextTrades = (trades || []).map(bt => {
      const prev = existing.get(bt.id) || {};
      const mapped = {
        ...prev,
        id: bt.id,
        type: bt.side,
        entryPrice: bt.entry_price,
        amount: bt.amount,
        currentValue: bt.amount + (bt.pnl || 0),
        profitLoss: bt.pnl || 0,
        profitLossPercent: bt.pnl_pct || 0,
        stopRow: bt.stop_row ?? findStopRow(bt.stop_loss),
        isOpen: bt.is_open !== false,
        mode: bt.mode,
        timestamp: bt.timestamp,
      };
      return mapped;
    });

    existing.forEach((trade, tradeId) => {
      if (!nextTrades.find(t => t.id === tradeId) && trade.markerEl && typeof window.removeTradeMarker === 'function') {
        window.removeTradeMarker(trade);
      }
    });

    window.activeTrades = nextTrades;
    nextTrades.forEach(trade => {
      if (!trade.markerEl && typeof window.createTradeMarker === 'function') {
        window.createTradeMarker(trade);
      }
    });

    const focus = primaryTrade
      ? nextTrades.find(t => t.id === primaryTrade.id) || null
      : (nextTrades[0] || null);

    window.currentStopLoss = primaryTrade ? (primaryTrade.stop_loss || 0) : 0;
    window.currentStopRow = focus ? (focus.stopRow ?? null) : null;

    window.activeTrade = focus ? {
      tradeId: focus.id,
      type: focus.type,
      entryPrice: focus.entryPrice,
      amount: focus.amount,
      stopRow: focus.stopRow,
      trailBlocks: primaryTrade ? (primaryTrade.trail_blocks || 0) : 0,
    } : null;

    const activeEl = document.getElementById('activeTrade');
    const statusEl = document.getElementById('tradeStatus');
    if (focus) {
      if (activeEl) {
        activeEl.textContent =
          `${focus.type.toUpperCase()} $${focus.amount.toFixed(2)}\nENTRY: $${focus.entryPrice.toFixed(2)}\nVALUE: $${focus.currentValue.toFixed(2)}\nP&L: ${focus.profitLoss >= 0 ? '+' : ''}${focus.profitLossPercent.toFixed(3)}%`;
      }
      if (statusEl) {
        statusEl.textContent = focus.type.toUpperCase();
        statusEl.className = `trade-status ${focus.type}`;
      }
    } else {
      if (activeEl) activeEl.textContent = 'NONE';
      if (statusEl) {
        statusEl.textContent = 'NO TRADE';
        statusEl.className = 'trade-status';
      }
      window.currentStopLoss = 0;
      window.currentStopRow = null;
    }

    if (typeof window.refreshCloseButtons === 'function') window.refreshCloseButtons();
    if (typeof window.updateTradeMarkers === 'function') window.updateTradeMarkers();
  }

  function removeClosedTrade(tradeId) {
    if (!tradeId) return;
    const existing = window.activeTrades || [];
    const closing = existing.find(trade => trade.id === tradeId);
    if (closing && closing.markerEl && typeof window.removeTradeMarker === 'function') {
      window.removeTradeMarker(closing);
    }

    const remaining = existing.filter(trade => trade.id !== tradeId);
    const primary = remaining[0]
      ? {
          id: remaining[0].id,
          trail_blocks: remaining[0].trailBlocks || 0,
        }
      : null;

    syncTradesFromBackend(
      remaining.map(trade => ({
        id: trade.id,
        side: trade.type,
        entry_price: trade.entryPrice,
        amount: trade.amount,
        pnl: trade.profitLoss || 0,
        pnl_pct: trade.profitLossPercent || 0,
        stop_loss: 0,
        stop_row: trade.stopRow,
        is_open: trade.isOpen !== false,
        mode: trade.mode,
        timestamp: trade.timestamp,
      })),
      primary,
    );
  }

  function updateBadge(text, color) {
    const badge = document.getElementById('modeBadge');
    if (!badge) return;
    badge.textContent = text === 'BACKEND' ? 'BACKEND' : (text === 'REAL' ? 'REAL MODE' : 'DEMO MODE');
    badge.className   = `mode-badge ${color === 'red' ? 'real' : color === 'green' ? 'connected' : 'demo'}`;
  }

  // ----------------------------------------------------------
  // PUBLIC API — called by frontend when user takes action
  // ----------------------------------------------------------
  return {
    connect,

    isConnected: () => connected && useBackend,

    // Route buy/sell through backend if connected, else use existing demo logic
    executeTrade(type, amount, symbol, stopLoss = 0, trailingStop = false, trailOffset = 0, entryPrice = 0) {
      if (!useBackend) return false;
      send({
        action:         type, // 'buy' or 'sell'
        symbol:         (symbol || window.currentPair || 'BTC/USDT').replace('/', '').toUpperCase(),
        amount,
        stop_loss:      stopLoss,
        trailing_stop:  trailingStop,
        trail_offset:   trailOffset,
        entry_price:    entryPrice,
      });
      return true; // handled by backend
    },

    closeTrade(tradeId) {
      if (!useBackend) return false;
      send({ action: 'close_trade', trade_id: tradeId });
      return true;
    },

    setStopLoss(tradeId, stopPrice) {
      send({ action: 'set_stop_loss', trade_id: tradeId, stop_price: stopPrice });
    },

    switchSymbol(pair) {
      send({ action: 'switch_symbol', pair });
    },

    connectExchange(exchange, apiKey, apiSecret) {
      // Use fetch POST /connect directly — WS may not be open yet
      fetch('http://localhost:8000/connect', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ exchange, api_key: apiKey, api_secret: apiSecret }),
      })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          handleMessage({ type: 'exchange_connected', exchange, balance: data.balance });
          console.log('[BRIDGE] exchange connected:', exchange, 'balance:', data.balance);
        } else {
          handleMessage({ type: 'exchange_error', message: data.error || 'Connection failed' });
        }
      })
      .catch(err => {
        console.warn('[BRIDGE] backend unreachable for connect:', err.message);
        // Also try via WS as fallback
        send({ action: 'connect_exchange', exchange, api_key: apiKey, api_secret: apiSecret });
      });
    },

    disconnectExchange() {
      send({ action: 'disconnect_exchange' });
    },

    setMode(mode) {
      send({ action: 'set_mode', mode });
    },

    getHistory() {
      send({ action: 'get_history' });
    },

    setSimPaused(paused) {
      send({ action: 'set_sim_paused', paused });
    },

    setSimSpeed(speed) {
      send({ action: 'set_sim_speed', speed });
    },
  };

})();

// Auto-connect on load — silently falls back to demo if backend unavailable
window.BackendBridge.connect();
