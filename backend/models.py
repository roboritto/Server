from typing import Any, Dict, List, Optional
from pydantic import BaseModel


class Movie(BaseModel):
    movie_id: str
    link: Optional[str] = ""
    rating: Optional[float] = 0.0
    last_watch: Optional[str] = ""
    review: Optional[str] = ""
    collection: Optional[str] = ""


class MovieUpdate(BaseModel):
    link: Optional[str] = None
    rating: Optional[float] = None
    last_watch: Optional[str] = None
    review: Optional[str] = None
    collection: Optional[str] = None


class CollectionDownloadRequest(BaseModel):
    collection: str
    titles: dict[str, str] = {}
    movie_order: List[str] = []


class TmdbCacheUpdate(BaseModel):
    entries: Dict[str, Dict[str, Any]]


class CustomMovieCreate(BaseModel):
    movie_id: str
    title: str
    original_title: Optional[str] = ""
    release_date: Optional[str] = ""
    release_year: Optional[str] = ""
    runtime: Optional[int] = 0
    genres: List[str] = []
    overview: Optional[str] = ""
    poster_path: Optional[str] = ""
    backdrop_path: Optional[str] = ""
    tmdb_rating: Optional[float] = 0.0
    directors: List[Any] = []
    cast: List[Any] = []

class LocalFileDownloadRequest(BaseModel):
    movie_id: str
    path: str