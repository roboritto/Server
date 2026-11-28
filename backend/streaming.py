from collections import deque
import hashlib
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

from backend.config import (
    FFMPEG_HW_ENCODER,
    FFMPEG_PATH,
    FFPROBE_PATH,
    STREAM_CACHE_DIR,
    STREAM_CACHE_MAX_GB,
    STREAM_MAX_HEIGHT,
    STREAM_TICKET_TTL,
)
from backend.downloads import (
    VALID_VIDEO_EXTS,
    extract_movie_links,
    is_http_url,
    resolve_local_file,
)

LOCAL_STREAM_TICKETS = {}
STREAM_PREPARE_JOBS = {}
_PREPARE_LOCK = threading.Lock()
_ENCODER_LOCK = threading.Lock()
_DETECTED_VIDEO_ENCODER = None
_PRECACHE_LOCK = threading.Lock()
_PRECACHE_QUEUE: deque[dict] = deque()
_PRECACHE_CURRENT: Optional[dict] = None
_PRECACHE_WORKER_RUNNING = False
_PRECACHE_HISTORY: deque[dict] = deque(maxlen=25)
BROWSER_NATIVE_EXTS = {".mp4", ".m4v"}
BROWSER_SAFE_VIDEO_CODECS = {"h264"}
BROWSER_SAFE_AUDIO_CODECS = {"aac", "mp3"}
TEXT_SUBTITLE_CODECS = {
    "subrip",
    "srt",
    "ass",
    "ssa",
    "webvtt",
    "mov_text",
    "tx3g",
    "text",
    "utf8",
    "ttml",
}
IMAGE_SUBTITLE_CODECS = {"hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "xsub"}
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
    "ar": "Arabic",
    "ara": "Arabic",
    "hi": "Hindi",
    "hin": "Hindi",
    "ta": "Tamil",
    "tam": "Tamil",
    "te": "Telugu",
    "tel": "Telugu",
    "zh": "Chinese",
    "chi": "Chinese",
    "zho": "Chinese",
    "ja": "Japanese",
    "jpn": "Japanese",
    "ko": "Korean",
    "kor": "Korean",
    "fr": "French",
    "fre": "French",
    "fra": "French",
    "es": "Spanish",
    "spa": "Spanish",
    "de": "German",
    "ger": "German",
    "deu": "German",
    "th": "Thai",
    "tha": "Thai",
    "vi": "Vietnamese",
    "vie": "Vietnamese",
}
_SUBTITLE_TIMING_RE = re.compile(
    r"((?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3})(.*)"
)
_ENGLISH_LABEL_RE = re.compile(r"\b(?:en|eng|english)\b", re.IGNORECASE)
_FORCED_LABEL_RE = re.compile(r"\b(?:forced|signs)\b", re.IGNORECASE)
_SDH_LABEL_RE = re.compile(r"\b(?:sdh|cc|hearing\s*impaired)\b", re.IGNORECASE)
_NO_WINDOW_FLAG = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def cleanup_expired_stream_tickets():
    now = time.time()
    expired = [k for k, v in LOCAL_STREAM_TICKETS.items() if v["expires_at"] < now]
    for k in expired:
        item = LOCAL_STREAM_TICKETS.pop(k, None)
        if item:
            detach_ticket_from_prepare_jobs(item, ticket=k)


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
    """Uses ffprobe (if installed) to read duration, codecs, audio tracks, and embedded subtitles."""
    info = {
        "duration": 0.0,
        "video_codec": "",
        "video_pix_fmt": "",
        "audio_codec": "",
        "audio_tracks": [],
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
            elif codec_type == "audio":
                if not info["audio_codec"]:
                    info["audio_codec"] = codec_name
                tags = stream.get("tags") or {}
                disposition = stream.get("disposition") or {}
                lang = (tags.get("language") or "").strip()
                title = (tags.get("title") or "").strip()
                channels = int(stream.get("channels") or 0)
                channel_layout = (stream.get("channel_layout") or "").strip()
                lang_label = SUBTITLE_LANG_LABELS.get(lang.lower(), lang.upper() if lang else "")

                if title and lang_label and lang_label.lower() not in title.lower():
                    label = f"{lang_label} — {title}"
                else:
                    label = title or lang_label or f"Audio {len(info['audio_tracks']) + 1}"

                ch_tag = ""
                if "7.1" in channel_layout or channels == 8:
                    ch_tag = "7.1"
                elif "5.1" in channel_layout or channels == 6:
                    ch_tag = "5.1"
                elif channels == 2:
                    ch_tag = "Stereo"
                elif channels == 1:
                    ch_tag = "Mono"

                if ch_tag and ch_tag.lower() not in label.lower():
                    label = f"{label} ({ch_tag})"

                info["audio_tracks"].append(
                    {
                        "stream_index": int(stream.get("index", 0)),
                        "codec": codec_name,
                        "channels": channels,
                        "language": lang[:2].lower() if lang else "",
                        "label": label,
                        "default": bool(disposition.get("default")),
                    }
                )
            elif codec_type == "subtitle" and (
                codec_name in TEXT_SUBTITLE_CODECS or codec_name in IMAGE_SUBTITLE_CODECS
            ):
                tags = stream.get("tags") or {}
                disposition = stream.get("disposition") or {}
                lang = (tags.get("language") or "").strip()
                title = (tags.get("title") or "").strip()
                lang_label = SUBTITLE_LANG_LABELS.get(lang.lower(), lang.upper() if lang else "")

                if title and lang_label and lang_label.lower() not in title.lower():
                    label = f"{lang_label} ({title})"
                else:
                    label = title or lang_label or f"Track {len(info['embedded_subtitles']) + 1}"

                if disposition.get("forced") and "forced" not in label.lower():
                    label = f"{label} (Forced)"
                if disposition.get("hearing_impaired") and "sdh" not in label.lower():
                    label = f"{label} (SDH)"

                is_image = codec_name in IMAGE_SUBTITLE_CODECS
                info["embedded_subtitles"].append(
                    {
                        "source": "embedded_bitmap" if is_image else "embedded",
                        "render_mode": "burn" if is_image else "text",
                        "codec": codec_name,
                        "stream_index": int(stream.get("index", 0)),
                        "label": label,
                        "language": lang[:2].lower() if lang else "",
                        "is_forced": bool(disposition.get("forced")),
                        "is_sdh": bool(disposition.get("hearing_impaired")),
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
                "render_mode": "text",
                "path": resolved,
                "label": label,
                "language": "",
                "is_unlabeled_match": suffix_part.strip("._- ") == "",
            }
        )
    return tracks


def needs_ffmpeg_remux(file_path: Path, probe: dict) -> bool:
    """Determines whether a video needs FFmpeg preparation for universal playback."""
    if not get_ffmpeg_binary():
        return False
    ext = file_path.suffix.lower()
    if ext not in BROWSER_NATIVE_EXTS:
        return True
    vcodec = probe.get("video_codec", "")
    pix_fmt = probe.get("video_pix_fmt", "")
    acodec = probe.get("audio_codec", "")
    if vcodec and vcodec not in BROWSER_SAFE_VIDEO_CODECS:
        return True
    if vcodec == "h264" and pix_fmt and pix_fmt != "yuv420p":
        return True
    if acodec and acodec not in BROWSER_SAFE_AUDIO_CODECS:
        return True
    return False


def _is_english_subtitle(sub: dict) -> bool:
    lang = (sub.get("language") or "").strip().lower()
    if lang in ("en", "eng", "english"):
        return True
    return bool(_ENGLISH_LABEL_RE.search(sub.get("label") or ""))


def _subtitle_sort_key(sub: dict) -> tuple:
    """
    Orders subtitles so English tracks always appear first:
      0: Explicit English text (sidecar before embedded)
      1: Unlabeled sidecar matching exact movie filename (e.g. Movie.srt)
      2: English image/burn-in (PGS/VobSub)
      3: Other text subtitles
      4: Other image/burn-in subtitles
    Within each tier, full regular dialogue ranks ahead of SDH and Forced tracks.
    """
    is_text = sub.get("render_mode", "text") != "burn"
    is_sidecar = sub.get("source") == "file"
    is_eng = _is_english_subtitle(sub)
    is_unlabeled_match = bool(sub.get("is_unlabeled_match"))
    label = sub.get("label") or ""
    is_forced = bool(sub.get("is_forced")) or bool(_FORCED_LABEL_RE.search(label))
    is_sdh = bool(sub.get("is_sdh")) or bool(_SDH_LABEL_RE.search(label))

    if is_eng and is_text:
        tier = 0
    elif is_sidecar and is_unlabeled_match:
        tier = 1
    elif is_eng and not is_text:
        tier = 2
    elif is_text:
        tier = 3
    else:
        tier = 4

    return (tier, int(is_forced), int(is_sdh), 0 if is_sidecar else 1, label.lower())


def _pick_default_subtitle_index(sorted_subtitles: List[dict]) -> int:
    """Returns the index of the highest-priority English (or exact-match sidecar) subtitle, or -1."""
    for idx, sub in enumerate(sorted_subtitles):
        if _is_english_subtitle(sub) or sub.get("is_unlabeled_match"):
            return idx
    return -1


def create_local_stream_ticket(file_path: Path, client_ip: str) -> dict:
    """Issues a reusable, IP-bound streaming ticket with codec probe and subtitle discovery."""
    cleanup_expired_stream_tickets()
    ticket = secrets.token_urlsafe(32)
    probe = probe_local_video(file_path)
    use_ffmpeg = needs_ffmpeg_remux(file_path, probe)
    media_type = "video/mp4" if use_ffmpeg else guess_video_media_type(file_path)

    subtitles = find_sidecar_subtitles(file_path)
    if get_ffmpeg_binary():
        subtitles.extend(probe.get("embedded_subtitles", []))
    subtitles.sort(key=_subtitle_sort_key)
    default_subtitle_index = _pick_default_subtitle_index(subtitles)

    LOCAL_STREAM_TICKETS[ticket] = {
        "expires_at": time.time() + STREAM_TICKET_TTL,
        "client_ip": client_ip,
        "path": str(file_path),
        "filename": file_path.name,
        "media_type": media_type,
        "mode": "prepare" if use_ffmpeg else "direct",
        "duration": probe.get("duration", 0.0),
        "video_codec": probe.get("video_codec", ""),
        "video_pix_fmt": probe.get("video_pix_fmt", ""),
        "audio_codec": probe.get("audio_codec", ""),
        "audio_tracks": probe.get("audio_tracks", []),
        "subtitles": subtitles,
        "subtitle_cache": {},
        "allowed_cache_keys": set(),
        "active_job_ids": set(),
    }

    public_subtitles = [
        {
            "index": idx,
            "label": sub["label"],
            "source": sub["source"],
            "render_mode": sub.get("render_mode", "text"),
            "pgs_canvas": sub.get("codec") == "hdmv_pgs_subtitle",
            "language": sub.get("language", ""),
        }
        for idx, sub in enumerate(subtitles)
    ]

    public_audio_tracks = [
        {"index": idx, "label": track["label"], "codec": track["codec"]}
        for idx, track in enumerate(probe.get("audio_tracks", []))
    ]

    return {
        "ticket": ticket,
        "filename": file_path.name,
        "media_type": media_type,
        "mode": "prepare" if use_ffmpeg else "direct",
        "duration": probe.get("duration", 0.0),
        "ffmpeg_available": bool(get_ffmpeg_binary()),
        "subtitles": public_subtitles,
        "default_subtitle_index": default_subtitle_index,
        "audio_tracks": public_audio_tracks,
    }


def get_local_stream_ticket(ticket: str, client_ip: str) -> Optional[dict]:
    """Validates a reusable streaming ticket without consuming it."""
    cleanup_expired_stream_tickets()
    ticket_data = LOCAL_STREAM_TICKETS.get(ticket)
    if not ticket_data or ticket_data["client_ip"] != client_ip:
        return None
    return ticket_data


def _can_copy_video_for_mobile(ticket_data: dict) -> bool:
    vcodec = ticket_data.get("video_codec", "")
    pix_fmt = ticket_data.get("video_pix_fmt", "")
    return vcodec == "h264" and pix_fmt in ("", "yuv420p")


def get_burn_subtitle_stream_index(ticket_data: dict, track_index: int) -> Optional[int]:
    """Returns the FFmpeg stream index if the requested subtitle track is image-based (PGS/VobSub)."""
    if track_index < 0:
        return None
    subtitles = ticket_data.get("subtitles") or []
    if track_index >= len(subtitles):
        return None
    track = subtitles[track_index]
    if track.get("render_mode") == "burn" and "stream_index" in track:
        return int(track["stream_index"])
    return None


def get_selected_audio_track(ticket_data: dict, audio_track_index: int) -> Optional[dict]:
    """Returns the probed audio stream metadata for the requested audio track index."""
    audio_tracks = ticket_data.get("audio_tracks") or []
    if not audio_tracks:
        return None
    if 0 <= audio_track_index < len(audio_tracks):
        return audio_tracks[audio_track_index]
    return audio_tracks[0]


def _get_stream_cache_dir() -> Path:
    cache_dir = Path(STREAM_CACHE_DIR).resolve()
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir


def _build_stream_cache_key(
    file_path: Path,
    audio_track_index: int,
    burn_sub_stream: Optional[int],
) -> str:
    """Device-independent cache key so every browser/phone shares the exact same cached MP4."""
    stat = file_path.stat()
    raw = f"{file_path.resolve()}|{stat.st_mtime_ns}|{stat.st_size}|a{audio_track_index}|b{burn_sub_stream}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


def _evict_stream_cache_if_needed(keep_key: str = ""):
    cache_dir = _get_stream_cache_dir()
    files = []
    total_size = 0
    now = time.time()

    with _PREPARE_LOCK:
        active_parts = {
            job.get("part_path")
            for job in STREAM_PREPARE_JOBS.values()
            if job["status"] == "preparing"
        }

    for item in cache_dir.glob("*.mp4"):
        if item.name.endswith(".part.mp4"):
            if str(item) not in active_parts:
                try:
                    if now - item.stat().st_mtime > 21600:
                        item.unlink(missing_ok=True)
                except OSError:
                    pass
            continue
        try:
            st = item.stat()
            total_size += st.st_size
            files.append((st.st_mtime, st.st_size, item))
        except OSError:
            continue

    # STREAM_CACHE_MAX_GB <= 0 disables auto-eviction (keep cached movies permanently)
    if STREAM_CACHE_MAX_GB <= 0:
        return

    max_bytes = int(STREAM_CACHE_MAX_GB * (1024 ** 3))
    if total_size <= max_bytes:
        return

    files.sort(key=lambda entry: entry[0])  # Oldest accessed first
    for _, fsize, item in files:
        if total_size <= max_bytes:
            break
        if keep_key and item.stem == keep_key:
            continue
        try:
            item.unlink(missing_ok=True)
            total_size -= fsize
        except OSError:
            continue


def _prune_finished_prepare_jobs():
    """Removes old completed/failed/cancelled job records after 10 minutes."""
    cutoff = time.time() - 600
    with _PREPARE_LOCK:
        stale = [
            jid for jid, job in STREAM_PREPARE_JOBS.items()
            if job["status"] != "preparing" and (job.get("finished_at") or 0) < cutoff
        ]
        for jid in stale:
            STREAM_PREPARE_JOBS.pop(jid, None)


def _terminate_process(proc: Optional[subprocess.Popen]):
    if not proc or proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        proc.kill()


_HW_ENCODER_CANDIDATES = [
    (
        "nvenc",
        "GPU: NVENC",
        ["-c:v", "h264_nvenc", "-preset", "p1", "-rc", "vbr", "-cq", "24", "-b:v", "0", "-profile:v", "main", "-pix_fmt", "yuv420p"],
    ),
    (
        "qsv",
        "GPU: QuickSync",
        ["-c:v", "h264_qsv", "-preset", "veryfast", "-global_quality", "24", "-pix_fmt", "nv12"],
    ),
    (
        "amf",
        "GPU: AMF",
        ["-c:v", "h264_amf", "-quality", "speed", "-rc", "cqp", "-qp_i", "24", "-qp_p", "24", "-pix_fmt", "yuv420p"],
    ),
    (
        "mf",
        "GPU: MediaFoundation",
        ["-c:v", "h264_mf", "-rate_control", "quality", "-quality", "75", "-pix_fmt", "nv12"],
    ),
    (
        "mf",
        "GPU: MediaFoundation",
        ["-c:v", "h264_mf", "-b:v", "5M", "-pix_fmt", "nv12"],
    ),
]
_CPU_ENCODER_SPEC = (
    "cpu",
    "CPU",
    ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "24", "-threads", "0", "-profile:v", "main", "-level", "4.1", "-pix_fmt", "yuv420p"],
)


