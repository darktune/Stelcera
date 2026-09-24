"""
Stelcera — Backend (Python 3.14 compatible)
No FastAPI/pydantic dependency — uses Starlette directly.
Run: python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
Open: http://localhost:8000
"""
import asyncio
import json
import os
import sys
from contextlib import asynccontextmanager
from typing import Set
import mimetypes
mimetypes.add_type('text/css', '.css')
mimetypes.add_type('application/javascript', '.js')

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse, FileResponse, Response
from starlette.routing import Route, WebSocketRoute, Mount
from starlette.staticfiles import StaticFiles
from starlette.websockets import WebSocket, WebSocketDisconnect
from starlette.requests import Request

from state import state
from trading import (
    open_trade, close_trade, set_stop_loss,
    on_price_update, set_broadcast_callback,
    broadcast_price_state,
)
from engine import load_historical_prices
from exchange_client import sync_account_balance, get_latest_price
from services import market
import db

# ------------------------------------------------------------------
# FRONTEND WEBSOCKET CLIENTS
# ------------------------------------------------------------------
_clients: Set[WebSocket] = set()


async def broadcast(msg: dict):
    data = json.dumps(msg)
    dead = set()
    for ws in _clients:
        try:
            await ws.send_text(data)
        except Exception:
            dead.add(ws)
    _clients.difference_update(dead)


set_broadcast_callback(broadcast)


# ------------------------------------------------------------------
# MARKET DATA CALLBACKS
# ------------------------------------------------------------------
async def on_market_price(symbol: str, price: float):
    await on_price_update(symbol, price)


async def on_market_status(status: str, pair: str = ''):
    await broadcast({'type': 'ws_status', 'status': status, 'pair': pair})


market.set_price_callback(on_market_price)
market.set_status_callback(on_market_status)


# ------------------------------------------------------------------
# STARTUP / SHUTDOWN
# ------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app):
    # ---- STARTUP ----
    db.init_db()
    loaded_trades = db.load_open_trades()
    state.active_trades.update(loaded_trades)
    print(f"Loaded {len(loaded_trades)} active trades from database")
    
    if not state.selected_symbol:
        state.select_pair('BTCUSDT', 'BTC/USDT', state.market_type)
    state.select_pair(state.selected_symbol, state.selected_pair, state.market_type)
    history = await market.fetch_history(state.selected_symbol, exchange='binance', market_type=state.market_type, limit=500)
    print("Selected symbol:", state.selected_symbol)
    print("Fetching history...")
    print(f"History candles loaded: {len(history)}")
    load_historical_prices(state.selected_symbol, history, market_type=state.market_type)
    print("Starting live stream...")
    await market.start(state.selected_symbol, exchange='binance', market_type=state.market_type)
    print('\n============================================')
    print('  STELCERA — RUNNING')
    print('============================================')
    print(f'  Frontend:  http://localhost:8000')
    print(f'  API docs:  http://localhost:8000/health')
    print(f'  WS:        ws://localhost:8000/ws')
    print(f'  Symbol:    {state.selected_pair}')
    print('============================================\n')
    yield
    # ---- SHUTDOWN ----
    await market.stop()


# ------------------------------------------------------------------
# FRONTEND WEBSOCKET
# ------------------------------------------------------------------
async def frontend_ws_endpoint(websocket: WebSocket):
    await websocket.accept()
    _clients.add(websocket)
    print(f'[WS] client connected ({len(_clients)} total)')

    # Send full state immediately
    await websocket.send_text(json.dumps({'type': 'state', **state.to_dict()}))

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
                await handle_ws_message(msg, websocket)
            except Exception as e:
                await websocket.send_text(json.dumps({'type': 'error', 'message': str(e)}))
    except Exception:
        pass
    finally:
        _clients.discard(websocket)
        print(f'[WS] client disconnected ({len(_clients)} remaining)')


