"""
Unified exchange interface.
All exchange implementations must normalize account, market, price-stream,
and order data so the rest of the backend stays exchange-agnostic.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import AsyncIterator, Optional


class BaseExchange(ABC):
    name: str = ""

    def __init__(self, api_key: str = "", api_secret: str = ""):
        self.api_key = api_key or ""
        self.api_secret = api_secret or ""

    async def connect(self, api_key: str, api_secret: str) -> dict:
        self.api_key = api_key or ""
        self.api_secret = api_secret or ""
        return await self.get_balance()

    @abstractmethod
    async def get_balance(self) -> dict:
        pass

    @abstractmethod
    async def get_markets(self) -> dict:
        pass

    @abstractmethod
    async def get_price_stream(self, symbol: str, market_type: str = "spot") -> AsyncIterator[dict]:
        pass

    @abstractmethod
    async def place_order(self, side: str, amount: float, symbol: str, market_type: str = "spot", stop_loss: float = 0.0) -> dict:
        pass

    @abstractmethod
    async def close_position(self, symbol: str, market_type: str = "spot") -> dict:
        pass

    @abstractmethod
    async def get_history(self, symbol: str, market_type: str = "spot", limit: int = 500) -> list[tuple[float, float]]:
        pass

    @abstractmethod
    async def get_ticker(self, symbol: str, market_type: str = "spot") -> float:
        pass

    async def get_positions(self, symbol: str = "", market_type: str = "spot") -> list:
        return []

    def normalize_market_type(self, market_type: Optional[str]) -> str:
        raw = (market_type or "spot").strip().lower()
        return "futures" if raw in ("futures", "linear") else "spot"

