"""
Bybit exchange implementation using the unified abstraction layer.
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

RECV_WINDOW = "5000"
BASE_URL = "https://api.bybit.com"


class BybitExchange(BaseExchange):
    name = "bybit"

    def _ts(self) -> str:
        return str(int(time.time() * 1000))

    def _sign(self, timestamp: str, payload: str) -> str:
        raw = f"{timestamp}{self.api_key}{RECV_WINDOW}{payload}"
        return hmac.new(
            self.api_secret.encode("utf-8"),
            raw.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()

    def _headers(self, timestamp: str, signature: str) -> dict:
        return {
            "X-BAPI-API-KEY": self.api_key,
            "X-BAPI-SIGN": signature,
            "X-BAPI-TIMESTAMP": timestamp,
            "X-BAPI-RECV-WINDOW": RECV_WINDOW,
            "Content-Type": "application/json",
        }

    async def _get(self, path: str, params: dict | None = None) -> dict:
        qs = "&".join(f"{k}={v}" for k, v in (params or {}).items())
        ts = self._ts()
        signature = self._sign(ts, qs)
        url = f"{BASE_URL}{path}?{qs}" if qs else f"{BASE_URL}{path}"
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(url, headers=self._headers(ts, signature))
            response.raise_for_status()
            return response.json()

    async def _post(self, path: str, body: dict) -> dict:
        payload = json.dumps(body)
        ts = self._ts()
        signature = self._sign(ts, payload)
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(
                f"{BASE_URL}{path}",
                content=payload,
                headers=self._headers(ts, signature),
            )
            response.raise_for_status()
            return response.json()

    async def get_balance(self) -> dict:
        data = await self._get("/v5/account/wallet-balance", {
            "accountType": "UNIFIED",
            "coin": "USDT",
        })
        balance = 0.0
        for account in data.get("result", {}).get("list", []):
            for coin in account.get("coin", []):
                if coin.get("coin") == "USDT":
                    balance = float(coin.get("availableToWithdraw", 0))
                    break
        return {"balance": balance}

    async def get_markets(self) -> dict:
        async with httpx.AsyncClient(timeout=10) as client:
            spot_resp = await client.get(f"{BASE_URL}/v5/market/instruments-info", params={"category": "spot"})
            spot_resp.raise_for_status()
            spot_rows = spot_resp.json().get("result", {}).get("list", [])

            linear_resp = await client.get(f"{BASE_URL}/v5/market/instruments-info", params={"category": "linear"})
            linear_resp.raise_for_status()
            linear_rows = linear_resp.json().get("result", {}).get("list", [])

        spot = [
            {"symbol": row["symbol"], "type": "spot"}
            for row in spot_rows
            if row.get("status") == "Trading"
        ]
        futures = [
            {"symbol": row["symbol"], "type": "futures"}
            for row in linear_rows
            if row.get("status") == "Trading"
        ]
        merged = []
        seen = set()
        for market in [*spot, *futures]:
            key = (market["symbol"], market["type"])
            if key not in seen:
                merged.append(market)
                seen.add(key)
        return {"exchange": self.name, "markets": merged}

    async def get_price_stream(self, symbol: str, market_type: str = "spot") -> AsyncIterator[dict]:
        normalized = self.normalize_market_type(market_type)
        category = "linear" if normalized == "futures" else "spot"
        url = f"wss://stream.bybit.com/v5/public/{category}"
        async with websockets.connect(url, ping_interval=20, ping_timeout=10) as ws:
            await ws.send(json.dumps({"op": "subscribe", "args": [f"publicTrade.{symbol}"]}))
            async for raw in ws:
                message = json.loads(raw)
                if message.get("topic", "").startswith("publicTrade") and message.get("data"):
                    trade = message["data"][-1]
                    price = float(trade.get("p", 0))
                    ts = int(trade.get("T", int(time.time() * 1000)))
                    if price > 0:
                        yield {"price": price, "timestamp": ts}

    async def place_order(self, side: str, amount: float, symbol: str, market_type: str = "spot", stop_loss: float = 0.0) -> dict:
        normalized = self.normalize_market_type(market_type)
        category = "linear" if normalized == "futures" else "spot"
        body = {
            "category": category,
            "symbol": symbol,
            "side": side.capitalize(),
            "orderType": "Market",
            "qty": str(amount),
            "marketUnit": "quoteCoin",
        }
        if stop_loss > 0 and category == "linear":
            body["stopLoss"] = str(stop_loss)
            body["slOrderType"] = "Market"
            
        result = await self._post("/v5/order/create", body)
        if result.get("retCode") != 0:
            raise RuntimeError(f"Bybit order failed: {result.get('retMsg')}")
        return result

    async def close_position(self, symbol: str, market_type: str = "spot") -> dict:
        return {
            "success": False,
            "error": "Bybit close_position requires order-side context; use place_order for now.",
            "symbol": symbol,
            "type": self.normalize_market_type(market_type),
        }

    async def get_positions(self, symbol: str = "", market_type: str = "spot") -> list:
        category = "linear" if self.normalize_market_type(market_type) == "futures" else "spot"
        params = {"category": category}
        if symbol:
            params["symbol"] = symbol
        data = await self._get("/v5/position/list", params)
        return data.get("result", {}).get("list", [])

    async def get_history(self, symbol: str, market_type: str = "spot", limit: int = 500) -> list[tuple[float, float]]:
        category = "linear" if self.normalize_market_type(market_type) == "futures" else "spot"
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(
                f"{BASE_URL}/v5/market/kline",
                params={"category": category, "symbol": symbol, "interval": "1", "limit": limit},
            )
            response.raise_for_status()
            rows = response.json().get("result", {}).get("list", [])
        rows.sort(key=lambda item: int(item[0]))
        return [(int(item[0]) / 1000.0, float(item[4])) for item in rows]

    async def get_ticker(self, symbol: str, market_type: str = "spot") -> float:
        category = "linear" if self.normalize_market_type(market_type) == "futures" else "spot"
        async with httpx.AsyncClient(timeout=5) as client:
            response = await client.get(
                f"{BASE_URL}/v5/market/tickers",
                params={"category": category, "symbol": symbol},
            )
            response.raise_for_status()
            items = response.json().get("result", {}).get("list", [])
            if items:
                return float(items[0].get("lastPrice", 0))
        return 0.0
