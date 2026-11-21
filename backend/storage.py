import csv
import json
import os
from datetime import datetime, timedelta
from typing import List
from fastapi import Request

from backend.config import (
    CSV_FIELDNAMES,
    CSV_FILE,
    CUSTOM_MOVIES_FILE,
    HIDDEN_MOVIES_FILE,
    KNOWN_MOVIES_FILE,
    LOCAL_TZ,
    NEW_BADGE_DAYS,
)


def read_csv() -> List[dict]:
    if not os.path.exists(CSV_FILE):
        return []
    with open(CSV_FILE, mode="r", encoding="utf-8") as file:
        return list(csv.DictReader(file))


def write_csv(data: List[dict]):
    with open(CSV_FILE, mode="w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=CSV_FIELDNAMES, quoting=csv.QUOTE_ALL)
        writer.writeheader()
        writer.writerows(data)


def load_custom_movies() -> dict:
    """Loads local metadata for non-TMDB movies from custom_movies.json."""
    if not os.path.exists(CUSTOM_MOVIES_FILE):
        return {}
    try:
        with open(CUSTOM_MOVIES_FILE, mode="r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except Exception as e:
        print(f"Warning: Could not read {CUSTOM_MOVIES_FILE}: {e}")
        return {}


def load_hidden_movies_by_ip() -> dict:
    """Loads the IP-to-hidden-movies mapping from hidden_movies.json."""
    if not os.path.exists(HIDDEN_MOVIES_FILE):
        return {}
    try:
        with open(HIDDEN_MOVIES_FILE, mode="r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except Exception as e:
        print(f"Warning: Could not read {HIDDEN_MOVIES_FILE}: {e}")
        return {}


def get_client_ip(request: Request) -> str:
    """Returns the connecting client's IP address (normalizing IPv4-mapped IPv6)."""
    host = request.client.host if request.client else ""
    if host.startswith("::ffff:"):
        return host[7:]
    return host


def get_hidden_ids_for_request(request: Request) -> set[str]:
    """Returns a normalized set of movie_id strings hidden from the requesting IP."""
    client_ip = get_client_ip(request)
    hidden_map = load_hidden_movies_by_ip()
    hidden_ids = hidden_map.get(client_ip, [])
    if not isinstance(hidden_ids, list):
        return set()
    return {str(m_id).strip() for m_id in hidden_ids}


def attach_is_new_flags(movies: List[dict]) -> List[dict]:
    """
    Tracks when each movie_id was first seen using known_movies.json
    and sets is_new = True if first seen within NEW_BADGE_DAYS.
    """
    now_local = datetime.now(LOCAL_TZ)
    is_first_init = not os.path.exists(KNOWN_MOVIES_FILE)

    known_map = {}
    if not is_first_init:
        try:
            with open(KNOWN_MOVIES_FILE, mode="r", encoding="utf-8") as f:
                known_map = json.load(f)
        except Exception:
            known_map = {}
            is_first_init = True

    updated = False
    for movie in movies:
        m_id = str(movie.get("movie_id", "")).strip()
        if not m_id:
            movie["is_new"] = False
            continue

        if m_id not in known_map:
            if is_first_init:
                # Baseline existing movies on first run so the whole library isn't marked NEW
                known_map[m_id] = "2000-01-01T00:00:00+00:00"
            else:
                known_map[m_id] = now_local.isoformat()
            updated = True

        try:
            added_dt = datetime.fromisoformat(known_map[m_id])
            movie["is_new"] = (now_local - added_dt) <= timedelta(days=NEW_BADGE_DAYS)
        except Exception:
            movie["is_new"] = False

    if updated or is_first_init:
        try:
            with open(KNOWN_MOVIES_FILE, mode="w", encoding="utf-8") as f:
                json.dump(known_map, f, indent=2)
        except Exception as e:
            print(f"Warning: Could not save {KNOWN_MOVIES_FILE}: {e}")

    return movies


def remove_from_known_movies(movie_id: str):
    """Removes a deleted movie_id from known_movies.json if present."""
    if not os.path.exists(KNOWN_MOVIES_FILE):
        return
    try:
        with open(KNOWN_MOVIES_FILE, mode="r", encoding="utf-8") as f:
            known_map = json.load(f)
        if movie_id in known_map:
            del known_map[movie_id]
            with open(KNOWN_MOVIES_FILE, mode="w", encoding="utf-8") as f:
                json.dump(known_map, f, indent=2)
    except Exception as e:
        print(f"Warning: Could not update {KNOWN_MOVIES_FILE} on delete: {e}")