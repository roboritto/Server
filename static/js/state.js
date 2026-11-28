import { TOKEN_STORAGE_KEY } from './config.js';
import { getMovieIdFromUrlPath } from './utils.js';

export const state = {
    // Auth & Keys
    isDemoMode: false,
    isAdmin: false,
    canPreviewGuest: false,
    isGuestPreview: false,
    serverApiToken: localStorage.getItem(TOKEN_STORAGE_KEY) || '',
    tmdbApiKey: '',
    permissions: {
        delete: true,
        add_movie: true,
        add_link: true,
        edit_rating: true,
        edit_collection: true,
        download_collection: true
    },

    // Routing & History
    currentPage: 'home-page',
    currentMovieId: null,
    currentPersonId: null,
    pendingInitialMovieId: getMovieIdFromUrlPath(),
    navigationHistory: [],

    // Database & Caches
    rawCsvMovies: [],       // Raw rows from /api/movies CSV
    moviesDatabase: [],     // Enriched movie objects (CSV + TMDB/custom metadata)
    peopleDatabase: [],     // Aggregated unique directors & actors with combined roles
    tmdbCache: {},          // Loaded from server-side /api/tmdb-cache
    customMoviesData: {},   // Local metadata loaded from /api/custom-movies
    isDatabaseLoading: false,
    isDatabaseLoaded: false,

    // UI Filters & Modals
    selectedModalRating: 0.0,
    activeRatedFilter: 0.0,
    tmdbSearchTimeout: null,
    latestTmdbSearchQuery: '',
    hasInitializedHomeRandom: false,
    genreFilterStates: {},   // { 'Action': 1 (include) | -1 (exclude) }
    filterNewOnly: false
};