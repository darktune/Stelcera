"""
Block Engine Module
Handles block generation, step-size calibration, and historical block rebuilding.
"""
import time
from typing import Optional, List, Tuple
from state import state

def calibrate_step_size(price: float) -> float:
    if price > 10000:
        return 10.0
    if price > 1000:
        return 5.0
    if price > 100:
        return 1.0
    if price > 10:
        return 0.5
    if price > 1:
        return 0.1
    return 0.01

def append_block(symbol: str, price: float, timestamp: Optional[float] = None) -> Optional[dict]:
    pair_state = state.get_pair_state(symbol)
    
    if pair_state.last_block_price is None:
        pair_state.step_size = calibrate_step_size(price)
        pair_state.last_block_price = price
        block = {
            "col": 0,
            "row": 0,
            "type": "green",
            "price": round(price, 8),
            "timestamp": timestamp or time.time(),
        }
        pair_state.blocks.append(block)
        return block

    diff = price - pair_state.last_block_price
    if abs(diff) < pair_state.step_size:
        return None

    prev = pair_state.blocks[-1] if pair_state.blocks else None
    prev_col = prev["col"] if prev else -1
    prev_row = prev["row"] if prev else 0
    
    direction = "green" if diff > 0 else "red"
    # Diagonally move blocks: col + 1, row - 1 (up) or row + 1 (down)
    new_row = prev_row - 1 if direction == "green" else prev_row + 1

    block = {
        "col": prev_col + 1,
        "row": new_row,
        "type": direction,
        "price": round(price, 8),
        "timestamp": timestamp or time.time(),
    }
    pair_state.blocks.append(block)
    pair_state.last_block_price = price
    return block

def get_block_output_format(symbol: str) -> dict:
    pair_state = state.get_pair_state(symbol)
    blocks = pair_state.blocks[-300:]
    last_price = pair_state.last_block_price or 0.0
    direction = "up"
    if blocks:
        direction = "up" if blocks[-1]["type"] == "green" else "down"
    
    return {
        "blocks": blocks,
        "last_price": last_price,
        "direction": direction
    }

def load_historical_prices(symbol: str, prices: List[Tuple[float, float]], market_type: Optional[str] = None):
    pair_state = state.ensure_pair_state(symbol, market_type=market_type)
    pair_state.blocks = []
    pair_state.last_block_price = None
    pair_state.last_history_load = time.time()

    if not prices:
        return

    first_ts, first_price = prices[0]
    append_block(symbol, float(first_price), timestamp=float(first_ts))
    state.update_price(symbol, float(first_price))

    for ts, close_price in prices[1:]:
        append_block(symbol, float(close_price), timestamp=float(ts))
        state.update_price(symbol, float(close_price))
