import sqlite3
import json
import os
from typing import Dict, Optional
from state import Trade

DB_PATH = os.path.join(os.path.dirname(__file__), "trades.db")

def init_db():
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS active_trades (
                id TEXT PRIMARY KEY,
                symbol TEXT,
                side TEXT,
                amount REAL,
                entry_price REAL,
                stop_loss REAL,
                trailing_stop BOOLEAN,
                trail_offset REAL,
                trail_blocks INTEGER,
                highest_price REAL,
                lowest_price REAL,
                leverage REAL,
                highest_block_row INTEGER,
                lowest_block_row INTEGER,
                highest_block_price REAL,
                lowest_block_price REAL,
                stop_loss_row INTEGER,
                mode TEXT,
                exchange TEXT,
                market_type TEXT,
                timestamp REAL
            )
        """)

def save_trade(trade: Trade):
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("""
            INSERT OR REPLACE INTO active_trades (
                id, symbol, side, amount, entry_price, stop_loss, trailing_stop,
                trail_offset, trail_blocks, highest_price, lowest_price, leverage,
                highest_block_row, lowest_block_row, highest_block_price, lowest_block_price,
                stop_loss_row, mode, exchange, market_type, timestamp
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            trade.id, trade.symbol, trade.side, trade.amount, trade.entry_price,
            trade.stop_loss, trade.trailing_stop, trade.trail_offset, trade.trail_blocks,
            trade.highest_price, trade.lowest_price, trade.leverage,
            trade.highest_block_row, trade.lowest_block_row, trade.highest_block_price,
            trade.lowest_block_price, trade.stop_loss_row, trade.mode, trade.exchange,
            trade.market_type, trade.timestamp
        ))

def remove_trade(trade_id: str):
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("DELETE FROM active_trades WHERE id = ?", (trade_id,))

def load_open_trades() -> Dict[str, Trade]:
    trades = {}
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.execute("SELECT * FROM active_trades")
        for row in cursor:
            t = Trade(
                id=row["id"],
                symbol=row["symbol"],
                side=row["side"],
                amount=row["amount"],
                entry_price=row["entry_price"],
                stop_loss=row["stop_loss"],
                trailing_stop=bool(row["trailing_stop"]),
                trail_offset=row["trail_offset"],
                trail_blocks=row["trail_blocks"],
                highest_price=row["highest_price"],
                lowest_price=row["lowest_price"],
                leverage=row["leverage"],
                highest_block_row=row["highest_block_row"],
                lowest_block_row=row["lowest_block_row"],
                highest_block_price=row["highest_block_price"],
                lowest_block_price=row["lowest_block_price"],
                stop_loss_row=row["stop_loss_row"],
                mode=row["mode"],
                exchange=row["exchange"],
                market_type=row["market_type"],
                timestamp=row["timestamp"]
            )
            trades[t.id] = t
    return trades