async def handle_ws_message(msg: dict, ws: WebSocket):
    action = msg.get('action', '')

    if action in ('buy', 'sell'):
        result = await open_trade(
            symbol        = msg.get('symbol', state.selected_symbol),
            side          = action,
            amount        = float(msg.get('amount', 0)),
            stop_loss     = float(msg.get('stop_loss', 0)),
            trailing_stop = bool(msg.get('trailing_stop', False)),
            trail_offset  = float(msg.get('trail_offset', 0)),
            entry_price   = float(msg.get('entry_price', 0)),
        )
        await ws.send_text(json.dumps({'type': 'trade_result', **result}))

    elif action == 'close_trade':
        result = await close_trade(msg.get('trade_id', ''), 'MANUAL CLOSE')
        await ws.send_text(json.dumps({'type': 'close_result', **result}))

    elif action == 'set_stop_loss':
        result = await set_stop_loss(msg.get('trade_id', ''), float(msg.get('stop_price', 0)))
        await ws.send_text(json.dumps({'type': 'stop_loss_result', **result}))

    elif action == 'switch_symbol':
        pair   = msg.get('pair', '')
        if not pair: return
        symbol = pair.replace('/', '').upper()
        print(f"[MAIN] WS switch_symbol requested: {pair} -> {symbol}")

        # Clear old data completely
        state.reset_blocks()
        state.current_prices = {}
        state.last_prices = {}

        state.select_pair(symbol, pair, state.market_type)
        exchange = state.connected_exchange or 'bybit'
        print(f"[MAIN] Switching to {symbol} on {exchange}")
        history = await market.fetch_history(symbol, exchange=exchange, market_type=state.market_type, limit=500)
        print(f"[MAIN] Fetched {len(history)} historical candles for {symbol}")
        load_historical_prices(symbol, history, market_type=state.market_type)
        print(f"[MAIN] Loaded historical blocks for {symbol}")
        await market.switch(symbol, exchange=exchange, market_type=state.market_type)
        print(f"[MAIN] Started live stream for {symbol}")
        await ws.send_text(json.dumps({'type': 'symbol_switched', 'symbol': symbol, 'pair': pair, 'market_type': state.market_type}))
        await broadcast_price_state(symbol)
        print(f"[MAIN] Sent initial state for {symbol}")

    elif action == 'connect_exchange':
        exchange = msg.get('exchange', 'bybit')
        key      = msg.get('api_key', '').strip()
        secret   = msg.get('api_secret', '').strip()
        if not key or not secret:
            await ws.send_text(json.dumps({'type': 'exchange_error', 'message': 'API key and secret required'}))
            return
        state.set_credentials(key, secret)
        if not state.selected_symbol:
            state.select_pair('BTCUSDT', 'BTC/USDT', state.market_type)
        state.connected_exchange = exchange
        state.exchange_status    = 'connecting'
        state.is_exchange_connected = False
        try:
            bal = await sync_account_balance(exchange)
            history = await market.fetch_history(state.selected_symbol, exchange=exchange, market_type=state.market_type, limit=500)
            load_historical_prices(state.selected_symbol, history, market_type=state.market_type)
            await market.switch(state.selected_symbol, exchange=exchange, market_type=state.market_type)
            state.exchange_status = 'connected'
            state.is_exchange_connected = True
            state.mode = 'real'
            await broadcast({'type': 'exchange_connected', 'exchange': exchange, 'balance': round(bal, 2)})
            await broadcast({'type': 'mode_changed', 'mode': 'real', 'balance': round(bal, 2)})
            await broadcast_price_state(state.selected_symbol)
            print(f'[EXCHANGE] connected: {exchange} | balance: ${bal:.2f}')
        except Exception as e:
            state.exchange_status    = 'failed'
            state.connected_exchange = None
            state.is_exchange_connected = False
            state.clear_credentials()
            await ws.send_text(json.dumps({'type': 'exchange_error', 'message': str(e)}))

    elif action == 'disconnect_exchange':
        state.clear_credentials()
        state.connected_exchange = None
        state.exchange_status    = 'disconnected'
        state.is_exchange_connected = False
        state.live_balance       = 0.0
        await broadcast({'type': 'exchange_disconnected'})

    elif action == 'set_mode':
        mode = msg.get('mode', 'demo')
        if mode in ('demo', 'real'):
            state.mode = mode
            await broadcast({'type': 'mode_changed', 'mode': mode, 'balance': round(state.get_balance(), 2)})

    elif action == 'set_sim_paused':
        state.sim_paused = bool(msg.get('paused', False))
        await ws.send_text(json.dumps({'type': 'sim_paused_result', 'paused': state.sim_paused}))

    elif action == 'set_sim_speed':
        state.sim_speed = float(msg.get('speed', 600)) / 1000.0
        await ws.send_text(json.dumps({'type': 'sim_speed_result', 'speed': int(state.sim_speed * 1000)}))

    elif action == 'get_state':
        await ws.send_text(json.dumps({'type': 'state', **state.to_dict()}))

    elif action == 'get_history':
        await ws.send_text(json.dumps({'type': 'history', 'records': state.trade_history[:50]}))


