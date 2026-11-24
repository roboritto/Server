import csv
import json
import os
import threading
from datetime import datetime, timedelta
from typing import List, Optional
from fastapi import HTTPException, Request

from backend.config import (
    ADMIN_IPS,
    CSV_FIELDNAMES,
    CSV_FILE,
    CUSTOM_MOVIES_FILE,
    HIDDEN_MOVIES_FILE,
    KNOWN_MOVIES_FILE,
    LOCAL_TZ,
    NEW_BADGE_DAYS,
    PERMISSIONS_FILE,
    TMDB_CACHE_FILE,
)

_tmdb_cache_lock = threading.Lock()
_custom_movies_lock = threading.Lock()
_hidden_movies_lock = threading.Lock()

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


def save_custom_movie(movie_id: str, metadata: dict):
    """Thread-safely saves or updates a custom movie entry in custom_movies.json."""
    key = str(movie_id).strip()
    if not key:
        raise ValueError("movie_id is required")

    with _custom_movies_lock:
        custom_data = load_custom_movies()
        custom_data[key] = metadata
        _write_json_atomic(CUSTOM_MOVIES_FILE, custom_data, indent=2)


def load_hidden_movies_config() -> dict:
    """Loads hidden_movies and allowed_ips lists from hidden_movies.json."""
    default_cfg = {"hidden_movies": [], "allowed_ips": []}
    if not os.path.exists(HIDDEN_MOVIES_FILE):
        return default_cfg
    try:
        with open(HIDDEN_MOVIES_FILE, mode="r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return default_cfg

        raw_hidden = data.get("hidden_movies", [])
        raw_allowed = data.get("allowed_ips", [])

        hidden_movies = (
            [str(m).strip() for m in raw_hidden if str(m).strip()]
            if isinstance(raw_hidden, list)
            else []
        )
        allowed_ips = (
            [str(ip).strip() for ip in raw_allowed if str(ip).strip()]
            if isinstance(raw_allowed, list)
            else []
        )
        return {"hidden_movies": hidden_movies, "allowed_ips": allowed_ips}
    except Exception as e:
        print(f"Warning: Could not read {HIDDEN_MOVIES_FILE}: {e}")
        return default_cfg


def get_client_ip(request: Request) -> str:
    """Returns the connecting client's IP address (normalizing IPv4-mapped IPv6)."""
    host = request.client.host if request.client else ""
    if host.startswith("::ffff:"):
        return host[7:]
    return host


def get_hidden_ids_for_request(request: Request) -> set[str]:
    """
    Returns hidden movie IDs for the requesting IP.
    ADMIN_IPS and IPs listed in allowed_ips bypass the hidden list.
    """
    if is_admin_request(request):
        return set()

    config = load_hidden_movies_config()
    client_ip = get_client_ip(request)
    if client_ip in set(config["allowed_ips"]):
        return set()

    return set(config["hidden_movies"])


def toggle_hidden_movie(movie_id: str) -> bool:
    """
    Adds or removes a movie_id from hidden_movies.json atomically.
    Returns True if the movie is now hidden, False if visible to the public.
    """
    key = str(movie_id).strip()
    with _hidden_movies_lock:
        config = load_hidden_movies_config()
        hidden_list = config["hidden_movies"]

        if key in hidden_list:
            config["hidden_movies"] = [m for m in hidden_list if m != key]
            is_now_hidden = False
        else:
            hidden_list.append(key)
            config["hidden_movies"] = hidden_list
            is_now_hidden = True

        _write_json_atomic(HIDDEN_MOVIES_FILE, config, indent=2)
        return is_now_hidden


def remove_from_hidden_movies(movie_id: str):
    """Removes a deleted movie_id from hidden_movies.json if present."""
    key = str(movie_id).strip()
    if not key or not os.path.exists(HIDDEN_MOVIES_FILE):
        return

    with _hidden_movies_lock:
        config = load_hidden_movies_config()
        if key in config["hidden_movies"]:
            config["hidden_movies"] = [m for m in config["hidden_movies"] if m != key]
            try:
                _write_json_atomic(HIDDEN_MOVIES_FILE, config, indent=2)
            except Exception as e:
                print(f"Warning: Could not update {HIDDEN_MOVIES_FILE} on delete: {e}")


ALL_PERMISSION_ACTIONS = (
    "delete",
    "add_movie",
    "add_link",
    "edit_rating",
    "edit_collection",
    "download_collection",
)


def is_admin_request(request: Request) -> bool:
    """Returns True if the connecting client's IP is listed in ADMIN_IPS."""
    return get_client_ip(request) in ADMIN_IPS


def load_public_permissions() -> dict[str, bool]:
    """Loads public action permissions from permissions.json (defaults all to True if missing)."""
    defaults = {action: True for action in ALL_PERMISSION_ACTIONS}
    if not os.path.exists(PERMISSIONS_FILE):
        return defaults

    try:
        with open(PERMISSIONS_FILE, mode="r", encoding="utf-8") as f:
            raw = json.load(f)
        public_map = raw.get("public_permissions", raw) if isinstance(raw, dict) else {}
        if not isinstance(public_map, dict):
            return defaults

        return {
            action: bool(public_map.get(action, True))
            for action in ALL_PERMISSION_ACTIONS
        }
    except Exception as e:
        print(f"Warning: Could not read {PERMISSIONS_FILE}: {e}")
        return defaults


def get_permissions_for_request(request: Request) -> dict[str, bool]:
    """Admins get all permissions; non-admin IPs follow permissions.json."""
    if is_admin_request(request):
        return {action: True for action in ALL_PERMISSION_ACTIONS}
    return load_public_permissions()


def require_permission(request: Request, action: str):
    """Raises 403 Forbidden if the requesting IP is not allowed to perform the action."""
    perms = get_permissions_for_request(request)
    if not perms.get(action, True):
        raise HTTPException(
            status_code=403,
            detail=f"Permission denied: '{action}' is restricted for your IP.",
        )


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


def _write_json_atomic(filepath: str, data: dict, indent: Optional[int] = None):
    """Writes JSON to a temp file first, then atomically swaps it into place."""
    tmp_path = f"{filepath}.tmp"
    with open(tmp_path, mode="w", encoding="utf-8") as f:
        json.dump(data, f, indent=indent, ensure_ascii=False)
    os.replace(tmp_path, filepath)


def load_tmdb_cache() -> dict:
    """Loads cached TMDB movie metadata from tmdb_cache.json."""
    if not os.path.exists(TMDB_CACHE_FILE):
        return {}
    try:
        with open(TMDB_CACHE_FILE, mode="r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except Exception as e:
        print(f"Warning: Could not read {TMDB_CACHE_FILE}: {e}")
        return {}


def merge_tmdb_cache(entries: dict) -> int:
    """Thread-safely merges newly fetched TMDB movie entries into tmdb_cache.json."""
    if not isinstance(entries, dict) or not entries:
        return 0

    with _tmdb_cache_lock:
        cache = load_tmdb_cache()
        saved_count = 0

        for movie_id, metadata in entries.items():
            key = str(movie_id).strip()
            if key and isinstance(metadata, dict):
                cache[key] = metadata
                saved_count += 1

        if saved_count > 0:
            try:
                _write_json_atomic(TMDB_CACHE_FILE, cache)
            except Exception as e:
                print(f"Warning: Could not save {TMDB_CACHE_FILE}: {e}")
                raise

        return saved_count


def remove_from_tmdb_cache(movie_id: str):
    """Removes a deleted movie_id from tmdb_cache.json if present."""
    key = str(movie_id).strip()
    if not key or not os.path.exists(TMDB_CACHE_FILE):
        return

    with _tmdb_cache_lock:
        cache = load_tmdb_cache()
        if key in cache:
            del cache[key]
            try:
                _write_json_atomic(TMDB_CACHE_FILE, cache)
            except Exception as e:
                print(f"Warning: Could not update {TMDB_CACHE_FILE} on delete: {e}")