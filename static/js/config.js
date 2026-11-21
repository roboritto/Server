export const TOKEN_STORAGE_KEY = 'cinema_api_token_v1';
export const TMDB_CACHE_KEY = 'cinema_tmdb_cache_v3'; // v3 includes actor character names
export const CHUNK_SIZE = 5;
export const CHUNK_DELAY_MS = 250;
export const MAX_SEARCH_RESULTS = 12;
export const HOME_RANDOM_COUNT = 10;
export const CUSTOM_MOVIE_ID_MIN = 8000000;

export const TMDB_GENRES = [
    { label: 'Action', tmdbName: 'Action' },
    { label: 'Adventure', tmdbName: 'Adventure' },
    { label: 'Animation', tmdbName: 'Animation' },
    { label: 'Comedy', tmdbName: 'Comedy' },
    { label: 'Crime', tmdbName: 'Crime' },
    { label: 'Documentary', tmdbName: 'Documentary' },
    { label: 'Drama', tmdbName: 'Drama' },
    { label: 'Family', tmdbName: 'Family' },
    { label: 'Fantasy', tmdbName: 'Fantasy' },
    { label: 'History', tmdbName: 'History' },
    { label: 'Horror', tmdbName: 'Horror' },
    { label: 'Music', tmdbName: 'Music' },
    { label: 'Mystery', tmdbName: 'Mystery' },
    { label: 'Romance', tmdbName: 'Romance' },
    { label: 'Sci-Fi', tmdbName: 'Science Fiction' },
    { label: 'TV Movie', tmdbName: 'TV Movie' },
    { label: 'Thriller', tmdbName: 'Thriller' },
    { label: 'War', tmdbName: 'War' },
    { label: 'Western', tmdbName: 'Western' }
];

export const ALPHABET_KEYS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')];