# ------------------------------------------------------------------
# REST HANDLERS
# ------------------------------------------------------------------
async def serve_frontend(request: Request):
    path = os.path.join(os.path.dirname(__file__), '..', 'index.html')
    if os.path.exists(path):
        return FileResponse(path)
    return JSONResponse({'message': 'Backend running. Place index.html in parent directory.'})


async def serve_favicon(request: Request):
    path = os.path.join(os.path.dirname(__file__), '..', 'favicon.svg')
    if os.path.exists(path):
        return FileResponse(path, media_type='image/svg+xml')
    return Response(status_code=404)


async def health(request: Request):
    return JSONResponse({
        'status':   'ok',
        'mode':     state.mode,
        'exchange': state.connected_exchange,
        'is_exchange_connected': state.is_exchange_connected,
        'symbol':   state.selected_pair,
        'price':    state.get_price(state.selected_symbol),
    })


async def get_balance(request: Request):
    return JSONResponse({
        'mode':         state.mode,
        'demo_balance': round(state.demo_balance, 2),
        'live_balance': round(state.live_balance, 2),
        'balance':      round(state.get_balance(), 2),
    })


async def connect_exchange(request: Request):
    body     = await request.json()
    exchange = body.get('exchange', 'bybit')
    key      = body.get('api_key', '').strip()
    secret   = body.get('api_secret', '').strip()
    print(f'[/connect] exchange={exchange} key_len={len(key)} secret_len={len(secret)}')
    if not key or not secret:
        print('[/connect] ERROR: missing credentials')
        return JSONResponse({'success': False, 'error': 'API key and secret required'}, status_code=400)
    state.set_credentials(key, secret)
    if not state.selected_symbol:
        state.select_pair('BTCUSDT', 'BTC/USDT', state.market_type)
    state.connected_exchange = exchange
    state.exchange_status    = 'connecting'
    state.is_exchange_connected = False
    print(f'[/connect] credentials stored, fetching balance and positions...')
    try:
        bal = await sync_account_balance(exchange)
        print(f'[/connect] Balance fetched: ${bal:.2f}')

        # Clear old data and reload for current symbol
        state.reset_blocks()
        state.current_prices = {}
        state.last_prices = {}

        history = await market.fetch_history(state.selected_symbol, exchange=exchange, market_type=state.market_type, limit=500)
        print(f'[/connect] Fetched {len(history)} historical candles for {state.selected_symbol}')
        load_historical_prices(state.selected_symbol, history, market_type=state.market_type)
        print(f'[/connect] Loaded historical blocks for {state.selected_symbol}')
        await market.switch(state.selected_symbol, exchange=exchange, market_type=state.market_type)
        print(f'[/connect] Started live stream for {state.selected_symbol}')

        positions = []
        try:
            from exchange_client import sync_positions
            positions = await sync_positions(exchange)
        except Exception as pos_err:
            print(f'[/connect] positions sync skipped: {pos_err}')

        state.exchange_status = 'connected'
        state.is_exchange_connected = True
        state.mode = 'real'  # Force real mode on connect
        print(f'[/connect] SUCCESS — {exchange} balance: ${bal:.2f}, symbol: {state.selected_symbol}')
        await broadcast({'type': 'exchange_connected', 'exchange': exchange, 'balance': round(bal, 2)})
        await broadcast({'type': 'mode_changed', 'mode': 'real', 'balance': round(bal, 2)})
        await broadcast_price_state(state.selected_symbol)
        return JSONResponse({'success': True, 'exchange': exchange, 'balance': round(bal, 2), 'positions': positions})
    except Exception as e:
        state.exchange_status    = 'failed'
        state.connected_exchange = None
        state.is_exchange_connected = False
        state.clear_credentials()
        print(f'[/connect] FAILED: {e}')
        return JSONResponse({'success': False, 'error': str(e)}, status_code=400)


