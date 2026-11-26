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
    FFMPEG_PATH,
    FFPROBE_PATH,
    STREAM_TICKET_TTL,
)
from backend.downloads import VALID_VIDEO_EXTS

LOCAL_STREAM_TICKETS = {}
_HLS_LOCK = threading.Lock()
BROWSER_NATIVE_EXTS = {".mp4", ".m4v", ".webm"}
BROWSER_SAFE_VIDEO_CODECS = {"h264", "vp8", "vp9", "av1"}
BROWSER_SAFE_AUDIO_CODECS = {"aac", "mp3", "opus", "vorbis"}
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
_NO_WINDOW_FLAG = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def cleanup_expired_stream_tickets():
    now = time.time()
    expired = [k for k, v in LOCAL_STREAM_TICKETS.items() if v["expires_at"] < now]
    for k in expired:
        item = LOCAL_STREAM_TICKETS.pop(k, None)
        if item:
            stop_hls_session(item)


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
                        "stream_index": int(stream.get("index", 0)),
                        "label": label,
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
                "render_mode": "text",
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
    cleanup_expired_stream_tickets()
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
        "audio_tracks": probe.get("audio_tracks", []),
        "subtitles": subtitles,
        "subtitle_cache": {},
        "hls_session": None,
    }

    public_subtitles = [
        {
            "index": idx,
            "label": sub["label"],
            "source": sub["source"],
            "render_mode": sub.get("render_mode", "text"),
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
        "mode": "ffmpeg" if use_ffmpeg else "direct",
        "duration": probe.get("duration", 0.0),
        "ffmpeg_available": bool(get_ffmpeg_binary()),
        "subtitles": public_subtitles,
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


def start_hls_session(
    ticket_data: dict,
    start_seconds: float = 0.0,
    burn_sub_stream: Optional[int] = None,
    audio_track_index: int = 0,
) -> Optional[str]:
    """Starts an on-the-fly FFmpeg HLS stream (with optional PGS/VobSub burn-in & audio track selection)."""
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
    cmd.extend(["-i", ticket_data["path"]])

    selected_audio = get_selected_audio_track(ticket_data, audio_track_index)
    audio_map = f"0:{selected_audio['stream_index']}" if selected_audio else "0:a:0?"
    audio_codec = selected_audio["codec"] if selected_audio else ticket_data.get("audio_codec", "")

    if burn_sub_stream is not None:
        cmd.extend([
            "-filter_complex",
            f"[0:{burn_sub_stream}][0:v:0]scale2ref[sub][vid];[vid][sub]overlay=eof_action=pass[v]",
            "-map", "[v]",
            "-map", audio_map,
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
            "-profile:v", "main", "-level", "4.1", "-pix_fmt", "yuv420p",
            "-g", "48", "-keyint_min", "48", "-sc_threshold", "0",
        ])
    else:
        cmd.extend(["-map", "0:v:0", "-map", audio_map])
        if _can_copy_video_for_mobile(ticket_data):
            cmd.extend(["-c:v", "copy", "-bsf:v", "h264_mp4toannexb"])
        else:
            cmd.extend([
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
                "-profile:v", "main", "-level", "4.1", "-pix_fmt", "yuv420p",
                "-g", "48", "-keyint_min", "48", "-sc_threshold", "0",
            ])

    if audio_codec == "aac":
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


def stream_transcoded_video(
    ticket_data: dict,
    start_seconds: float = 0.0,
    burn_sub_stream: Optional[int] = None,
    audio_track_index: int = 0,
):
    """Fallback fragmented MP4 stream if hls.js is unavailable offline."""
    ffmpeg_bin = get_ffmpeg_binary()
    if not ffmpeg_bin:
        return

    selected_audio = get_selected_audio_track(ticket_data, audio_track_index)
    audio_map = f"0:{selected_audio['stream_index']}" if selected_audio else "0:a:0?"
    audio_codec = selected_audio["codec"] if selected_audio else ticket_data.get("audio_codec", "")

    cmd = [ffmpeg_bin, "-v", "error"]
    if start_seconds > 0:
        cmd.extend(["-ss", f"{start_seconds:.3f}"])
    cmd.extend(["-i", ticket_data["path"]])

    if burn_sub_stream is not None:
        cmd.extend([
            "-filter_complex",
            f"[0:{burn_sub_stream}][0:v:0]scale2ref[sub][vid];[vid][sub]overlay=eof_action=pass[v]",
            "-map", "[v]",
            "-map", audio_map,
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
            "-profile:v", "main", "-level", "4.1", "-pix_fmt", "yuv420p",
            "-g", "48",
        ])
    else:
        cmd.extend(["-map", "0:v:0", "-map", audio_map])
        if _can_copy_video_for_mobile(ticket_data):
            cmd.extend(["-c:v", "copy"])
        else:
            cmd.extend([
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
                "-profile:v", "main", "-level", "4.1", "-pix_fmt", "yuv420p",
                "-g", "48",
            ])

    if audio_codec in {"aac", "mp3"}:
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