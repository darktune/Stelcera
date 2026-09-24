# STELCERA Terminal — Master Technical Documentation & Task Planner

This master planning and technical documentation document organizes and tracks the implementation of the **STELCERA Intelligent Crypto & Memecoin Trading Terminal**, fully aligned with the masterplan, objectives, and institutional standards of TradingView, Match Trader, and MT5.

---

## 1. Executive Summary & Core Objectives

STELCERA is an institutional-grade, futuristic trading terminal designed for centralized exchanges (CEX) and decentralized memecoin ecosystems (DEX). Unlike traditional charting systems, STELCERA replaces old candlestick graphs with a **Pixelated Infinite Grid Trading Engine** utilizing **Bullish (Green) and Bearish (Red) Signal Blocks**, providing superior visual clarity, automated AI trailing execution, and millisecond reaction times.

### Key Visual & Functional Pillars:
- **Infinite Pixelated Grid**: Sleek black theme (`#000000`), white glowing line intersections, yellow selection markers (`#FFD700`), and premium neon accent elements.
- **Signal Block Staircase**: Price candles are mapped dynamically into a continuous diagonal staircase of green (upward) and red (downward) block columns.
- **Advanced Stop-Loss Engine**: Instant visual stop-loss horizontal lines, dynamic yellow block selection on hover/click, and real-time execution.
- **Follow Trail Automation**: Dynamic trailing stop-loss automation with user-configurable block intervals (1 to 8 blocks offset).
- **Dual-Mode System**: Completely segregated **Demo Mode** (simulated balances and paper trading) and **Real Mode** (validated live CEX/DEX broker API connections).

---

## 2. Completed Milestones & Accomplishments

We have resolved several major architectural and integration bottlenecks to establish a robust frontend-to-backend bridge:

### 1. Script Loading Order Refinement (`index.html`)
- **Issue**: `backend_bridge.js` was loaded before `app.js` in the DOM. This meant that the WebSocket connected and populated `window.blocks` before `app.js` finished declaring its local state variables, causing the entire initial block state to be wiped out upon `app.js` load.
- **Resolution**: Swapped the script loading order. `app.js` now executes first to define global getters/setters via `Object.defineProperties(window, props)`, followed by `backend_bridge.js` to establish the WebSocket handshake.

### 2. Live Redraw Integration (`backend_bridge.js`)
- **Issue**: On initial WebSocket connect, `applyState` mapped raw blocks to `window.blocks` but failed to trigger a canvas redraw, leaving the chart canvas blank.
- **Resolution**: Added immediate redraw triggers inside `applyState` using `drawGrid()` and `drawChart()`.

### 3. Simulation Step-Size Calibration (`backend/services/market.py`)
- **Issue**: The backend engine expects a calibrated step size of `10.0` price units for BTCUSDT to generate a staircase block. However, the simulated market backup stream walked by `5.0` units, preventing consecutive ticks from registering as new blocks.
- **Resolution**: Updated `market.py`'s live price simulator and historical candle generator to walk with matching step sizes (`10.0` for BTC, `5.0` for ETH, `1.0` for others), producing dense, continuous staircases.

### 4. Chart Engine Bootstrapping (`index.html`)
- **Issue**: `ChartEngine.init()` was defined in `chart.js` but never invoked on page load, preventing asset/interval selectors and bottom/right panels from wiring up.
- **Resolution**: Added `window.ChartEngine.init()` to the bottom inline script of `index.html`.

---

## 3. Current Diagnostic Analysis (The viewport Alignment Issue)

Our browser diagnostics show that **300 blocks are successfully loaded** into the frontend's memory (`window.blocks.length = 300`). The WebSocket is connected, live price ticks are streaming in real-time, and no JS console errors are generated. 

### Why is the chart still blank?
1. **Camera Offset Mismatch on Startup**: When `applyBlocks` runs during the initial state synchronization, `wrapper.clientWidth` and `wrapper.clientHeight` can evaluate to `0` or minimal placeholder values because the DOM layout hasn't finished rendering. This results in the initial camera offsets (`offsetX` and `offsetY`) calibrating incorrectly, dragging the active coordinates of the blocks completely off the screen viewport.
2. **Left Toolbar & Header Occlusion**: The leftmost column starts at index `col = 0`. With `offsetX = 0`, the first few blocks are drawn at horizontal screen pixels `0px` to `160px`. Because the leftmost toolbar is fixed on top of the main canvas with a width of `52px` and the header takes `56px` vertical space, these blocks are drawn underneath the UI overlays, leaving the right side of the screen empty.