def _probe_video_encoder(ffmpeg_bin: str, encoder_args: List[str]) -> bool:
    """Tests whether an FFmpeg video encoder actually initializes on this machine's GPU/driver."""
    try:
        proc = subprocess.run(
            [
                ffmpeg_bin,
                "-v", "error",
                "-f", "lavfi",
                "-i", "color=c=black:s=256x256:d=0.1:r=24",
                *encoder_args,
                "-f", "null",
                "-",
            ],
            capture_output=True,
            timeout=6,
            creationflags=_NO_WINDOW_FLAG,
        )
        return proc.returncode == 0
    except Exception:
        return False


def get_best_h264_encoder(ffmpeg_bin: str) -> tuple[str, str, List[str]]:
    """Detects and caches the fastest working H.264 encoder (NVENC -> QSV -> AMF -> MF -> CPU)."""
    global _DETECTED_VIDEO_ENCODER
    with _ENCODER_LOCK:
        if _DETECTED_VIDEO_ENCODER is not None:
            return _DETECTED_VIDEO_ENCODER

        pref = FFMPEG_HW_ENCODER
        if pref == "cpu":
            _DETECTED_VIDEO_ENCODER = _CPU_ENCODER_SPEC
            print("[Stream] Video encoder configured: CPU (libx264 ultrafast)")
            return _DETECTED_VIDEO_ENCODER

        candidates = (
            [c for c in _HW_ENCODER_CANDIDATES if c[0] == pref]
            if pref != "auto"
            else list(_HW_ENCODER_CANDIDATES)
        )

        for key, label, args in candidates:
            if _probe_video_encoder(ffmpeg_bin, args):
                _DETECTED_VIDEO_ENCODER = (key, label, args)
                print(f"[Stream] Selected hardware video encoder: {label}")
                return _DETECTED_VIDEO_ENCODER

        _DETECTED_VIDEO_ENCODER = _CPU_ENCODER_SPEC
        print("[Stream] No hardware video encoder detected; using CPU (libx264 ultrafast)")
        return _DETECTED_VIDEO_ENCODER


