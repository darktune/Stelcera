"""
Trading engine.
Backend owns block generation, history conversion, stop-loss monitoring,
and trailing-stop updates for every symbol.
"""
import time
import uuid
from typing import Callable, Optional

from state import state, Trade
from exchange_client import execute_real_trade, sync_account_balance
from db import save_trade, remove_trade


_broadcast_cb: Optional[Callable] = None


def set_broadcast_callback(cb: Callable):
    global _broadcast_cb
    _broadcast_cb = cb


async def _broadcast(msg: dict):
    if _broadcast_cb:
        await _broadcast_cb(msg)


import engine


def _row_for_stop(symbol: str, stop_price: float) -> Optional[int]:
    """Calculate stop loss row based on price distance from current entry."""
    entry_block = _latest_block_for_symbol(symbol)
    if not entry_block or stop_price <= 0:
        return None
    
    entry_price = entry_block.get("price", 0)
    entry_row = entry_block.get("row", 0)
    step_size = state.get_pair_state(symbol).step_size
    
    if entry_price <= 0 or step_size <= 0:
        return None
    
    # Calculate how many steps away the stop price is
    price_diff = abs(entry_price - stop_price)
    block_steps = int(price_diff / step_size)
    
    # For buy orders, stop loss is below entry (higher row numbers)
    # For sell orders, stop loss is above entry (lower row numbers)
    # This will be adjusted in open_trade based on side
    return entry_row + block_steps


def _serialize_primary_trade(symbol: str) -> Optional[dict]:
    for trade in state.active_trades.values():
        if trade.is_open and trade.symbol == symbol:
            payload = state._trade_to_dict(trade)
            payload["stop_row"] = trade.stop_loss_row
            return payload
    return None


def _latest_block_for_symbol(symbol: str) -> Optional[dict]:
    blocks = state.get_blocks(symbol)
    return blocks[-1] if blocks else None


async def _broadcast_price_state(symbol: str):
    pair_state = state.get_pair_state(symbol)
    trade = _serialize_primary_trade(symbol)
    output_format = engine.get_block_output_format(symbol)
    await _broadcast({
        "type": "price_update",
        "symbol": symbol,
        "pair": pair_state.display_pair,
        "market_type": pair_state.market_type,
        "price": round(state.get_price(symbol), 8),
        "blocks": output_format["blocks"],
        "direction": output_format["direction"],
        "trade": trade,
        "trades": [
            state._trade_to_dict(trade)
            for trade in state.active_trades.values()
            if trade.is_open and trade.symbol == symbol
        ],
        "stop_loss": trade["stop_loss"] if trade else 0,
        "trail_active": bool(trade["trail_active"]) if trade else False,
        "balance": round(state.get_balance(), 2),
        "step_size": pair_state.step_size,
    })


async def broadcast_price_state(symbol: str):
    await _broadcast_price_state(symbol)


# history loading logic moved to engine.py


async def open_trade(
    symbol: str,
    side: str,
    amount: float,
    stop_loss: float = 0.0,
    trailing_stop: bool = False,
    trail_offset: float = 0.0,
    entry_price: float = 0.0,
    leverage: float = 1.0,
) -> dict:
    normalized_symbol = symbol.upper()
    state.ensure_pair_state(normalized_symbol, market_type=state.market_type)
    balance = state.get_balance()
    if amount > balance:
        return {"success": False, "error": f"Insufficient balance: ${balance:.2f}"}

    current_price = state.get_price(normalized_symbol)
    if current_price <= 0:
        return {"success": False, "error": "No price data for symbol"}

    trade_entry_price = float(entry_price) if entry_price and entry_price > 0 else current_price
    trade_stop = float(stop_loss) if stop_loss > 0 else 0.0

    if state.mode == "real":
        exchange = state.connected_exchange
        if not exchange:
            return {"success": False, "error": "No exchange connected"}
        result = await execute_real_trade(exchange, normalized_symbol, side, amount, market_type=state.market_type, stop_loss=trade_stop)
        if not result["success"]:
            return result
        await sync_account_balance(exchange)
    else:
        state.deduct_balance(amount)

    trail_blocks = max(0, int(trail_offset or 0))

    trade = Trade(
        id=str(uuid.uuid4()),
        symbol=normalized_symbol,
        side=side,
        amount=amount,
        entry_price=trade_entry_price,
        current_price=current_price,
        stop_loss=trade_stop,
        trailing_stop=trailing_stop,
        trail_offset=float(trail_blocks),
        trail_blocks=trail_blocks,
        mode=state.mode,
        exchange=state.connected_exchange if state.mode == "real" else None,
        market_type=state.market_type,
        timestamp=time.time(),
        leverage=float(leverage),
    )
    entry_block = _latest_block_for_symbol(normalized_symbol)
    entry_row = entry_block.get("row") if entry_block else None
    trade.initialize_extremes(entry_row)
    # Initialize stop_loss_row based on strategy
    if entry_row is not None:
        if trailing_stop:
            # Trailing stop: set row distance from entry
            if side == "buy":
                trade.stop_loss_row = entry_row + trail_blocks
            else:
                trade.stop_loss_row = entry_row - trail_blocks
            step_size = state.get_pair_state(normalized_symbol).step_size
            trade.stop_loss = trade_entry_price - (trail_blocks * step_size) if side == "buy" else trade_entry_price + (trail_blocks * step_size)
        elif stop_loss > 0:
            # Fixed stop loss: calculate row based on price difference
            step_size = state.get_pair_state(normalized_symbol).step_size
            price_diff = abs(trade_entry_price - trade_stop)
            block_steps = int(price_diff / step_size) if step_size > 0 else 0
            
            if side == "buy":
                # Stop loss below entry price = higher row numbers
                trade.stop_loss_row = entry_row + block_steps
            else:
                # Stop loss above entry price = lower row numbers  
                trade.stop_loss_row = entry_row - block_steps
    
    state.active_trades[trade.id] = trade
    save_trade(trade)

    print(f"[TRADE OPEN] {side.upper()} {amount} {normalized_symbol} @ {trade_entry_price} [{state.mode}] (Lev: {leverage}x)")
    await _broadcast({
        "type": "trade_opened",
        "trade": state._trade_to_dict(trade),
        "balance": round(state.get_balance(), 2),
    })
    await _broadcast_price_state(normalized_symbol)
    return {"success": True, "trade_id": trade.id, "entry_price": trade_entry_price}


