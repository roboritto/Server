import json
import mimetypes
import os
import re
import secrets
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import List, Optional
from urllib.parse import quote, unquote, urlparse
import httpx
from zipstream import ZIP_STORED, ZipStream

from backend.config import (
    DOWNLOAD_TICKET_TTL,
    FFMPEG_PATH,
    FFPROBE_PATH,
    LOCAL_MOVIES_DIR,
    PREFERRED_DOWNLOAD_HOST,
    STREAM_TICKET_TTL,
)

COLLECTION_DOWNLOAD_TICKETS = {}
LOCAL_FILE_DOWNLOAD_TICKETS = {}
LOCAL_STREAM_TICKETS = {}
_HLS_LOCK = threading.Lock()
VALID_VIDEO_EXTS = {".mp4", ".mkv", ".avi", ".mov", ".webm", ".m4v", ".ts", ".wmv", ".flv"}
BROWSER_NATIVE_EXTS = {".mp4", ".m4v", ".webm"}
BROWSER_SAFE_VIDEO_CODECS = {"h264", "vp8", "vp9", "av1"}
BROWSER_SAFE_AUDIO_CODECS = {"aac", "mp3", "opus", "vorbis"}
TEXT_SUBTITLE_CODECS = {"subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text"}
SUBTITLE_EXTS = {".srt", ".vtt"}
SUBTITLE_LANG_LABELS = {
    "en": "English",
    "eng": "English",
    "english": "English",
    "ms": "Malay",
    "may": "Malay",
    "msa": "Malay",
    "malay": "Malay",
    "bm": "Malay",
    "id": "Indonesian",
    "ind": "Indonesian",
    "zh": "Chinese",
    "chi": "Chinese",
    "zho": "Chinese",
    "ja": "Japanese",
    "jpn": "Japanese",
    "ko": "Korean",
    "kor": "Korean",
}
_SUBTITLE_TIMING_RE = re.compile(
    r"((?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3})(.*)"
)
_NO_WINDOW_FLAG = getattr(subprocess, "CREATE_NO_WINDOW", 0)
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
    for store in (COLLECTION_DOWNLOAD_TICKETS, LOCAL_FILE_DOWNLOAD_TICKETS, LOCAL_STREAM_TICKETS):
        expired = [k for k, v in store.items() if v["expires_at"] < now]
        for k in expired:
            item = store.pop(k, None)
            if store is LOCAL_STREAM_TICKETS and item:
                stop_hls_session(item)


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


def guess_video_media_type(file_path: Path) -> str:
    ext = file_path.suffix.lower()
    overrides = {
        ".mp4": "video/mp4",
        ".m4v": "video/mp4",
        ".webm": "video/webm",
        ".mkv": "video/x-matroska",
        ".mov": "video/quicktime",
        ".avi": "video/x-msvideo",
        ".ts": "video/mp2t",
    }
    if ext in overrides:
        return overrides[ext]
    guessed, _ = mimetypes.guess_type(str(file_path))
    return guessed or "application/octet-stream"


def get_ffmpeg_binary() -> Optional[str]:
    if FFMPEG_PATH:
        return FFMPEG_PATH if os.path.exists(FFMPEG_PATH) else None
    return shutil.which("ffmpeg")


def get_ffprobe_binary() -> Optional[str]:
    if FFPROBE_PATH:
        return FFPROBE_PATH if os.path.exists(FFPROBE_PATH) else None
    return shutil.which("ffprobe")


def _format_subtitle_label(raw_suffix: str, fallback: str) -> str:
    cleaned = re.sub(r"^[._\-\s]+", "", (raw_suffix or "").strip())
    if not cleaned:
        return fallback
    lower = cleaned.lower()
    if lower in SUBTITLE_LANG_LABELS:
        return SUBTITLE_LANG_LABELS[lower]
    parts = [p for p in re.split(r"[._\-\s]+", cleaned) if p]
    mapped = [SUBTITLE_LANG_LABELS.get(p.lower(), p) for p in parts]
    return " ".join(mapped) or fallback