def _build_prepare_ffmpeg_cmd(
    ffmpeg_bin: str,
    file_path: Path,
    part_path: Path,
    audio_map: str,
    audio_codec: str,
    audio_channels: int,
    burn_stream: Optional[int],
    video_args: List[str],
    is_copy_video: bool,
) -> List[str]:
    cmd = [ffmpeg_bin, "-y", "-v", "error", "-fflags", "+genpts", "-i", str(file_path)]
    max_h = STREAM_MAX_HEIGHT if STREAM_MAX_HEIGHT > 0 else 0

    if burn_stream is not None:
        if max_h > 0:
            fg = (
                f"[0:v:0]scale=-2:'trunc(min({max_h},ih)/2)*2'[vid];"
                f"[0:{burn_stream}][vid]scale2ref[sub][vid2];"
                f"[vid2][sub]overlay=eof_action=pass[v]"
            )
        else:
            fg = f"[0:{burn_stream}][0:v:0]scale2ref[sub][vid];[vid][sub]overlay=eof_action=pass[v]"
        cmd.extend(["-filter_complex", fg, "-map", "[v]", "-map", audio_map, *video_args])
    else:
        cmd.extend(["-map", "0:v:0", "-map", audio_map])
        if not is_copy_video and max_h > 0:
            cmd.extend(["-vf", f"scale=-2:'trunc(min({max_h},ih)/2)*2'"])
        cmd.extend(video_args)

    if audio_codec == "aac" and audio_channels <= 2:
        cmd.extend(["-c:a", "copy"])
    else:
        cmd.extend(["-c:a", "aac", "-ac", "2", "-ar", "48000", "-b:a", "192k"])

    cmd.extend([
        "-max_muxing_queue_size", "1024",
        "-movflags", "+faststart",
        "-f", "mp4",
        "-progress", "pipe:1",
        "-nostats",
        str(part_path),
    ])
    return cmd


