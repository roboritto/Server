import json
import mimetypes
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import List, Optional

from backend.config import FFMPEG_PATH, FFPROBE_PATH, STREAM_CACHE_DIR
from backend.downloads import VALID_VIDEO_EXTS

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
_ENGLISH_LABEL_RE = re.compile(r"\b(?:en|eng|english)\b", re.IGNORECASE)
_FORCED_LABEL_RE = re.compile(r"\b(?:forced|signs)\b", re.IGNORECASE)
_SDH_LABEL_RE = re.compile(r"\b(?:sdh|cc|hearing\s*impaired)\b", re.IGNORECASE)
NO_WINDOW_FLAG = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def get_stream_cache_dir() -> Path:
    cache_dir = Path(STREAM_CACHE_DIR).resolve()
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir


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
            creationflags=NO_WINDOW_FLAG,
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


def is_english_subtitle(sub: dict) -> bool:
    lang = (sub.get("language") or "").strip().lower()
    if lang in ("en", "eng", "english"):
        return True
    return bool(_ENGLISH_LABEL_RE.search(sub.get("label") or ""))


def subtitle_sort_key(sub: dict) -> tuple:
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
    is_eng = is_english_subtitle(sub)
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


def pick_default_subtitle_index(sorted_subtitles: List[dict]) -> int:
    """Returns the index of the highest-priority English (or exact-match sidecar) subtitle, or -1."""
    for idx, sub in enumerate(sorted_subtitles):
        if is_english_subtitle(sub) or sub.get("is_unlabeled_match"):
            return idx
    return -1


def can_copy_video_for_mobile(ticket_data: dict) -> bool:
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