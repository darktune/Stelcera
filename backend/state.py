"""
State manager - single source of truth for runtime state.
Per-pair chart state persists across reconnects and symbol switches.
"""
from dataclasses import dataclass, field
from typing import Dict, List, Optional
import time


@dataclass
class Trade:
    id: str
    symbol: str
    side: str
    amount: float
    entry_price: float
    current_price: float = 0.0
    stop_loss: float = 0.0
    trailing_stop: bool = False
    trail_offset: float = 0.0
    trail_blocks: int = 0
    highest_price: float = 0.0
    lowest_price: float = 0.0
    leverage: float = 1.0
    is_closing: bool = False
    highest_block_row: Optional[int] = None
    lowest_block_row: Optional[int] = None
    highest_block_price: float = 0.0
    lowest_block_price: float = 0.0
    stop_loss_row: Optional[int] = None
    pnl: float = 0.0
    pnl_pct: float = 0.0
    is_open: bool = True
    mode: str = "demo"
    exchange: Optional[str] = None
    market_type: str = "spot"
    timestamp: float = field(default_factory=time.time)

    def update_pnl(self, price: float):
        self.current_price = price
        if self.side == "buy":
            raw_pnl = (price - self.entry_price) * (self.amount / self.entry_price)
        else:
            raw_pnl = (self.entry_price - price) * (self.amount / self.entry_price)
            
        if self.market_type == "futures":
            self.pnl = raw_pnl * self.leverage
        else:
            self.pnl = raw_pnl
            
        if self.amount > 0:
            self.pnl_pct = (self.pnl / self.amount) * 100

    def initialize_extremes(self, block_row: Optional[int] = None):
        self.highest_price = self.entry_price
        self.lowest_price = self.entry_price
        self.highest_block_row = block_row
        self.lowest_block_row = block_row
        self.highest_block_price = self.entry_price
        self.lowest_block_price = self.entry_price
        if self.stop_loss_row is None and block_row is not None:
            self.stop_loss_row = block_row

    def update_trailing_stop(self, block: Optional[dict], step_size: float):
        """Update trailing stop based on block position, not price."""
        if not self.trailing_stop or self.trail_blocks <= 0 or not block:
            return

        row = block.get("row")
        price = float(block.get("price", 0) or 0)
        if row is None or price <= 0:
            return

        if self.side == "buy":
            # For BUY: track highest block (lowest row number = highest price)
            if self.highest_block_row is None or row < self.highest_block_row:
                self.highest_block_row = row
                self.highest_block_price = price
                self.highest_price = max(self.highest_price, price)
                # Update stop_loss_row based on highest block + trail_distance
                self.stop_loss_row = row + self.trail_blocks
                self.stop_loss = self.highest_block_price - (self.trail_blocks * step_size)
        else:
            # For SELL: track lowest block (highest row number = lowest price)
            if self.lowest_block_row is None or row > self.lowest_block_row:
                self.lowest_block_row = row
                self.lowest_block_price = price
                self.lowest_price = price if self.lowest_price == 0 else min(self.lowest_price, price)
                # Update stop_loss_row based on lowest block - trail_distance
                self.stop_loss_row = row - self.trail_blocks
                self.stop_loss = self.lowest_block_price + (self.trail_blocks * step_size)

    def is_stop_triggered(self, price: float) -> bool:
        """Legacy price-based check (deprecated in favor of block-based)."""
        if self.stop_loss <= 0:
            return False
        if self.side == "buy":
            return price <= self.stop_loss
        return price >= self.stop_loss

    def is_stop_triggered_by_block(self, current_block_row: Optional[int]) -> bool:
        """Check if stop loss is triggered based on block row position."""
        if current_block_row is None or self.stop_loss_row is None:
            return False
        if self.side == "buy":
            # For BUY: stop triggers when current row >= stop_loss_row (block goes down)
            return current_block_row >= self.stop_loss_row
        else:
            # For SELL: stop triggers when current row <= stop_loss_row (block goes up)
            return current_block_row <= self.stop_loss_row


@dataclass
class PairState:
    symbol: str
    display_pair: str
    market_type: str = "spot"
    blocks: List[dict] = field(default_factory=list)
    last_block_price: Optional[float] = None
    step_size: float = 10.0
    last_history_load: float = 0.0
    last_tick_ts: float = 0.0


