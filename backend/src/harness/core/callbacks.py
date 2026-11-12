"""Invoke synchronous or asynchronous application callbacks."""
import inspect
from typing import Any, Callable


async def _invoke(callback: Callable[..., Any], *args: Any) -> Any:
    result = callback(*args)
    return await result if inspect.isawaitable(result) else result