def _execute_prepare_cmd(
    job_id: str, cmd: List[str], part_path: Path, duration: float
) -> tuple[int, str, bool]:
    """Runs a single FFmpeg command, updating job progress. Returns (returncode, err_msg, cancelled)."""
    stderr_tail: deque[str] = deque(maxlen=25)
    proc = None
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            creationflags=_NO_WINDOW_FLAG,
        )
        with _PREPARE_LOCK:
            job = STREAM_PREPARE_JOBS.get(job_id)
            if not job or job["status"] == "cancelled":
                _terminate_process(proc)
                part_path.unlink(missing_ok=True)
                return (-1, "", True)
            job["process"] = proc

        def _drain_stderr():
            assert proc.stderr is not None
            for err_line in proc.stderr:
                clean = err_line.strip()
                if clean:
                    stderr_tail.append(clean)

        err_thread = threading.Thread(target=_drain_stderr, daemon=True)
        err_thread.start()

        assert proc.stdout is not None
        for line in proc.stdout:
            line = line.strip()
            if not line or "=" not in line:
                continue
            key, val = line.split("=", 1)
            if key in ("out_time_us", "out_time_ms") and duration > 0:
                try:
                    encoded_sec = int(val) / 1_000_000.0
                    pct = max(0.0, min(99.0, (encoded_sec / duration) * 100.0))
                    with _PREPARE_LOCK:
                        job = STREAM_PREPARE_JOBS.get(job_id)
                        if job and job["status"] == "preparing":
                            job["progress"] = round(pct, 1)
                except ValueError:
                    pass

        proc.wait()
        err_thread.join(timeout=2)

        with _PREPARE_LOCK:
            job = STREAM_PREPARE_JOBS.get(job_id)
            if not job or job["status"] == "cancelled":
                part_path.unlink(missing_ok=True)
                return (-1, "", True)
            job["process"] = None

        err_msg = " | ".join(list(stderr_tail)[-4:]) or f"FFmpeg exited with code {proc.returncode}"
        return (proc.returncode, err_msg, False)
    finally:
        if proc and proc.stdout:
            proc.stdout.close()
        if proc and proc.stderr:
            proc.stderr.close()


def _run_prepare_mp4_worker(
    job_id: str,
    primary_cmd: List[str],
    fallback_cmd: Optional[List[str]],
    part_path: Path,
    final_path: Path,
    duration: float,
    cache_key: str,
):
    try:
        rc, err_msg, cancelled = _execute_prepare_cmd(job_id, primary_cmd, part_path, duration)
        if cancelled:
            return

        if (rc != 0 or not part_path.is_file() or part_path.stat().st_size == 0) and fallback_cmd:
            part_path.unlink(missing_ok=True)
            print(f"[Stream Prepare] GPU encoder failed ({err_msg}); falling back to CPU...")
            with _PREPARE_LOCK:
                job = STREAM_PREPARE_JOBS.get(job_id)
                if not job or job["status"] == "cancelled":
                    return
                job["progress"] = 0.0
                job["mode_label"] = "Converting once for all devices (CPU)..."
            rc, err_msg, cancelled = _execute_prepare_cmd(job_id, fallback_cmd, part_path, duration)
            if cancelled:
                return

        if rc == 0 and part_path.is_file() and part_path.stat().st_size > 0:
            os.replace(part_path, final_path)
            _evict_stream_cache_if_needed(keep_key=cache_key)
            with _PREPARE_LOCK:
                job = STREAM_PREPARE_JOBS.get(job_id)
                if job and job["status"] != "cancelled":
                    job["status"] = "ready"
                    job["progress"] = 100.0
                    job["process"] = None
                    job["finished_at"] = time.time()
        else:
            part_path.unlink(missing_ok=True)
            print(f"[Stream Prepare Error] {err_msg}")
            with _PREPARE_LOCK:
                job = STREAM_PREPARE_JOBS.get(job_id)
                if job and job["status"] != "cancelled":
                    job["status"] = "error"
                    job["error"] = f"FFmpeg failed to prepare video: {err_msg}"
                    job["process"] = None
                    job["finished_at"] = time.time()
    except Exception as exc:
        part_path.unlink(missing_ok=True)
        print(f"[Stream Prepare Exception] {exc}")
        with _PREPARE_LOCK:
            job = STREAM_PREPARE_JOBS.get(job_id)
            if job and job["status"] != "cancelled":
                job["status"] = "error"
                job["error"] = str(exc)
                job["process"] = None
                job["finished_at"] = time.time()


def start_prepare_mp4_job(
    ticket: str,
    ticket_data: dict,
    audio_track_index: int = 0,
    burn_sub_track: int = -1,
) -> dict:
    """
    Returns a direct or server-cached universal H.264/AAC MP4 immediately if ready,
    attaches to an already-running background conversion if one exists, or starts a new
    one that stays running in the background even if the modal is closed.
    """
    _prune_finished_prepare_jobs()
    safe_audio = max(0, audio_track_index)
    burn_stream = get_burn_subtitle_stream_index(ticket_data, burn_sub_track)

    if ticket_data.get("mode") == "direct" and safe_audio == 0 and burn_stream is None:
        return {
            "status": "ready",
            "progress": 100.0,
            "stream_url": f"/api/local-files/stream?ticket={ticket}",
        }

    ffmpeg_bin = get_ffmpeg_binary()
    if not ffmpeg_bin:
        return {
            "status": "error",
            "error": "FFmpeg is required for MKV/HEVC playback or track switching (add ffmpeg to PATH or set FFMPEG_PATH in .env).",
        }

    file_path = Path(ticket_data["path"])
    if not file_path.is_file():
        return {"status": "error", "error": "Source video file no longer exists on server."}

    cache_key = _build_stream_cache_key(file_path, safe_audio, burn_stream)
    cache_dir = _get_stream_cache_dir()
    final_path = cache_dir / f"{cache_key}.mp4"

    ticket_data.setdefault("allowed_cache_keys", set()).add(cache_key)

    # Instant hit for ALL devices once cached on the server
    if final_path.is_file() and final_path.stat().st_size > 0:
        try:
            final_path.touch()
        except OSError:
            pass
        return {
            "status": "ready",
            "progress": 100.0,
            "stream_url": f"/api/local-files/stream?ticket={ticket}&cache_key={cache_key}",
        }

    with _PREPARE_LOCK:
        # Join an already-running conversion started earlier or by another device
        for existing_id, job in STREAM_PREPARE_JOBS.items():
            if job["cache_key"] == cache_key and job["status"] == "preparing":
                ticket_data.setdefault("active_job_ids", set()).add(existing_id)
                job["tickets"].add(ticket)
                return {
                    "status": "preparing",
                    "job_id": existing_id,
                    "progress": job["progress"],
                    "mode_label": job["mode_label"],
                }

        job_id = secrets.token_urlsafe(10)
        part_path = cache_dir / f"{cache_key}_{job_id}.part.mp4"

        selected_audio = get_selected_audio_track(ticket_data, safe_audio)
        audio_map = f"0:{selected_audio['stream_index']}" if selected_audio else "0:a:0?"
        audio_codec = selected_audio["codec"] if selected_audio else ticket_data.get("audio_codec", "")
        audio_channels = int(selected_audio.get("channels", 2)) if selected_audio else 2

        can_copy_h264 = _can_copy_video_for_mobile(ticket_data) and burn_stream is None
        fallback_cmd: Optional[List[str]] = None

        if can_copy_h264:
            mode_label = "Caching video for all devices (fast copy)..."
            primary_video_args = ["-c:v", "copy"]
        else:
            enc_key, enc_label, primary_video_args = get_best_h264_encoder(ffmpeg_bin)
            mode_label = (
                f"Caching video with subtitles ({enc_label})..."
                if burn_stream is not None
                else f"Caching video once for all devices ({enc_label})..."
            )
            if enc_key != "cpu":
                fallback_cmd = _build_prepare_ffmpeg_cmd(
                    ffmpeg_bin,
                    file_path,
                    part_path,
                    audio_map,
                    audio_codec,
                    audio_channels,
                    burn_stream,
                    _CPU_ENCODER_SPEC[2],
                    is_copy_video=False,
                )

        primary_cmd = _build_prepare_ffmpeg_cmd(
            ffmpeg_bin,
            file_path,
            part_path,
            audio_map,
            audio_codec,
            audio_channels,
            burn_stream,
            primary_video_args,
            is_copy_video=can_copy_h264,
        )

        STREAM_PREPARE_JOBS[job_id] = {
            "cache_key": cache_key,
            "status": "preparing",
            "progress": 0.0,
            "mode_label": mode_label,
            "error": "",
            "process": None,
            "part_path": str(part_path),
            "tickets": {ticket},
            "finished_at": 0.0,
        }
        ticket_data.setdefault("active_job_ids", set()).add(job_id)

    worker = threading.Thread(
        target=_run_prepare_mp4_worker,
        args=(
            job_id,
            primary_cmd,
            fallback_cmd,
            part_path,
            final_path,
            float(ticket_data.get("duration") or 0.0),
            cache_key,
        ),
        daemon=True,
    )
    worker.start()

    return {
        "status": "preparing",
        "job_id": job_id,
        "progress": 0.0,
        "mode_label": mode_label,
    }