def probe_local_video(file_path: Path) -> dict:
    """Uses ffprobe (if installed) to read duration, codecs, and embedded text subtitles."""
    info = {
        "duration": 0.0,
        "video_codec": "",
        "video_pix_fmt": "",
        "audio_codec": "",
        "embedded_subtitles": [],
    }
    ffprobe_bin = get_ffprobe_binary()
    if not ffprobe_bin:
        return info

    try:
        proc = subprocess.run(
            [
                ffprobe_bin,
                "-v",
                "quiet",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
                str(file_path),
            ],
            capture_output=True,
            text=True,
            timeout=10,
            creationflags=_NO_WINDOW_FLAG,
        )
        if proc.returncode != 0 or not proc.stdout:
            return info

        data = json.loads(proc.stdout)
        fmt_duration = data.get("format", {}).get("duration")
        if fmt_duration:
            try:
                info["duration"] = float(fmt_duration)
            except (TypeError, ValueError):
                pass

        for stream in data.get("streams", []):
            codec_type = stream.get("codec_type")
            codec_name = (stream.get("codec_name") or "").lower()
            if codec_type == "video" and not info["video_codec"]:
                info["video_codec"] = codec_name
                info["video_pix_fmt"] = (stream.get("pix_fmt") or "").lower()
            elif codec_type == "audio" and not info["audio_codec"]:
                info["audio_codec"] = codec_name
            elif codec_type == "subtitle" and codec_name in TEXT_SUBTITLE_CODECS:
                tags = stream.get("tags") or {}
                lang = (tags.get("language") or "").strip()
                title = (tags.get("title") or "").strip()
                lang_label = SUBTITLE_LANG_LABELS.get(lang.lower(), lang.upper() if lang else "")
                if title and lang_label and lang_label.lower() not in title.lower():
                    label = f"{lang_label} — {title}"
                else:
                    label = title or lang_label or f"Track {len(info['embedded_subtitles']) + 1}"
                info["embedded_subtitles"].append(
                    {
                        "source": "embedded",
                        "stream_index": int(stream.get("index", 0)),
                        "label": f"{label} (Embedded)",
                        "language": lang[:2].lower() if lang else "",
                    }
                )
    except Exception as e:
        print(f"Warning: ffprobe failed for {file_path.name}: {e}")

    return info


def find_sidecar_subtitles(video_path: Path) -> List[dict]:
    """Finds .srt/.vtt subtitle files matching the movie in its folder or Subs/ subfolder."""
    parent = video_path.parent
    stem_lower = video_path.stem.lower()
    candidates: List[Path] = []

    video_siblings = [
        p for p in parent.iterdir()
        if p.is_file() and p.suffix.lower() in VALID_VIDEO_EXTS
    ]
    single_video_folder = len(video_siblings) == 1

    for item in sorted(parent.iterdir(), key=lambda p: p.name.lower()):
        if not item.is_file() or item.suffix.lower() not in SUBTITLE_EXTS:
            continue
        item_stem_lower = item.stem.lower()
        matches_stem = (
            item_stem_lower == stem_lower
            or item_stem_lower.startswith((f"{stem_lower}.", f"{stem_lower}_", f"{stem_lower} ", f"{stem_lower}-"))
        )
        if matches_stem or single_video_folder:
            candidates.append(item)

    for subs_dir_name in ("Subs", "subs", "Subtitles", "subtitles"):
        subs_dir = parent / subs_dir_name
        if not subs_dir.is_dir():
            continue
        search_dirs = [subs_dir]
        nested = subs_dir / video_path.stem
        if nested.is_dir():
            search_dirs.append(nested)
        for sdir in search_dirs:
            for item in sorted(sdir.iterdir(), key=lambda p: p.name.lower()):
                if item.is_file() and item.suffix.lower() in SUBTITLE_EXTS:
                    if single_video_folder or sdir == nested or item.stem.lower().startswith(stem_lower):
                        candidates.append(item)

    seen = set()
    tracks = []
    for sub_path in candidates:
        resolved = str(sub_path.resolve())
        if resolved in seen:
            continue
        seen.add(resolved)
        suffix_part = sub_path.stem[len(video_path.stem):] if sub_path.stem.lower().startswith(stem_lower) else sub_path.stem
        label = _format_subtitle_label(suffix_part, fallback=sub_path.stem)
        tracks.append(
            {
                "source": "file",
                "path": resolved,
                "label": label,
                "language": "",
            }
        )
    return tracks


