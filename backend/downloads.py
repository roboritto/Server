import os
import re
import secrets
import time
from pathlib import Path
from typing import List, Optional
from urllib.parse import quote, unquote, urlparse
import httpx
from zipstream import ZIP_STORED, ZipStream

from backend.config import (
    DOWNLOAD_TICKET_TTL,
    LOCAL_MOVIES_DIR,
    PREFERRED_DOWNLOAD_HOST,
)

COLLECTION_DOWNLOAD_TICKETS = {}
LOCAL_FILE_DOWNLOAD_TICKETS = {}
VALID_VIDEO_EXTS = {".mp4", ".mkv", ".avi", ".mov", ".webm", ".m4v", ".ts", ".wmv", ".flv"}
REMOTE_HTTP_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    )
}


def sanitize_filename(name: str, fallback: str = "file") -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", (name or "")).strip()
    cleaned = re.sub(r"\s+", " ", cleaned).strip(". ")
    return cleaned or fallback


def movie_in_collection(raw_collection: str, target_collection: str) -> bool:
    """Matches comma-separated collection names identically to the frontend."""
    if not raw_collection:
        return False
    target_lower = target_collection.strip().lower()
    cols = [c.strip().lower() for c in raw_collection.split(",") if c.strip()]
    return target_lower in cols


def is_http_url(entry: str) -> bool:
    return entry.lower().startswith(("http://", "https://"))


def normalize_local_path(raw_path: str) -> str:
    """Normalizes slashes and trims accidental quotes/prefixes from local paths."""
    cleaned = (raw_path or "").strip().strip('"').strip("'").replace("\\", "/")
    while cleaned.startswith("./"):
        cleaned = cleaned[2:]
    return cleaned.lstrip("/")


def resolve_local_file(raw_path: str) -> Optional[Path]:
    """
    Safely resolves a relative video path inside LOCAL_MOVIES_DIR (or project root).
    Returns None if the path escapes the base directory or does not point to a file.
    """
    if not raw_path or is_http_url(raw_path):
        return None

    rel = normalize_local_path(raw_path)
    if not rel or Path(rel).is_absolute():
        return None

    base_dir = Path(LOCAL_MOVIES_DIR or ".").resolve()
    try:
        candidate = (base_dir / rel).resolve()
    except (OSError, ValueError):
        return None

    if not candidate.is_relative_to(base_dir) or not candidate.is_file():
        return None

    return candidate


def extract_movie_links(raw_link: str) -> List[str]:
    """Splits comma-separated movie links (both HTTP URLs and relative local paths)."""
    if not raw_link:
        return []
    seen = set()
    entries = []
    for part in str(raw_link).split(","):
        clean = part.strip()
        if not clean:
            continue
        key = clean if is_http_url(clean) else normalize_local_path(clean).lower()
        if key and key not in seen:
            seen.add(key)
            entries.append(clean if is_http_url(clean) else normalize_local_path(clean))
    return entries


def prioritize_links(urls: List[str]) -> List[str]:
    """Places links matching PREFERRED_DOWNLOAD_HOST first when configured."""
    if not PREFERRED_DOWNLOAD_HOST:
        return urls
    preferred = []
    others = []
    for url in urls:
        host = (urlparse(url).netloc or "").lower()
        if PREFERRED_DOWNLOAD_HOST in host:
            preferred.append(url)
        else:
            others.append(url)
    return preferred + others


def infer_file_extension(url: str, headers: httpx.Headers) -> str:
    cd = headers.get("content-disposition", "")
    match = re.search(r'filename\*?=(?:UTF-8\'\')?"?([^";\r\n]+)"?', cd, flags=re.IGNORECASE)
    if match:
        cd_name = unquote(match.group(1)).strip()
        _, ext = os.path.splitext(cd_name)
        if ext and len(ext) <= 6:
            return ext.lower()

    url_path = unquote(urlparse(url).path or "")
    _, ext = os.path.splitext(url_path)
    if ext.lower() in VALID_VIDEO_EXTS:
        return ext.lower()

    content_type = (headers.get("content-type") or "").lower()
    if "matroska" in content_type:
        return ".mkv"
    if "webm" in content_type:
        return ".webm"
    return ".mp4"