def get_prepare_job_status(ticket: str, ticket_data: dict, job_id: str) -> Optional[dict]:
    """Returns current progress or final stream_url for a background prepare job."""
    with _PREPARE_LOCK:
        job = STREAM_PREPARE_JOBS.get(job_id)
        if not job or ticket not in job["tickets"]:
            return None
        status = job["status"]
        progress = job["progress"]
        cache_key = job["cache_key"]
        err = job["error"]
        mode_label = job["mode_label"]

    if status == "ready":
        ticket_data.setdefault("allowed_cache_keys", set()).add(cache_key)
        return {
            "status": "ready",
            "progress": 100.0,
            "stream_url": f"/api/local-files/stream?ticket={ticket}&cache_key={cache_key}",
        }
    if status == "error":
        return {"status": "error", "error": err or "Could not prepare video."}
    if status == "cancelled":
        return {"status": "cancelled"}
    return {
        "status": "preparing",
        "progress": progress,
        "mode_label": mode_label,
    }


def detach_ticket_from_prepare_jobs(ticket_data: dict, ticket: str = ""):
    """Detaches a closed player ticket while letting FFmpeg finish caching in the background."""
    job_ids = list(ticket_data.get("active_job_ids") or [])
    ticket_data["active_job_ids"] = set()
    if not job_ids or not ticket:
        return

    with _PREPARE_LOCK:
        for job_id in job_ids:
            job = STREAM_PREPARE_JOBS.get(job_id)
            if job:
                job["tickets"].discard(ticket)


def cancel_prepare_job(ticket: str, ticket_data: dict, job_id: str) -> bool:
    """Explicitly terminates an in-progress FFmpeg conversion and deletes its partial file."""
    with _PREPARE_LOCK:
        job = STREAM_PREPARE_JOBS.get(job_id)
        if not job or ticket not in job["tickets"]:
            return False
        if job["status"] == "preparing":
            job["status"] = "cancelled"
            job["finished_at"] = time.time()
            _terminate_process(job.get("process"))
            job["process"] = None
            part_path = job.get("part_path")
            if part_path:
                Path(part_path).unlink(missing_ok=True)
        job["tickets"].discard(ticket)
    ticket_data.get("active_job_ids", set()).discard(job_id)
    return True


def get_cached_mp4_path(ticket_data: dict, cache_key: str) -> Optional[Path]:
    """Validates and returns a prepared cached MP4 authorized for this stream ticket."""
    if not cache_key or not re.fullmatch(r"[0-9a-f]{24}", cache_key):
        return None
    if cache_key not in (ticket_data.get("allowed_cache_keys") or set()):
        return None
    candidate = _get_stream_cache_dir() / f"{cache_key}.mp4"
    return candidate if candidate.is_file() else None


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
        stream_idx = track["stream_index"]
        cache = ticket_data.setdefault("subtitle_cache", {})
        raw_text = cache.get(stream_idx)

        if raw_text is None:
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
                    f"0:{stream_idx}",
                    "-c:s",
                    "webvtt",
                    "-f",
                    "webvtt",
                    "pipe:1",
                ],
                capture_output=True,
                timeout=120,
                creationflags=_NO_WINDOW_FLAG,
            )
            if proc.returncode != 0:
                return None
            raw_text = proc.stdout.decode("utf-8", errors="replace")
            cache[stream_idx] = raw_text

        return convert_srt_or_vtt_to_vtt(raw_text, offset_seconds=offset_seconds)

    return None


def _get_pgs_sup_cache_path(file_path: Path, stream_idx: int) -> Path:
    stat = file_path.stat()
    raw_key = f"{file_path.resolve()}|{stat.st_mtime_ns}|{stat.st_size}|pgs:{stream_idx}"
    cache_key = hashlib.sha256(raw_key.encode("utf-8")).hexdigest()[:24]
    subs_dir = _get_stream_cache_dir() / "subs"
    subs_dir.mkdir(parents=True, exist_ok=True)
    return subs_dir / f"{cache_key}.sup"


def extract_pgs_track_sup(ticket_data: dict, track_index: int) -> Optional[Path]:
    """
    Extracts an embedded Blu-ray PGS (hdmv_pgs_subtitle) stream to a cached .sup file
    in .stream_cache/subs/ without re-encoding any video.
    """
    subtitles = ticket_data.get("subtitles") or []
    if track_index < 0 or track_index >= len(subtitles):
        return None

    track = subtitles[track_index]
    if track.get("codec") != "hdmv_pgs_subtitle" or "stream_index" not in track:
        return None

    file_path = Path(ticket_data["path"])
    if not file_path.is_file():
        return None

    stream_idx = int(track["stream_index"])
    final_path = _get_pgs_sup_cache_path(file_path, stream_idx)
    if final_path.is_file() and final_path.stat().st_size > 0:
        return final_path

    ffmpeg_bin = get_ffmpeg_binary()
    if not ffmpeg_bin:
        return None

    part_path = final_path.with_name(f"{final_path.stem}_{secrets.token_hex(4)}.part.sup")
    try:
        proc = subprocess.run(
            [
                ffmpeg_bin,
                "-y",
                "-v",
                "error",
                "-i",
                str(file_path),
                "-map",
                f"0:{stream_idx}",
                "-c:s",
                "copy",
                "-f",
                "sup",
                str(part_path),
            ],
            capture_output=True,
            timeout=120,
            creationflags=_NO_WINDOW_FLAG,
        )
        if proc.returncode == 0 and part_path.is_file() and part_path.stat().st_size > 0:
            os.replace(part_path, final_path)
            return final_path
        err = proc.stderr.decode("utf-8", errors="replace").strip()
        if err:
            print(f"[PGS Extract Error] {err}")
    except Exception as exc:
        print(f"[PGS Extract Exception] {exc}")
    finally:
        part_path.unlink(missing_ok=True)

    return None


