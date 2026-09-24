"""
Exchange integration facade built on the unified exchange abstraction layer.
"""
from state import state
from exchange.factory import get_exchange


def get_exchange_client(exchange_name: str):
    key, secret = state.get_credentials()
    if not key or not secret:
        raise ValueError("No API credentials stored")
    return get_exchange(exchange_name, api_key=key, api_secret=secret)


def get_public_exchange(exchange_name: str):
    return get_exchange(exchange_name)


async def sync_account_balance(exchange_name: str) -> float:
    client = get_exchange_client(exchange_name)
    result = await client.get_balance()
    balance = float(result.get("balance", 0.0))
    state.live_balance = balance
    return balance


async def sync_positions(exchange_name: str) -> list:
    try:
        client = get_exchange_client(exchange_name)
        return await client.get_positions(symbol=state.selected_symbol, market_type=state.market_type)
    except Exception as exc:
        print(f"[EXCHANGE] Failed to fetch positions: {exc}")
        return []


async def execute_real_trade(exchange_name: str, symbol: str, side: str, amount: float, market_type: str | None = None, stop_loss: float = 0.0) -> dict:
    try:
        client = get_exchange_client(exchange_name)
        result = await client.place_order(
            side=side,
            amount=amount,
            symbol=symbol,
            market_type=market_type or state.market_type,
            stop_loss=stop_loss,
        )
        print(f"[TRADE] {side.upper()} ${amount} {symbol} on {exchange_name}")
        return {"success": True, "data": result}
    except Exception as exc:
        print(f"[TRADE] failed: {exc}")
        return {"success": False, "error": str(exc)}


async def get_exchange_info(exchange_name: str) -> dict:
    try:
        client = get_public_exchange(exchange_name)
        normalized = await client.get_markets()
        markets = normalized.get("markets", [])
        pairs_by_type = {}
        for market in markets:
            pairs_by_type.setdefault(market["type"], []).append(market["symbol"])

        ordered_types = [market_type for market_type in ("spot", "futures") if market_type in pairs_by_type]
        merged_pairs = []
        seen = set()
        for market_type in ordered_types:
            for symbol in pairs_by_type[market_type]:
                if symbol not in seen:
                    merged_pairs.append(symbol)
                    seen.add(symbol)

        return {
            "exchange": normalized.get("exchange", exchange_name),
            "types": ordered_types,
            "pairs": merged_pairs,
            "pairs_by_type": pairs_by_type,
        }
    except Exception as exc:
        print(f"[EXCHANGE] get_exchange_info error: {exc}")
        raise


async def get_latest_price(exchange_name: str, symbol: str, market_type: str = "spot") -> float:
    client = get_public_exchange(exchange_name)
    return await client.get_ticker(symbol, market_type=market_type)