async def place_trade(request: Request):
    body   = await request.json()
    result = await open_trade(
        symbol        = body.get('symbol', state.selected_symbol),
        side          = body.get('side', 'buy'),
        amount        = float(body.get('amount', 0)),
        stop_loss     = float(body.get('stop_loss', 0)),
        trailing_stop = bool(body.get('trailing_stop', False)),
        trail_offset  = float(body.get('trail_offset', 0)),
        entry_price   = float(body.get('entry_price', 0)),
    )
    status = 200 if result['success'] else 400
    return JSONResponse(result, status_code=status)


async def close_trade_endpoint(request: Request):
    trade_id = request.path_params.get('trade_id', '')
    result   = await close_trade(trade_id, 'REST CLOSE')
    status   = 200 if result['success'] else 404
    return JSONResponse(result, status_code=status)


async def get_trades(request: Request):
    return JSONResponse({
        'trades': [state._trade_to_dict(t) for t in state.active_trades.values() if t.is_open]
    })

async def get_positions_endpoint(request: Request):
    return JSONResponse({
        'positions': [state._trade_to_dict(t) for t in state.active_trades.values() if t.is_open and t.mode == 'real']
    })

async def get_history(request: Request):
    return JSONResponse({'records': state.trade_history[:50]})


async def get_price(request: Request):
    sym   = request.path_params.get('symbol', '').upper()
    if not sym:
        return JSONResponse({'symbol': '', 'price': 0})
    price = state.get_price(sym)
    if price == 0:
        try:
            exchange = state.connected_exchange or 'bybit'
            price = await get_latest_price(exchange, sym, market_type=state.market_type)
        except Exception:
            pass
    return JSONResponse({'symbol': sym, 'price': price})


# ------------------------------------------------------------------
# STATIC FILES (JS, CSS, etc.)
# ------------------------------------------------------------------
FRONTEND_DIR = os.path.join(os.path.dirname(__file__), '..')

# ------------------------------------------------------------------
async def set_stop_endpoint(request: Request):
    body = await request.json()
    level = body.get('level')
    if level is None:
        return JSONResponse({'success': False, 'error': 'Level required'}, status_code=400)
    
    symbol = state.selected_symbol
    blocks = state.get_blocks(symbol)
    if not blocks:
        return JSONResponse({'success': False, 'error': 'No blocks available'}, status_code=400)
    
    active = next(
        (t for t in state.active_trades.values() if t.is_open and t.symbol == state.selected_symbol),
        None,
    )
    if not active:
        return JSONResponse({'success': False, 'error': 'No active trade'}, status_code=400)
    
    # Find the block matching the Y level to get its price
    # We will just search the most recent blocks first
    target_price = None
    for b in reversed(blocks):
        if b['row'] == level:
            target_price = b.get('price')
            break
            
    if target_price is None:
        # Fallback: estimate from block 0
        b0 = blocks[0]
        y_diff = level - b0['row']
        target_price = b0.get('price', state.get_price(symbol)) - (y_diff * state.get_step_size(symbol))
        
    await set_stop_loss(active.id, target_price)
    return JSONResponse({'success': True, 'stop_loss': target_price})