def extract_pgs_track_sup(ticket_data: dict, track_index: int) -> Optional[Path]:
    """
    Extracts an embedded Blu-ray PGS (hdmv_pgs_subtitle) stream to a cached .sup file
    in .stream_cache/subs/ without re-encoding any video.
    """
    subtitles = ticket_data.get("subtitles") or []
    if track_index < 0 or track_index >= len(subtitles):
        return None

    track = subtitles[track_index]
    if track.get("codec") != "hdmv_pgs_subtitle" or "stream_index" not in track:
        return None

    file_path = Path(ticket_data["path"])
    if not file_path.is_file():
        return None

    stream_idx = int(track["stream_index"])
    stat = file_path.stat()
    raw_key = f"{file_path.resolve()}|{stat.st_mtime_ns}|{stat.st_size}|pgs:{stream_idx}"
    cache_key = hashlib.sha256(raw_key.encode("utf-8")).hexdigest()[:24]

    subs_cache_dir = _get_stream_cache_dir() / "subs"
    subs_cache_dir.mkdir(parents=True, exist_ok=True)
    final_path = subs_cache_dir / f"{cache_key}.sup"

    if final_path.is_file() and final_path.stat().st_size > 0:
        return final_path

    ffmpeg_bin = get_ffmpeg_binary()
    if not ffmpeg_bin:
        return None

    part_path = subs_cache_dir / f"{cache_key}_{secrets.token_hex(4)}.part.sup"
    try:
        proc = subprocess.run(
            [
                ffmpeg_bin,
                "-y",
                "-v",
                "error",
                "-i",
                str(file_path),
                "-map",
                f"0:{stream_idx}",
                "-c:s",
                "copy",
                "-f",
                "sup",
                str(part_path),
            ],
            capture_output=True,
            timeout=120,
            creationflags=_NO_WINDOW_FLAG,
        )
        if proc.returncode == 0 and part_path.is_file() and part_path.stat().st_size > 0:
            os.replace(part_path, final_path)
            return final_path
        err = proc.stderr.decode("utf-8", errors="replace").strip()
        if err:
            print(f"[PGS Extract Error] {err}")
    except Exception as exc:
        print(f"[PGS Extract Exception] {exc}")
    finally:
        part_path.unlink(missing_ok=True)

    return None


def _collect_uncached_targets_for_row(
    movie_row: dict,
    title: str = "",
    include_mobile_burn: bool = True,
) -> dict:
    """
    Inspects all local video files linked to a movie row and returns cache summary +
    any uncached preparation targets (skipping direct-play MP4s and existing cache hits).
    """
    movie_id = str(movie_row.get("movie_id", "")).strip()
    display_title = (title or "").strip() or f"Movie #{movie_id}"
    entries = extract_movie_links(movie_row.get("link", ""))
    local_entries = [e for e in entries if not is_http_url(e)]

    ffmpeg_available = bool(get_ffmpeg_binary())
    cache_dir = _get_stream_cache_dir()

    summary = {
        "movie_id": movie_id,
        "local_files": 0,
        "cached_or_direct": 0,
        "uncached_targets": [],
    }

    for rel_path in local_entries:
        file_path = resolve_local_file(rel_path)
        if not file_path:
            continue

        summary["local_files"] += 1
        probe = probe_local_video(file_path)
        use_ffmpeg = needs_ffmpeg_remux(file_path, probe)

        subtitles = find_sidecar_subtitles(file_path)
        if ffmpeg_available:
            subtitles.extend(probe.get("embedded_subtitles", []))
        subtitles.sort(key=_subtitle_sort_key)
        default_idx = _pick_default_subtitle_index(subtitles)
        default_sub = subtitles[default_idx] if default_idx >= 0 else None

        pgs_stream_indices = [
            int(sub["stream_index"])
            for sub in subtitles
            if sub.get("codec") == "hdmv_pgs_subtitle" and "stream_index" in sub
        ]

        # Build the target variant(s) for this file
        variants: List[tuple[Optional[int], str]] = []
        if use_ffmpeg:
            variants.append((None, "Universal MP4"))

        # Queue English burn-in if it's non-PGS (e.g. VobSub) OR user opted in for iOS/Android PGS
        if (
            ffmpeg_available
            and default_sub
            and default_sub.get("render_mode") == "burn"
            and "stream_index" in default_sub
        ):
            is_pgs = default_sub.get("codec") == "hdmv_pgs_subtitle"
            if include_mobile_burn or not is_pgs:
                variants.append(
                    (int(default_sub["stream_index"]), f"English Burn-in ({default_sub['label']})")
                )

        if not variants:
            summary["cached_or_direct"] += 1
            continue

        file_has_missing = False
        for burn_stream, variant_label in variants:
            cache_key = _build_stream_cache_key(file_path, 0, burn_stream)
            final_path = cache_dir / f"{cache_key}.mp4"
            if final_path.is_file() and final_path.stat().st_size > 0:
                continue

            file_has_missing = True
            summary["uncached_targets"].append(
                {
                    "cache_key": cache_key,
                    "movie_id": movie_id,
                    "title": display_title,
                    "path": str(file_path),
                    "filename": file_path.name,
                    "variant": variant_label,
                    "burn_stream": burn_stream,
                    "pgs_stream_indices": pgs_stream_indices,
                    "duration": float(probe.get("duration") or 0.0),
                    "video_codec": probe.get("video_codec", ""),
                    "video_pix_fmt": probe.get("video_pix_fmt", ""),
                    "audio_codec": probe.get("audio_codec", ""),
                    "audio_tracks": probe.get("audio_tracks", []),
                }
            )

        if not file_has_missing:
            summary["cached_or_direct"] += 1

    return summary


def _extract_single_pgs_sup(ffmpeg_bin: str, file_path: Path, stream_idx: int, final_path: Path):
    part_path = final_path.with_name(f"{final_path.stem}_{secrets.token_hex(4)}.part.sup")
    try:
        proc = subprocess.run(
            [
                ffmpeg_bin, "-y", "-v", "error",
                "-i", str(file_path),
                "-map", f"0:{stream_idx}",
                "-c:s", "copy", "-f", "sup",
                str(part_path),
            ],
            capture_output=True,
            timeout=120,
            creationflags=_NO_WINDOW_FLAG,
        )
        if proc.returncode == 0 and part_path.is_file() and part_path.stat().st_size > 0:
            os.replace(part_path, final_path)
    except Exception:
        pass
    finally:
        part_path.unlink(missing_ok=True)