def needs_ffmpeg_remux(file_path: Path, probe: dict) -> bool:
    """Determines whether a video needs FFmpeg remux/transcode for universal browser playback."""
    if not get_ffmpeg_binary():
        return False
    ext = file_path.suffix.lower()
    if ext not in BROWSER_NATIVE_EXTS:
        return True
    vcodec = probe.get("video_codec", "")
    acodec = probe.get("audio_codec", "")
    if vcodec and vcodec not in BROWSER_SAFE_VIDEO_CODECS:
        return True
    if acodec and acodec not in BROWSER_SAFE_AUDIO_CODECS:
        return True
    return False


def create_local_stream_ticket(file_path: Path, client_ip: str) -> dict:
    """Issues a reusable, IP-bound streaming ticket with codec probe and subtitle discovery."""
    cleanup_expired_tickets()
    ticket = secrets.token_urlsafe(32)
    probe = probe_local_video(file_path)
    use_ffmpeg = needs_ffmpeg_remux(file_path, probe)
    media_type = "video/mp4" if use_ffmpeg else guess_video_media_type(file_path)

    subtitles = find_sidecar_subtitles(file_path)
    if get_ffmpeg_binary():
        subtitles.extend(probe.get("embedded_subtitles", []))

    LOCAL_STREAM_TICKETS[ticket] = {
        "expires_at": time.time() + STREAM_TICKET_TTL,
        "client_ip": client_ip,
        "path": str(file_path),
        "filename": file_path.name,
        "media_type": media_type,
        "mode": "ffmpeg" if use_ffmpeg else "direct",
        "duration": probe.get("duration", 0.0),
        "video_codec": probe.get("video_codec", ""),
        "video_pix_fmt": probe.get("video_pix_fmt", ""),
        "audio_codec": probe.get("audio_codec", ""),
        "subtitles": subtitles,
        "hls_session": None,
    }

    public_subtitles = [
        {"index": idx, "label": sub["label"], "source": sub["source"]}
        for idx, sub in enumerate(subtitles)
    ]

    return {
        "ticket": ticket,
        "filename": file_path.name,
        "media_type": media_type,
        "mode": "ffmpeg" if use_ffmpeg else "direct",
        "duration": probe.get("duration", 0.0),
        "ffmpeg_available": bool(get_ffmpeg_binary()),
        "subtitles": public_subtitles,
    }


def get_local_stream_ticket(ticket: str, client_ip: str) -> Optional[dict]:
    """Validates a reusable streaming ticket without consuming it."""
    cleanup_expired_tickets()
    ticket_data = LOCAL_STREAM_TICKETS.get(ticket)
    if not ticket_data or ticket_data["client_ip"] != client_ip:
        return None
    return ticket_data


def _can_copy_video_for_mobile(ticket_data: dict) -> bool:
    vcodec = ticket_data.get("video_codec", "")
    pix_fmt = ticket_data.get("video_pix_fmt", "")
    return vcodec == "h264" and pix_fmt in ("", "yuv420p")


def stop_hls_session(ticket_data: dict):
    """Terminates any running FFmpeg HLS process and deletes its temporary segments."""
    with _HLS_LOCK:
        session = ticket_data.get("hls_session")
        ticket_data["hls_session"] = None

    if not session:
        return

    proc = session.get("process")
    if proc and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()

    hls_dir = session.get("dir")
    if hls_dir and os.path.isdir(hls_dir):
        shutil.rmtree(hls_dir, ignore_errors=True)