class AppState:
    def __init__(self):
        self.current_prices: Dict[str, float] = {}
        self.last_prices: Dict[str, float] = {}
        self.pair_states: Dict[str, PairState] = {}

        self.active_trades: Dict[str, Trade] = {}
        self.trade_history: List[dict] = []

        self.demo_balance: float = 10000.0
        self.live_balance: float = 0.0

        self.connected_exchange: Optional[str] = None
        self.exchange_status: str = "disconnected"
        self.is_exchange_connected: bool = False

        self._api_key: Optional[str] = None
        self._api_secret: Optional[str] = None

        self.selected_symbol: str = "BTCUSDT"
        self.selected_pair: str = "BTC/USDT"
        self.market_type: str = "spot"
        self.mode: str = "demo"
        self.sim_paused: bool = False
        self.sim_speed: float = 0.6

        self.ensure_pair_state(self.selected_symbol, self.selected_pair, self.market_type)

    def format_pair(self, symbol: str) -> str:
        raw = (symbol or "").upper()
        known_quotes = ("USDT", "USDC", "FDUSD", "TUSD", "BUSD", "BTC", "ETH", "BNB", "EUR", "TRY")
        for quote in known_quotes:
            if raw.endswith(quote) and len(raw) > len(quote):
                return f"{raw[:-len(quote)]}/{quote}"
        return raw

    def ensure_pair_state(self, symbol: str, display_pair: Optional[str] = None, market_type: Optional[str] = None) -> PairState:
        normalized = (symbol or self.selected_symbol).upper()
        pair_state = self.pair_states.get(normalized)
        if not pair_state:
            pair_state = PairState(
                symbol=normalized,
                display_pair=display_pair or self.format_pair(normalized),
                market_type=market_type or self.market_type,
            )
            self.pair_states[normalized] = pair_state
        else:
            if display_pair:
                pair_state.display_pair = display_pair
            if market_type:
                pair_state.market_type = market_type
        return pair_state

    def get_pair_state(self, symbol: Optional[str] = None) -> PairState:
        target = (symbol or self.selected_symbol).upper()
        return self.ensure_pair_state(target)

    def select_pair(self, symbol: str, display_pair: Optional[str] = None, market_type: Optional[str] = None) -> PairState:
        pair_state = self.ensure_pair_state(symbol, display_pair, market_type)
        self.selected_symbol = pair_state.symbol
        self.selected_pair = pair_state.display_pair
        self.market_type = market_type or pair_state.market_type
        return pair_state

    def set_credentials(self, key: str, secret: str):
        self._api_key = key
        self._api_secret = secret

    def get_credentials(self):
        return self._api_key, self._api_secret

    def clear_credentials(self):
        self._api_key = None
        self._api_secret = None

    def get_balance(self) -> float:
        return self.demo_balance if self.mode == "demo" else self.live_balance

    def deduct_balance(self, amount: float) -> bool:
        bal = self.get_balance()
        if amount > bal:
            return False
        if self.mode == "demo":
            self.demo_balance -= amount
        else:
            self.live_balance -= amount
        return True

    def add_balance(self, amount: float):
        if self.mode == "demo":
            self.demo_balance = max(0, self.demo_balance + amount)
        else:
            self.live_balance = max(0, self.live_balance + amount)

    def update_price(self, symbol: str, price: float):
        normalized = symbol.upper()
        self.last_prices[normalized] = self.current_prices.get(normalized, price)
        self.current_prices[normalized] = price
        self.ensure_pair_state(normalized).last_tick_ts = time.time()

    def get_price(self, symbol: str) -> float:
        return self.current_prices.get(symbol.upper(), 0.0)

    def reset_blocks(self, symbol: Optional[str] = None):
        pair_state = self.get_pair_state(symbol)
        pair_state.blocks = []
        pair_state.last_block_price = None

    def get_blocks(self, symbol: Optional[str] = None) -> List[dict]:
        return self.get_pair_state(symbol).blocks

    def get_step_size(self, symbol: Optional[str] = None) -> float:
        return self.get_pair_state(symbol).step_size

    def set_step_size(self, symbol: str, value: float):
        self.ensure_pair_state(symbol).step_size = value

    @property
    def blocks(self) -> List[dict]:
        return self.get_blocks()

    @property
    def last_block_price(self) -> Optional[float]:
        return self.get_pair_state().last_block_price

    @last_block_price.setter
    def last_block_price(self, value: Optional[float]):
        self.get_pair_state().last_block_price = value

    @property
    def step_size(self) -> float:
        return self.get_pair_state().step_size

    @step_size.setter
    def step_size(self, value: float):
        self.get_pair_state().step_size = value

    def to_dict(self) -> dict:
        selected_state = self.get_pair_state()
        return {
            "mode": self.mode,
            "demo_balance": round(self.demo_balance, 2),
            "live_balance": round(self.live_balance, 2),
            "exchange": self.connected_exchange,
            "exchange_status": self.exchange_status,
            "is_exchange_connected": self.is_exchange_connected,
            "selected_pair": self.selected_pair,
            "selected_symbol": self.selected_symbol,
            "market_type": self.market_type,
            "step_size": selected_state.step_size,
            "prices": {k: round(v, 8) for k, v in self.current_prices.items()},
            "blocks": selected_state.blocks[-300:],
            "pair_states": {
                symbol: {
                    "pair": pair_state.display_pair,
                    "market_type": pair_state.market_type,
                    "step_size": pair_state.step_size,
                    "blocks": pair_state.blocks[-300:],
                    "price": round(self.current_prices.get(symbol, 0.0), 8),
                }
                for symbol, pair_state in self.pair_states.items()
            },
            "active_trades": [self._trade_to_dict(t) for t in self.active_trades.values() if t.is_open],
        }

    def _trade_to_dict(self, trade: Trade) -> dict:
        return {
            "id": trade.id,
            "symbol": trade.symbol,
            "side": trade.side,
            "amount": round(trade.amount, 2),
            "entry_price": round(trade.entry_price, 8),
            "current_price": round(trade.current_price, 8),
            "stop_loss": round(trade.stop_loss, 8),
            "trail_active": trade.trailing_stop,
            "trail_blocks": trade.trail_blocks,
            "pnl": round(trade.pnl, 4),
            "pnl_pct": round(trade.pnl_pct, 4),
            "leverage": trade.leverage,
            "is_open": trade.is_open,
            "mode": trade.mode,
            "exchange": trade.exchange,
            "market_type": trade.market_type,
            "timestamp": trade.timestamp,
        }


state = AppState()
