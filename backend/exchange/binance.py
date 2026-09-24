"""
Binance exchange implementation using the unified abstraction layer.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import AsyncIterator

import httpx
import websockets

from exchange.base import BaseExchange


class BinanceExchange(BaseExchange):
    name = "binance"
    BASE = "https://api.binance.com"
    FUTURES_BASE = "https://fapi.binance.com"

    def _sign(self, params: str) -> str:
        return hmac.new(self.api_secret.encode(), params.encode(), hashlib.sha256).hexdigest()

    def _headers(self) -> dict:
        return {"X-MBX-APIKEY": self.api_key}

    async def get_balance(self) -> dict:
        ts = int(time.time() * 1000)
        params = f"timestamp={ts}"
        url = f"{self.BASE}/api/v3/account?{params}&signature={self._sign(params)}"
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(url, headers=self._headers())
            response.raise_for_status()
            data = response.json()
        balance = 0.0
        for asset in data.get("balances", []):
            if asset.get("asset") == "USDT":
                balance = float(asset.get("free", 0))
                break
        return {"balance": balance}

    async def get_markets(self) -> dict:
        async with httpx.AsyncClient(timeout=10) as client:
            spot_resp = await client.get(f"{self.BASE}/api/v3/exchangeInfo")
            spot_resp.raise_for_status()
            spot_rows = spot_resp.json().get("symbols", [])

            futures_resp = await client.get(f"{self.FUTURES_BASE}/fapi/v1/exchangeInfo")
            futures_resp.raise_for_status()
            futures_rows = futures_resp.json().get("symbols", [])

        spot = [
            {"symbol": row["symbol"], "type": "spot"}
            for row in spot_rows
            if row.get("status") == "TRADING"
        ]
        futures = [
            {"symbol": row["symbol"], "type": "futures"}
            for row in futures_rows
            if row.get("status") == "TRADING"
        ]
        return {"exchange": self.name, "markets": [*spot, *futures]}

    async def get_price_stream(self, symbol: str, market_type: str = "spot") -> AsyncIterator[dict]:
        normalized = self.normalize_market_type(market_type)
        sym = symbol.lower()
        if normalized == "futures":
            url = f"wss://fstream.binance.com/ws/{sym}@trade"
        else:
            url = f"wss://stream.binance.com:9443/ws/{sym}@trade"
        async with websockets.connect(url, ping_interval=20, ping_timeout=10) as ws:
            async for raw in ws:
                message = json.loads(raw)
                price = float(message.get("p", 0))
                ts = int(message.get("T", int(time.time() * 1000)))
                if price > 0:
                    yield {"price": price, "timestamp": ts}

    async def place_order(self, side: str, amount: float, symbol: str, market_type: str = "spot", stop_loss: float = 0.0) -> dict:
        normalized = self.normalize_market_type(market_type)
        ts = int(time.time() * 1000)
        if normalized == "futures":
            params = f"symbol={symbol}&side={side.upper()}&type=MARKET&quoteOrderQty={amount}&timestamp={ts}"
            url = f"{self.FUTURES_BASE}/fapi/v1/order?{params}&signature={self._sign(params)}"
        else:
            params = f"symbol={symbol}&side={side.upper()}&type=MARKET&quoteOrderQty={amount}&timestamp={ts}"
            url = f"{self.BASE}/api/v3/order?{params}&signature={self._sign(params)}"
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(url, headers=self._headers())
            response.raise_for_status()
            return response.json()

    async def close_position(self, symbol: str, market_type: str = "spot") -> dict:
        return {
            "success": False,
            "error": "Binance close_position requires order-side context; use place_order for now.",
            "symbol": symbol,
            "type": self.normalize_market_type(market_type),
        }

    async def get_history(self, symbol: str, market_type: str = "spot", limit: int = 500) -> list[tuple[float, float]]:
        normalized = self.normalize_market_type(market_type)
        url = f"{self.FUTURES_BASE}/fapi/v1/klines" if normalized == "futures" else f"{self.BASE}/api/v3/klines"
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(url, params={"symbol": symbol, "interval": "1m", "limit": limit})
            response.raise_for_status()
            data = response.json()
        return [(float(item[6]) / 1000.0, float(item[4])) for item in data]

    async def get_ticker(self, symbol: str, market_type: str = "spot") -> float:
        normalized = self.normalize_market_type(market_type)
        base = self.FUTURES_BASE if normalized == "futures" else self.BASE
        endpoint = "/fapi/v1/ticker/price" if normalized == "futures" else "/api/v3/ticker/price"
        async with httpx.AsyncClient(timeout=5) as client:
            response = await client.get(f"{base}{endpoint}", params={"symbol": symbol})
            response.raise_for_status()
            return float(response.json().get("price", 0))
