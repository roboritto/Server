import secrets
import time
from pathlib import Path
from typing import Optional

from backend.config import STREAM_TICKET_TTL
from backend.media_probe import (
    find_sidecar_subtitles,
    get_ffmpeg_binary,
    guess_video_media_type,
    needs_ffmpeg_remux,
    pick_default_subtitle_index,
    probe_local_video,
    subtitle_sort_key,
)
from backend.precache import (
    cancel_precache_queue,
    get_movie_precache_status,
    get_precache_queue_status,
    queue_movies_for_precache,
)
from backend.subtitles import (
    extract_pgs_track_sup,
    render_subtitle_track_vtt,
)
from backend.transcoder import (
    cancel_prepare_job,
    clear_stream_cache,
    detach_ticket_from_prepare_jobs,
    get_cached_mp4_path,
    get_prepare_job_status,
    get_stream_cache_stats,
    start_prepare_mp4_job,
)

LOCAL_STREAM_TICKETS = {}


def cleanup_expired_stream_tickets():
    now = time.time()
    expired = [k for k, v in LOCAL_STREAM_TICKETS.items() if v["expires_at"] < now]
    for k in expired:
        item = LOCAL_STREAM_TICKETS.pop(k, None)
        if item:
            detach_ticket_from_prepare_jobs(item, ticket=k)


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
    subtitles.sort(key=subtitle_sort_key)
    default_subtitle_index = pick_default_subtitle_index(subtitles)

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


__all__ = [
    "LOCAL_STREAM_TICKETS",
    "cancel_precache_queue",
    "cancel_prepare_job",
    "cleanup_expired_stream_tickets",
    "clear_stream_cache",
    "create_local_stream_ticket",
    "detach_ticket_from_prepare_jobs",
    "extract_pgs_track_sup",
    "get_cached_mp4_path",
    "get_local_stream_ticket",
    "get_movie_precache_status",
    "get_precache_queue_status",
    "get_prepare_job_status",
    "get_stream_cache_stats",
    "queue_movies_for_precache",
    "render_subtitle_track_vtt",
    "start_prepare_mp4_job",
]