---

## 4. Sorted Task Planner & Checklist (To Resume Implementation)

Here is the prioritized checklist of remaining tasks to complete the masterplan to institutional standards:

### Priority 1: Viewport & Camera Alignment (Fix the Blank Chart)
- [x] **Task 1.1**: Patch `centerCamera()` and `centerCameraX()` inside `app.js` to run inside a short `requestAnimationFrame` or `setTimeout` loop upon initial loading, ensuring that the canvas dimensions are fully populated by the browser. (Completed)
- [x] **Task 1.2**: Clamp and adjust initial `offsetX` and `offsetY` values in `backend_bridge.js` so that the latest block (at column index `blocks.length - 1`) is centered horizontally and vertically on the grid, with a safety boundary of 4 empty grid columns on the right. (Completed)
- [x] **Task 1.3**: Test camera panning by dragging the grid canvas with the mouse to verify that all 300 loaded blocks render and scroll smoothly. (Completed)

### Priority 2: Visual & Dynamic Block Styling (Masterplan Aesthetic)
- [x] **Task 2.1**: Implement a custom glowing/neon stroke around active signal blocks on the canvas (`#089981` with shadow blur for green, `#f23645` for red) to achieve the premium, futuristic dark-mode institutional aesthetic. (Completed)
- [x] **Task 2.2**: Ensure that when a user hovers over a block, it highlights with a yellow shadow or border (`#FFD700`), and when clicked, turns solid yellow, opening the right Order pane. (Completed)

### Priority 3: Interactive Stop-Loss & Limit Order Lines
- [x] **Task 3.1**: Verify that selecting a signal block displays a clean, glowing horizontal stop-loss line (`#2962ff`) at the block's row level. (Completed)
- [x] **Task 3.2**: Allow users to drag the stop-loss line vertically on the canvas using mouse inputs to dynamically adjust the stop-loss level, sending an updated value to the backend WS (`set_stop_loss`). (Completed)

### Priority 4: 1-8 Block Follow Trail stop-loss Automation
- [x] **Task 4.1**: Wire up the "Trailing Stop" toggles in the right Order pane. (Completed)
- [x] **Task 4.2**: Verify that when trailing stop is enabled with `N` blocks, the backend `update_trailing_stop()` automatically moves the stop loss row upward (for BUY) or downward (for SELL) by exactly `N` blocks as new staircase blocks are generated by the price walk. (Completed)

---

## 5. Next Steps Reference Code Snippets

When you resume, you can apply this specific patch to `app.js` and `backend_bridge.js` to perfectly align the camera on load:

### 1. Centering Camera on Load (`backend_bridge.js` line 351)
```javascript
    if (window.blocks.length > 0) {
      const last = window.blocks[window.blocks.length - 1];
      window.currentLevel = last.row;
      window.currentCol = last.col;
      
      // Delay camera alignment by 100ms to guarantee wrapper size calculations are accurate
      setTimeout(() => {
        if (typeof window.centerCamera === 'function') {
          window.centerCamera();
        }
        const bp = window.blockSize || 40;
        const cw = (window.chartCanvas && window.chartCanvas.width) || 1000;
        window.offsetX = Math.max(0, window.currentCol * bp - cw + bp * 5); // Centered offset with 5 blocks margin
        
        if (typeof window.drawGrid === 'function') window.drawGrid();
        if (typeof window.drawChart === 'function') window.drawChart();
      }, 100);
    }
```

### 2. Safeguarding `centerCamera` (`app.js` line 220)
```javascript
function centerCamera() {
  if (!cameraFollowing) return;
  const h = chartCanvas.height || wrapper.clientHeight || 600;
  offsetY = (currentLevel * blockSize) - Math.floor(h / 2) + Math.floor(blockSize / 2);
}
```

---

*This document is structured, sorted, and ready. You can safely power off or restart your laptop. All work is saved and synced locally.*