def parse_remote_size(status_code: int, headers: httpx.Headers) -> Optional[int]:
    if status_code == 206:
        cr = headers.get("content-range", "")
        match = re.search(r"/(\d+)$", cr.strip())
        if match:
            return int(match.group(1))
    cl = headers.get("content-length")
    if cl and cl.isdigit():
        return int(cl)
    return None


def probe_downloadable_link(client: httpx.Client, urls: List[str]) -> Optional[dict]:
    """Probes prioritized URLs and returns metadata for the first direct-downloadable file."""
    for url in prioritize_links(urls):
        try:
            resp = client.head(url, headers=REMOTE_HTTP_HEADERS)
            if resp.status_code in (400, 403, 405, 501):
                with client.stream(
                    "GET", url, headers={**REMOTE_HTTP_HEADERS, "Range": "bytes=0-0"}
                ) as range_resp:
                    status = range_resp.status_code
                    headers = range_resp.headers
                    final_url = str(range_resp.url)
            else:
                status = resp.status_code
                headers = resp.headers
                final_url = str(resp.url)

            if status not in (200, 206):
                continue

            content_type = (headers.get("content-type") or "").lower()
            if "text/html" in content_type:
                continue

            return {
                "url": final_url,
                "ext": infer_file_extension(final_url, headers),
                "size": parse_remote_size(status, headers),
            }
        except Exception:
            continue
    return None


def cleanup_expired_tickets():
    now = time.time()
    for store in (COLLECTION_DOWNLOAD_TICKETS, LOCAL_FILE_DOWNLOAD_TICKETS):
        expired = [k for k, v in store.items() if v["expires_at"] < now]
        for k in expired:
            store.pop(k, None)


def create_local_file_ticket(file_path: Path, client_ip: str) -> dict:
    """Issues a single-use download ticket for a validated local video file."""
    cleanup_expired_tickets()
    ticket = secrets.token_urlsafe(32)
    LOCAL_FILE_DOWNLOAD_TICKETS[ticket] = {
        "expires_at": time.time() + DOWNLOAD_TICKET_TTL,
        "client_ip": client_ip,
        "path": str(file_path),
        "filename": file_path.name,
    }
    return {"ticket": ticket, "filename": file_path.name}


def consume_local_file_ticket(ticket: str, client_ip: str) -> Optional[dict]:
    cleanup_expired_tickets()
    ticket_data = LOCAL_FILE_DOWNLOAD_TICKETS.get(ticket)
    if not ticket_data or ticket_data["client_ip"] != client_ip:
        return None
    return LOCAL_FILE_DOWNLOAD_TICKETS.pop(ticket, None)


def stream_remote_file(url: str):
    """Lazily streams a remote movie file in 128 KB chunks into ZipStream."""
    timeout = httpx.Timeout(connect=20.0, read=60.0, write=30.0, pool=20.0)
    with httpx.Client(follow_redirects=True, timeout=timeout) as client:
        with client.stream("GET", url, headers=REMOTE_HTTP_HEADERS) as resp:
            resp.raise_for_status()
            for chunk in resp.iter_bytes(chunk_size=128 * 1024):
                if chunk:
                    yield chunk


