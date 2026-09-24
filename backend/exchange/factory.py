"""
Exchange factory for authenticated and public exchange clients.
"""
from exchange.binance import BinanceExchange
from exchange.bybit import BybitExchange


def get_exchange(name: str, api_key: str = "", api_secret: str = ""):
    exchange_name = (name or "").strip().lower()
    if exchange_name == "bybit":
        return BybitExchange(api_key=api_key, api_secret=api_secret)
    if exchange_name == "binance":
        return BinanceExchange(api_key=api_key, api_secret=api_secret)
    raise ValueError(f"Unsupported exchange: {name}")