def start_hls_session(ticket_data: dict, start_seconds: float = 0.0) -> Optional[str]:
    """Starts an on-the-fly FFmpeg HLS stream for mobile/desktop Firefox & iOS and returns session_id."""
    ffmpeg_bin = get_ffmpeg_binary()
    if not ffmpeg_bin:
        return None

    stop_hls_session(ticket_data)

    session_id = secrets.token_urlsafe(8)
    hls_dir = Path(tempfile.mkdtemp(prefix="cinema_hls_"))
    playlist_path = hls_dir / "index.m3u8"

    cmd = [ffmpeg_bin, "-v", "error"]
    if start_seconds > 0:
        cmd.extend(["-ss", f"{start_seconds:.3f}"])
    cmd.extend(["-i", ticket_data["path"], "-map", "0:v:0", "-map", "0:a:0?"])

    if _can_copy_video_for_mobile(ticket_data):
        cmd.extend(["-c:v", "copy", "-bsf:v", "h264_mp4toannexb"])
    else:
        cmd.extend([
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
            "-profile:v", "main", "-level", "4.1", "-pix_fmt", "yuv420p",
            "-g", "48", "-keyint_min", "48", "-sc_threshold", "0",
        ])

    if ticket_data.get("audio_codec") == "aac":
        cmd.extend(["-c:a", "copy"])
    else:
        cmd.extend(["-c:a", "aac", "-ac", "2", "-ar", "48000", "-b:a", "192k"])

    cmd.extend([
        "-avoid_negative_ts", "make_zero",
        "-f", "hls",
        "-hls_time", "4",
        "-hls_list_size", "0",
        "-hls_playlist_type", "event",
        "-hls_flags", "independent_segments",
        "-hls_segment_filename", str(hls_dir / "seg_%05d.ts"),
        str(playlist_path),
    ])

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=_NO_WINDOW_FLAG,
    )

    session = {"id": session_id, "dir": str(hls_dir), "process": proc}
    with _HLS_LOCK:
        ticket_data["hls_session"] = session

    # Wait until the first .ts segment is written into index.m3u8
    deadline = time.time() + 15.0
    while time.time() < deadline:
        if playlist_path.is_file():
            try:
                content = playlist_path.read_text(encoding="utf-8", errors="ignore")
                if ".ts" in content:
                    return session_id
            except OSError:
                pass
        if proc.poll() is not None:
            break
        time.sleep(0.15)

    stop_hls_session(ticket_data)
    return None


def get_hls_file_path(ticket_data: dict, session_id: str, filename: str) -> Optional[Path]:
    """Safely returns the path to index.m3u8 or a seg_XXXXX.ts file for an active HLS session."""
    if not re.fullmatch(r"(?:index\.m3u8|seg_\d{5}\.ts)", filename or ""):
        return None

    session = ticket_data.get("hls_session")
    if not session or session.get("id") != session_id:
        return None

    candidate = Path(session["dir"]) / filename
    return candidate if candidate.is_file() else None


def stream_transcoded_video(ticket_data: dict, start_seconds: float = 0.0):
    """Fallback fragmented MP4 stream if hls.js is unavailable offline."""
    ffmpeg_bin = get_ffmpeg_binary()
    if not ffmpeg_bin:
        return

    cmd = [ffmpeg_bin, "-v", "error"]
    if start_seconds > 0:
        cmd.extend(["-ss", f"{start_seconds:.3f}"])
    cmd.extend(["-i", ticket_data["path"], "-map", "0:v:0", "-map", "0:a:0?"])

    if _can_copy_video_for_mobile(ticket_data):
        cmd.extend(["-c:v", "copy"])
    else:
        cmd.extend([
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
            "-profile:v", "main", "-level", "4.1", "-pix_fmt", "yuv420p",
            "-g", "48",
        ])

    if ticket_data.get("audio_codec") in {"aac", "mp3"}:
        cmd.extend(["-c:a", "copy"])
    else:
        cmd.extend(["-c:a", "aac", "-ac", "2", "-ar", "48000", "-b:a", "192k"])

    cmd.extend([
        "-f", "mp4",
        "-movflags", "frag_keyframe+empty_moov+default_base_moof",
        "-reset_timestamps", "1",
        "pipe:1",
    ])

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        creationflags=_NO_WINDOW_FLAG,
    )
    try:
        assert proc.stdout is not None
        while True:
            chunk = proc.stdout.read(64 * 1024)
            if not chunk:
                break
            yield chunk
    finally:
        if proc.stdout:
            proc.stdout.close()
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()