def _extract_all_pgs_sup_tracks(file_path: Path, stream_indices: List[int]):
    """
    Pre-extracts all uncached embedded PGS (.sup) subtitle tracks in a single FFmpeg pass,
    with a per-track fallback if any individual stream fails.
    """
    ffmpeg_bin = get_ffmpeg_binary()
    if not ffmpeg_bin or not file_path.is_file() or not stream_indices:
        return

    unique_indices = list(dict.fromkeys(int(idx) for idx in stream_indices))
    pending: List[tuple[int, Path, Path]] = []

    for stream_idx in unique_indices:
        try:
            final_path = _get_pgs_sup_cache_path(file_path, stream_idx)
            if final_path.is_file() and final_path.stat().st_size > 0:
                continue
            part_path = final_path.with_name(f"{final_path.stem}_{secrets.token_hex(4)}.part.sup")
            pending.append((stream_idx, part_path, final_path))
        except OSError:
            continue

    if not pending:
        return

    cmd = [ffmpeg_bin, "-y", "-v", "error", "-i", str(file_path)]
    for stream_idx, part_path, _ in pending:
        cmd.extend(["-map", f"0:{stream_idx}", "-c:s", "copy", "-f", "sup", str(part_path)])

    batch_ok = False
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            timeout=300,
            creationflags=_NO_WINDOW_FLAG,
        )
        if proc.returncode == 0:
            batch_ok = True
            for _, part_path, final_path in pending:
                if part_path.is_file() and part_path.stat().st_size > 0:
                    os.replace(part_path, final_path)
    except Exception:
        pass
    finally:
        for _, part_path, _ in pending:
            part_path.unlink(missing_ok=True)

    # If the batch command failed (e.g. one corrupted subtitle stream), salvage the rest individually
    if not batch_ok and len(pending) > 1:
        for stream_idx, _, final_path in pending:
            if not (final_path.is_file() and final_path.stat().st_size > 0):
                _extract_single_pgs_sup(ffmpeg_bin, file_path, stream_idx, final_path)


def _run_precache_queue_worker():
    """Sequentially encodes queued uncached movies one at a time, sharing STREAM_PREPARE_JOBS."""
    global _PRECACHE_CURRENT, _PRECACHE_WORKER_RUNNING

    try:
        while True:
            with _PRECACHE_LOCK:
                if not _PRECACHE_QUEUE:
                    _PRECACHE_CURRENT = None
                    _PRECACHE_WORKER_RUNNING = False
                    return
                item = _PRECACHE_QUEUE.popleft()
                _PRECACHE_CURRENT = {
                    "movie_id": item["movie_id"],
                    "title": item["title"],
                    "filename": item["filename"],
                    "variant": item["variant"],
                    "cache_key": item["cache_key"],
                    "job_id": "",
                    "mode_label": "Starting...",
                    "progress": 0.0,
                }

            file_path = Path(item["path"])
            cache_dir = _get_stream_cache_dir()
            cache_key = item["cache_key"]
            final_path = cache_dir / f"{cache_key}.mp4"

            # Skip immediately if another device already finished caching it
            if final_path.is_file() and final_path.stat().st_size > 0:
                with _PRECACHE_LOCK:
                    _PRECACHE_HISTORY.appendleft(
                        {
                            "movie_id": item["movie_id"],
                            "title": item["title"],
                            "variant": item["variant"],
                            "status": "cached",
                        }
                    )
                continue

            ffmpeg_bin = get_ffmpeg_binary()
            if not ffmpeg_bin or not file_path.is_file():
                with _PRECACHE_LOCK:
                    _PRECACHE_HISTORY.appendleft(
                        {
                            "movie_id": item["movie_id"],
                            "title": item["title"],
                            "variant": item["variant"],
                            "status": "error",
                            "error": "Missing file or FFmpeg binary.",
                        }
                    )
                continue

            # Pre-extract all embedded PGS .sup tracks in a single pass (skips existing)
            pgs_indices = item.get("pgs_stream_indices") or []
            if pgs_indices:
                with _PRECACHE_LOCK:
                    if _PRECACHE_CURRENT:
                        _PRECACHE_CURRENT["mode_label"] = (
                            f"Extracting {len(pgs_indices)} PGS subtitle track(s)..."
                        )
                _extract_all_pgs_sup_tracks(file_path, pgs_indices)
            
            # If a live player is already preparing this exact cache_key, wait for it instead of duplicating
            existing_job_id = ""
            with _PREPARE_LOCK:
                for jid, job in STREAM_PREPARE_JOBS.items():
                    if job["cache_key"] == cache_key and job["status"] == "preparing":
                        existing_job_id = jid
                        break

            if existing_job_id:
                with _PRECACHE_LOCK:
                    if _PRECACHE_CURRENT:
                        _PRECACHE_CURRENT["job_id"] = existing_job_id
                while True:
                    with _PREPARE_LOCK:
                        job = STREAM_PREPARE_JOBS.get(existing_job_id)
                        status = job["status"] if job else "ready"
                    if status != "preparing":
                        break
                    time.sleep(0.5)
                with _PRECACHE_LOCK:
                    _PRECACHE_HISTORY.appendleft(
                        {
                            "movie_id": item["movie_id"],
                            "title": item["title"],
                            "variant": item["variant"],
                            "status": "cached" if status == "ready" else status,
                        }
                    )
                continue

            # Pre-extract default English PGS .sup file if applicable (fast 1-2s copy)
            job_id = secrets.token_urlsafe(10)
            part_path = cache_dir / f"{cache_key}_{job_id}.part.mp4"
            burn_stream = item.get("burn_stream")

            selected_audio = get_selected_audio_track(item, 0)
            audio_map = f"0:{selected_audio['stream_index']}" if selected_audio else "0:a:0?"
            audio_codec = selected_audio["codec"] if selected_audio else item.get("audio_codec", "")
            audio_channels = int(selected_audio.get("channels", 2)) if selected_audio else 2

            can_copy_h264 = _can_copy_video_for_mobile(item) and burn_stream is None
            fallback_cmd: Optional[List[str]] = None

            if can_copy_h264:
                mode_label = "Pre-caching (fast copy)..."
                primary_video_args = ["-c:v", "copy"]
            else:
                enc_key, enc_label, primary_video_args = get_best_h264_encoder(ffmpeg_bin)
                mode_label = (
                    f"Pre-caching with subtitles ({enc_label})..."
                    if burn_stream is not None
                    else f"Pre-caching ({enc_label})..."
                )
                if enc_key != "cpu":
                    fallback_cmd = _build_prepare_ffmpeg_cmd(
                        ffmpeg_bin,
                        file_path,
                        part_path,
                        audio_map,
                        audio_codec,
                        audio_channels,
                        burn_stream,
                        _CPU_ENCODER_SPEC[2],
                        is_copy_video=False,
                    )

            primary_cmd = _build_prepare_ffmpeg_cmd(
                ffmpeg_bin,
                file_path,
                part_path,
                audio_map,
                audio_codec,
                audio_channels,
                burn_stream,
                primary_video_args,
                is_copy_video=can_copy_h264,
            )

            with _PREPARE_LOCK:
                STREAM_PREPARE_JOBS[job_id] = {
                    "cache_key": cache_key,
                    "status": "preparing",
                    "progress": 0.0,
                    "mode_label": mode_label,
                    "error": "",
                    "process": None,
                    "part_path": str(part_path),
                    "tickets": set(),
                    "finished_at": 0.0,
                }

            with _PRECACHE_LOCK:
                if _PRECACHE_CURRENT:
                    _PRECACHE_CURRENT["job_id"] = job_id
                    _PRECACHE_CURRENT["mode_label"] = mode_label

            # Runs synchronously inside this single background queue thread
            _run_prepare_mp4_worker(
                job_id,
                primary_cmd,
                fallback_cmd,
                part_path,
                final_path,
                float(item.get("duration") or 0.0),
                cache_key,
            )

            with _PREPARE_LOCK:
                finished_job = STREAM_PREPARE_JOBS.get(job_id) or {}
                final_status = finished_job.get("status", "error")
                final_err = finished_job.get("error", "")

            with _PRECACHE_LOCK:
                _PRECACHE_HISTORY.appendleft(
                    {
                        "movie_id": item["movie_id"],
                        "title": item["title"],
                        "variant": item["variant"],
                        "status": "cached" if final_status == "ready" else final_status,
                        "error": final_err if final_status == "error" else "",
                    }
                )
    except Exception as exc:
        print(f"[Pre-Cache Worker Error] {exc}")
        with _PRECACHE_LOCK:
            _PRECACHE_CURRENT = None
            _PRECACHE_WORKER_RUNNING = False