def create_download_ticket(
    collection_rows: List[dict],
    target_collection: str,
    titles: dict[str, str],
    movie_order: List[str],
    client_ip: str,
) -> Optional[dict]:
    """Probes links for every movie in the collection and stores a single-use download ticket."""
    cleanup_expired_tickets()

    if movie_order:
        order_map = {str(m_id): idx for idx, m_id in enumerate(movie_order)}
        collection_rows.sort(
            key=lambda r: order_map.get(str(r.get("movie_id", "")).strip(), 999999)
        )

    resolved_items = []
    skipped_items = []
    used_filenames = set()

    probe_timeout = httpx.Timeout(connect=12.0, read=12.0, write=12.0, pool=12.0)
    with httpx.Client(follow_redirects=True, timeout=probe_timeout) as probe_client:
        for row in collection_rows:
            m_id = str(row.get("movie_id", "")).strip()
            display_title = titles.get(m_id) or f"Movie_{m_id}"
            entries = extract_movie_links(row.get("link", ""))

            if not entries:
                skipped_items.append({"title": display_title, "movie_id": m_id, "links": []})
                continue

            local_candidates = [e for e in entries if not is_http_url(e)]
            http_candidates = [e for e in entries if is_http_url(e)]

            # 1. Prefer an existing local file first (fastest & zero external bandwidth)
            resolved_local = None
            for rel_path in local_candidates:
                candidate = resolve_local_file(rel_path)
                if candidate:
                    resolved_local = candidate
                    break

            if resolved_local:
                ext = resolved_local.suffix.lower() or ".mp4"
                item_payload = {
                    "type": "local",
                    "path": str(resolved_local),
                    "size": resolved_local.stat().st_size,
                }
            else:
                # 2. Fall back to remote HTTP(S) links
                resolved_remote = probe_downloadable_link(probe_client, http_candidates)
                if not resolved_remote:
                    skipped_items.append({"title": display_title, "movie_id": m_id, "links": entries})
                    continue
                ext = resolved_remote["ext"]
                item_payload = {
                    "type": "remote",
                    "url": resolved_remote["url"],
                    "size": resolved_remote["size"],
                }

            base_name = sanitize_filename(display_title, fallback=f"Movie_{m_id}")
            filename = f"{base_name}{ext}"
            counter = 2
            while filename.lower() in used_filenames:
                filename = f"{base_name} ({counter}){ext}"
                counter += 1
            used_filenames.add(filename.lower())

            resolved_items.append({"filename": filename, **item_payload})

    if not resolved_items:
        return None

    ticket = secrets.token_urlsafe(32)
    COLLECTION_DOWNLOAD_TICKETS[ticket] = {
        "expires_at": time.time() + DOWNLOAD_TICKET_TTL,
        "client_ip": client_ip,
        "collection": target_collection,
        "items": resolved_items,
        "skipped": skipped_items,
    }

    return {
        "ticket": ticket,
        "downloadable_count": len(resolved_items),
        "skipped_count": len(skipped_items),
    }


def consume_download_ticket(ticket: str, client_ip: str) -> Optional[dict]:
    cleanup_expired_tickets()
    ticket_data = COLLECTION_DOWNLOAD_TICKETS.get(ticket)
    if not ticket_data or ticket_data["client_ip"] != client_ip:
        return None
    return COLLECTION_DOWNLOAD_TICKETS.pop(ticket, None)


def build_collection_zip_stream(ticket_data: dict) -> tuple[ZipStream, str]:
    """Builds a ZIP_STORED stream and its Content-Disposition header value."""
    folder_name = sanitize_filename(ticket_data["collection"], fallback="Collection")
    zs = ZipStream(compress_type=ZIP_STORED, sized=False)

    for item in ticket_data["items"]:
        arcname = f"{folder_name}/{item['filename']}"
        if item.get("type") == "local":
            zs.add_path(item["path"], arcname=arcname)
        elif item["size"] is not None:
            zs.add(stream_remote_file(item["url"]), arcname=arcname, size=item["size"])
        else:
            zs.add(stream_remote_file(item["url"]), arcname=arcname)

    if ticket_data["skipped"]:
        lines = [
            f"Collection: {ticket_data['collection']}",
            "The following movies could not be direct-downloaded (dead link, missing link, or webpage host):",
            "",
        ]
        for s in ticket_data["skipped"]:
            lines.append(f"- {s['title']} (ID: {s['movie_id']})")
            for link in s["links"]:
                lines.append(f"    {link}")
            if not s["links"]:
                lines.append("    (No link saved)")
        zs.add("\n".join(lines), arcname=f"{folder_name}/_skipped_movies.txt")

    zip_filename = f"{folder_name}.zip"
    ascii_filename = zip_filename.encode("ascii", "ignore").decode("ascii") or "Collection.zip"
    encoded_filename = quote(zip_filename)
    content_disposition = (
        f'attachment; filename="{ascii_filename}"; filename*=UTF-8\'\'{encoded_filename}'
    )

    return zs, content_disposition