def _parse_subtitle_ts(ts_str: str) -> float:
    parts = ts_str.replace(",", ".").split(":")
    if len(parts) == 3:
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    if len(parts) == 2:
        return int(parts[0]) * 60 + float(parts[1])
    return 0.0


def _format_vtt_ts(seconds: float) -> str:
    ms_total = max(0, int(round(seconds * 1000)))
    hours, rem = divmod(ms_total, 3_600_000)
    minutes, rem = divmod(rem, 60_000)
    secs, ms = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{ms:03d}"


def convert_srt_or_vtt_to_vtt(raw_text: str, offset_seconds: float = 0.0) -> str:
    """Converts .srt or .vtt text into WebVTT and shifts cue times by -offset_seconds."""
    text = raw_text.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    blocks = re.split(r"\n\s*\n", text.strip())
    output = ["WEBVTT", ""]

    for block in blocks:
        lines = [line for line in block.split("\n") if line.strip()]
        if not lines:
            continue
        first_upper = lines[0].strip().upper()
        if first_upper.startswith("WEBVTT") or first_upper.startswith("NOTE"):
            continue

        timing_idx = next((i for i, l in enumerate(lines) if _SUBTITLE_TIMING_RE.match(l.strip())), -1)
        if timing_idx == -1:
            continue

        match = _SUBTITLE_TIMING_RE.match(lines[timing_idx].strip())
        if not match:
            continue

        start = _parse_subtitle_ts(match.group(1)) - offset_seconds
        end = _parse_subtitle_ts(match.group(2)) - offset_seconds
        if end <= 0:
            continue

        cue_lines = lines[timing_idx + 1:]
        if not cue_lines:
            continue

        output.append(f"{_format_vtt_ts(max(0.0, start))} --> {_format_vtt_ts(end)}{match.group(3)}")
        output.extend(cue_lines)
        output.append("")

    return "\n".join(output)


def render_subtitle_track_vtt(
    ticket_data: dict, track_index: int, offset_seconds: float = 0.0
) -> Optional[str]:
    """Reads a sidecar .srt/.vtt or extracts an embedded MKV subtitle stream as WebVTT."""
    subtitles = ticket_data.get("subtitles") or []
    if track_index < 0 or track_index >= len(subtitles):
        return None

    track = subtitles[track_index]
    if track["source"] == "file":
        sub_path = Path(track["path"])
        if not sub_path.is_file():
            return None
        try:
            raw_text = sub_path.read_text(encoding="utf-8-sig")
        except UnicodeDecodeError:
            raw_text = sub_path.read_text(encoding="cp1252", errors="replace")
        return convert_srt_or_vtt_to_vtt(raw_text, offset_seconds=offset_seconds)

    if track["source"] == "embedded":
        ffmpeg_bin = get_ffmpeg_binary()
        if not ffmpeg_bin:
            return None
        proc = subprocess.run(
            [
                ffmpeg_bin,
                "-v",
                "error",
                "-i",
                ticket_data["path"],
                "-map",
                f"0:{track['stream_index']}",
                "-f",
                "webvtt",
                "pipe:1",
            ],
            capture_output=True,
            timeout=30,
            creationflags=_NO_WINDOW_FLAG,
        )
        if proc.returncode != 0:
            return None
        raw_text = proc.stdout.decode("utf-8", errors="replace")
        return convert_srt_or_vtt_to_vtt(raw_text, offset_seconds=offset_seconds)

    return None


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