async def close_trade(trade_id: str, reason: str = "MANUAL") -> dict:
    trade = state.active_trades.get(trade_id)
    if not trade or not trade.is_open:
        return {"success": False, "error": "Trade not found or already closed"}

    current_price = state.get_price(trade.symbol)
    trade.update_pnl(current_price)
    final_return = trade.amount + trade.pnl

    if trade.mode == "real":
        exchange = trade.exchange or state.connected_exchange
        if exchange:
            close_side = "sell" if trade.side == "buy" else "buy"
            await execute_real_trade(exchange, trade.symbol, close_side, trade.amount, market_type=trade.market_type)
            await sync_account_balance(exchange)
    else:
        # Deduct a mock fee for demo mode to make it realistic (e.g. 0.05% taker fee)
        mock_fee = trade.amount * 0.0005
        final_return = final_return - mock_fee
        trade.pnl -= mock_fee
        trade.pnl_pct = (trade.pnl / trade.amount) * 100
        state.add_balance(final_return)

    trade.is_open = False
    remove_trade(trade.id)
    record = {
        "id": trade.id,
        "symbol": trade.symbol,
        "side": trade.side,
        "amount": round(trade.amount, 2),
        "entry_price": round(trade.entry_price, 8),
        "close_price": round(current_price, 8),
        "pnl": round(trade.pnl, 4),
        "pnl_pct": round(trade.pnl_pct, 4),
        "reason": reason,
        "mode": trade.mode,
        "timestamp": time.time(),
    }
    state.trade_history.insert(0, record)

    print(f"[TRADE CLOSE] {trade.side.upper()} {trade.symbol} | {reason} | PnL: {trade.pnl:.4f}")
    await _broadcast({
        "type": "trade_closed",
        "record": record,
        "balance": round(state.get_balance(), 2),
    })
    await _broadcast_price_state(trade.symbol)
    return {"success": True, "record": record}


async def on_price_update(symbol: str, price: float):
    normalized_symbol = symbol.upper()
    state.update_price(normalized_symbol, price)
    pair_state = state.get_pair_state(normalized_symbol)
    new_block = engine.append_block(normalized_symbol, price, timestamp=time.time())

    triggered = []
    current_block_row = new_block.get("row") if new_block else None

    
    for trade in list(state.active_trades.values()):
        if not trade.is_open or trade.is_closing or trade.symbol != normalized_symbol:
            continue
        trade.update_pnl(price)
        trade.update_trailing_stop(new_block, pair_state.step_size)

        
        # Check stop loss based on block position (primary), fallback to price if row unavailable
        if current_block_row is not None:
            if trade.is_stop_triggered_by_block(current_block_row):
                print(f"[STOP TRIGGER] Block-based trigger for trade {trade.id}")
                trade.is_closing = True
                triggered.append(trade.id)
        elif trade.is_stop_triggered(price):
            print(f"[STOP TRIGGER] Price-based trigger for trade {trade.id}")
            trade.is_closing = True
            triggered.append(trade.id)
            
        if not trade.is_closing:
            save_trade(trade)

    for trade_id in triggered:
        print(f"[TRADE CLOSE] Triggering stop loss for trade {trade_id}")
        await close_trade(trade_id, "STOP LOSS HIT")

    await _broadcast_price_state(normalized_symbol)


async def set_stop_loss(trade_id: str, stop_price: float) -> dict:
    trade = state.active_trades.get(trade_id)
    if not trade or not trade.is_open:
        return {"success": False, "error": "Trade not found"}

    trade.stop_loss = stop_price
    # Recalculate stop_loss_row based on price difference from entry
    step_size = state.get_pair_state(trade.symbol).step_size
    price_diff = abs(trade.entry_price - stop_price)
    block_steps = int(price_diff / step_size) if step_size > 0 else 0
    
    if trade.side == "buy":
        # Stop loss below entry price = higher row numbers
        trade.stop_loss_row = trade.highest_block_row + block_steps if trade.highest_block_row is not None else None
    else:
        # Stop loss above entry price = lower row numbers
        trade.stop_loss_row = trade.lowest_block_row - block_steps if trade.lowest_block_row is not None else None
    
    await _broadcast({
        "type": "stop_loss_updated",
        "trade_id": trade_id,
        "stop_loss": stop_price,
        "stop_row": trade.stop_loss_row,
    })
    
    current_price = state.get_price(trade.symbol)
    blocks = state.get_blocks(trade.symbol)
    current_block_row = blocks[-1].get("row") if blocks else None
    
    # Check closure based on block position first
    if current_block_row is not None and trade.is_stop_triggered_by_block(current_block_row):
        await close_trade(trade.id, "STOP LOSS HIT")
        return {"success": True, "closed": True}
    elif current_price > 0 and trade.is_stop_triggered(current_price):
        await close_trade(trade.id, "STOP LOSS HIT")
        return {"success": True, "closed": True}
    
    await _broadcast_price_state(trade.symbol)
    return {"success": True}
