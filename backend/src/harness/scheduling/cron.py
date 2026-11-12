"""Timezone aware cron and interval recurrence helpers."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import math
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


_LIMITS = ((0, 59), (0, 23), (1, 31), (1, 12), (0, 6))


def validate_cron(cron: str) -> None:
    fields = cron.strip().split() if isinstance(cron, str) else []
    if len(fields) != 5:
        raise ValueError("Cron must have five fields")
    import re
    for field, (minimum, maximum) in zip(fields, _LIMITS):
        for part in field.split(","):
            match = re.fullmatch(r"(\*|\d+(?:-\d+)?)(?:/(\d+))?", part)
            if not match:
                raise ValueError("Unsupported cron syntax; use numeric fields, ranges, lists and steps")
            if match.group(2) is not None and not 1 <= int(match.group(2)) <= maximum - minimum + 1:
                raise ValueError("Cron step is out of range")
            if match.group(1) != "*":
                endpoints = [int(value) for value in match.group(1).split("-")]
                if any(value < minimum or value > maximum for value in endpoints) or (
                    len(endpoints) == 2 and endpoints[0] > endpoints[1]
                ):
                    raise ValueError("Cron field is out of range")


def next_cron_time(cron: str, tz: str, now: datetime | int | float | None = None) -> int:
    """Return the next occurrence as Unix milliseconds in the supplied IANA zone."""
    validate_cron(cron)
    try:
        zone = ZoneInfo(tz)
    except (ZoneInfoNotFoundError, TypeError, ValueError) as exc:
        raise ValueError("Invalid timezone") from exc
    if isinstance(now, (int, float)):
        current = datetime.fromtimestamp(now / 1000, timezone.utc)
    else:
        current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    fields = [_field_values(item, limits[0], limits[1])
              for item, limits in zip(cron.strip().split(), _LIMITS)]
    raw_fields = cron.strip().split()
    # Search on the UTC timeline, then match the local wall clock. A spring
    # missing wall time is naturally skipped; a repeated fall wall time occurs
    # twice and both instants are eligible, matching cron's local-time rule.
    candidate = current.astimezone(timezone.utc).replace(second=0, microsecond=0) + timedelta(minutes=1)
    deadline = candidate + timedelta(days=366 * 5 + 2)
    while candidate <= deadline:
        local = candidate.astimezone(zone)
        minute, hour, day, month, weekday = fields
        # JavaScript Intl/cron weekday semantics: Sunday is zero.
        cron_weekday = (local.weekday() + 1) % 7
        day_matches = local.day in day
        weekday_matches = cron_weekday in weekday
        calendar_day_matches = (day_matches and weekday_matches if raw_fields[2] == "*" or raw_fields[4] == "*"
                                else day_matches or weekday_matches)
        if (local.minute in minute and local.hour in hour and calendar_day_matches and local.month in month):
            return int(candidate.timestamp() * 1000)
        candidate += timedelta(minutes=1)
    raise ValueError("Cron has no occurrence in the next five years")


def _field_values(field: str, minimum: int, maximum: int) -> set[int]:
    values: set[int] = set()
    for part in field.split(","):
        base, slash, step_text = part.partition("/")
        step = int(step_text) if slash else 1
        if base == "*":
            start, end = minimum, maximum
        elif "-" in base:
            start, end = (int(value) for value in base.split("-", 1))
        else:
            start = end = int(base)
        values.update(range(start, end + 1, step))
    return values


def next_interval_time(previous: int | float, seconds: int | float, now: int | float) -> int:
    interval = seconds * 1000
    if not math.isfinite(interval) or interval < 60000:
        raise ValueError("Interval must be at least 60 seconds")
    return int(previous + (int(max(0, now - previous) // interval) + 1) * interval)