async def get_exchange_info_endpoint(request: Request):
    if not state.connected_exchange or not state.is_exchange_connected:
        return JSONResponse({'success': False, 'error': 'No validated exchange connection'}, status_code=400)
    from exchange_client import get_exchange_info
    try:
        info = await get_exchange_info(state.connected_exchange)
        return JSONResponse({
            'exchange': info['exchange'],
            'types': info['types'],
            'pairs': info['pairs'],
            'pairs_by_type': info.get('pairs_by_type', {}),
        })
    except Exception as exc:
        return JSONResponse({'success': False, 'error': str(exc)}, status_code=502)


async def set_market_endpoint(request: Request):
    body = await request.json()
    symbol = body.get('symbol', '').strip().upper()
    m_type = body.get('type', 'spot').strip().lower()
    if not symbol:
        return JSONResponse({'success': False, 'error': 'Symbol required'}, status_code=400)
    if not state.connected_exchange or not state.is_exchange_connected:
        return JSONResponse({'success': False, 'error': 'Exchange connection required'}, status_code=400)
    
    display_pair = body.get('pair', state.format_pair(symbol))
    state.select_pair(symbol, display_pair, m_type)
    print("Selected symbol:", state.selected_symbol)

    # Switch stream
    import services.market as market
    exchange = state.connected_exchange or 'bybit'
    print("Fetching history...")
    history = await market.fetch_history(symbol, exchange=exchange, market_type=m_type, limit=500)
    print(f"History candles loaded: {len(history)}")
    load_historical_prices(symbol, history, market_type=m_type)
    print("Starting live stream...")
    await market.switch(symbol, exchange=exchange, market_type=m_type)
    
    await broadcast({
        'type': 'symbol_switched', 
        'symbol': symbol,
        'pair': state.selected_pair,
        'market_type': m_type
    })
    await broadcast_price_state(symbol)
    
    return JSONResponse({
        'success': True,
        'symbol': symbol,
        'type': m_type,
        'price': state.get_price(symbol),
        'blocks': state.get_blocks(symbol)[-300:],
    })

# ------------------------------------------------------------------
# APP
# ------------------------------------------------------------------
routes = [
    Route('/',                    serve_frontend),
    Route('/favicon.svg',         serve_favicon),
    Route('/favicon.ico',         serve_favicon),
    Route('/health',              health),
    Route('/balance',             get_balance),
    Route('/connect',             connect_exchange, methods=['POST']),
    Route('/trade',               place_trade,      methods=['POST']),
    Route('/close/{trade_id}',    close_trade_endpoint, methods=['POST']),
    Route('/trades',              get_trades),
    Route('/positions',           get_positions_endpoint),
    Route('/history',             get_history),
    Route('/price/{symbol}',      get_price),
    Route('/set-stop',            set_stop_endpoint, methods=['POST']),
    Route('/exchange-info',       get_exchange_info_endpoint),
    Route('/set-market',          set_market_endpoint, methods=['POST']),
    WebSocketRoute('/ws',         frontend_ws_endpoint),
]

# Serve frontend static files (JS, CSS, images)
if os.path.isdir(FRONTEND_DIR):
    routes.append(Mount('/', StaticFiles(directory=FRONTEND_DIR, html=True), name='static'))

middleware = [
    Middleware(CORSMiddleware, allow_origins=['*'], allow_methods=['*'], allow_headers=['*'])
]

app = Starlette(
    routes=routes,
    middleware=middleware,
    lifespan=lifespan,
)