def queue_movies_for_precache(
    movie_rows: List[dict],
    titles: Optional[dict] = None,
    include_mobile_burn: bool = True,
) -> dict:
    """Scans the given movie rows and enqueues every uncached local video file."""
    global _PRECACHE_WORKER_RUNNING

    if not get_ffmpeg_binary():
        return {
            "status": "error",
            "error": "FFmpeg is not available on the server (add ffmpeg to PATH or set FFMPEG_PATH in .env).",
        }

    titles_map = titles or {}
    queued_count = 0
    already_cached_count = 0
    already_queued_count = 0

    with _PREPARE_LOCK:
        active_prepare_keys = {
            job["cache_key"]
            for job in STREAM_PREPARE_JOBS.values()
            if job["status"] == "preparing"
        }

    with _PRECACHE_LOCK:
        known_queue_keys = {item["cache_key"] for item in _PRECACHE_QUEUE}
        if _PRECACHE_CURRENT:
            known_queue_keys.add(_PRECACHE_CURRENT["cache_key"])

    new_items: List[dict] = []
    for row in movie_rows:
        m_id = str(row.get("movie_id", "")).strip()
        summary = _collect_uncached_targets_for_row(
            row,
            title=titles_map.get(m_id, ""),
            include_mobile_burn=include_mobile_burn,
        )
        already_cached_count += summary["cached_or_direct"]

        for target in summary["uncached_targets"]:
            ck = target["cache_key"]
            if ck in known_queue_keys or ck in active_prepare_keys:
                already_queued_count += 1
                continue
            known_queue_keys.add(ck)
            new_items.append(target)
            queued_count += 1

    should_start_worker = False
    with _PRECACHE_LOCK:
        for item in new_items:
            _PRECACHE_QUEUE.append(item)
        if not _PRECACHE_WORKER_RUNNING and _PRECACHE_QUEUE:
            _PRECACHE_WORKER_RUNNING = True
            should_start_worker = True

    if should_start_worker:
        threading.Thread(target=_run_precache_queue_worker, daemon=True).start()

    return {
        "status": "ok",
        "queued_count": queued_count,
        "already_cached_count": already_cached_count,
        "already_queued_count": already_queued_count,
        "queue_status": get_precache_queue_status(),
    }


def get_movie_precache_status(movie_row: dict, include_mobile_burn: bool = True) -> dict:
    """Returns whether a single movie's local video(s) are cached, currently queued/caching, or uncached."""
    summary = _collect_uncached_targets_for_row(
        movie_row, include_mobile_burn=include_mobile_burn
    )
    if summary["local_files"] == 0:
        return {"state": "no_local", "uncached_count": 0}

    uncached_targets = summary["uncached_targets"]
    if not uncached_targets:
        return {"state": "cached", "uncached_count": 0}

    target_keys = {t["cache_key"] for t in uncached_targets}

    with _PRECACHE_LOCK:
        if _PRECACHE_CURRENT and _PRECACHE_CURRENT["cache_key"] in target_keys:
            job_id = _PRECACHE_CURRENT.get("job_id", "")
            progress = _PRECACHE_CURRENT.get("progress", 0.0)
            if job_id:
                with _PREPARE_LOCK:
                    job = STREAM_PREPARE_JOBS.get(job_id)
                    if job:
                        progress = job.get("progress", progress)
            return {
                "state": "caching",
                "progress": progress,
                "uncached_count": len(uncached_targets),
            }
        if any(item["cache_key"] in target_keys for item in _PRECACHE_QUEUE):
            return {"state": "queued", "uncached_count": len(uncached_targets)}

    with _PREPARE_LOCK:
        for job in STREAM_PREPARE_JOBS.values():
            if job["cache_key"] in target_keys and job["status"] == "preparing":
                return {
                    "state": "caching",
                    "progress": job.get("progress", 0.0),
                    "uncached_count": len(uncached_targets),
                }

    return {"state": "uncached", "uncached_count": len(uncached_targets)}


def get_precache_queue_status() -> dict:
    """Returns live progress of the active pre-cache job, pending queue, and recent results."""
    with _PRECACHE_LOCK:
        running = _PRECACHE_WORKER_RUNNING
        current = dict(_PRECACHE_CURRENT) if _PRECACHE_CURRENT else None
        queued = [
            {
                "movie_id": item["movie_id"],
                "title": item["title"],
                "filename": item["filename"],
                "variant": item["variant"],
            }
            for item in _PRECACHE_QUEUE
        ]
        history = list(_PRECACHE_HISTORY)

    if current and current.get("job_id"):
        with _PREPARE_LOCK:
            job = STREAM_PREPARE_JOBS.get(current["job_id"])
            if job:
                current["progress"] = job.get("progress", 0.0)
                current["mode_label"] = job.get("mode_label", current["mode_label"])

    return {
        "running": running,
        "current": current,
        "queued": queued,
        "queued_count": len(queued),
        "history": history,
    }


def cancel_precache_queue() -> dict:
    """Clears all pending items in the pre-cache queue and stops the active pre-cache FFmpeg job."""
    active_job_id = ""
    with _PRECACHE_LOCK:
        _PRECACHE_QUEUE.clear()
        if _PRECACHE_CURRENT:
            active_job_id = _PRECACHE_CURRENT.get("job_id", "")

    if active_job_id:
        with _PREPARE_LOCK:
            job = STREAM_PREPARE_JOBS.get(active_job_id)
            if job and job["status"] == "preparing":
                job["status"] = "cancelled"
                job["finished_at"] = time.time()
                _terminate_process(job.get("process"))
                job["process"] = None
                part_path = job.get("part_path")
                if part_path:
                    Path(part_path).unlink(missing_ok=True)

    return get_precache_queue_status()