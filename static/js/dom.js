const navHomeBtn = document.getElementById('nav-home-btn');
const navRatedBtn = document.getElementById('nav-rated-btn');

const homePage = document.getElementById('home-page');
const ratedPage = document.getElementById('rated-page');
const moviePage = document.getElementById('movie-page');
const personPage = document.getElementById('person-page');

export const dom = {
    // Auth Screen
    authScreen: document.getElementById('auth-screen'),
    authForm: document.getElementById('auth-form'),
    tokenInput: document.getElementById('token-input'),
    authSubmitBtn: document.getElementById('auth-submit-btn'),
    authError: document.getElementById('auth-error'),
    appContainer: document.getElementById('app-container'),

    // Global Navigation & Indicators
    mainNav: document.getElementById('main-nav'),
    navHomeBtn,
    navSearchBtn: document.getElementById('nav-search-btn'),
    navRatedBtn,
    navRandomBtn: document.getElementById('nav-random-btn'),
    navAddBtn: document.getElementById('nav-add-btn'),
    pageNavButtons: [navHomeBtn, navRatedBtn],
    pageBackBtn: document.getElementById('page-back-btn'),
    scrollTopBtn: document.getElementById('scroll-top-btn'),
    topLoadingBarContainer: document.getElementById('top-loading-bar-container'),
    topLoadingBar: document.getElementById('top-loading-bar'),

    // Pages
    homePage,
    ratedPage,
    moviePage,
    personPage,
    allPages: [homePage, ratedPage, moviePage, personPage],

    // Home Page: Search & Below-the-Fold Catalog
    homeSearchForm: document.getElementById('home-search-form'),
    homeSearchInput: document.getElementById('home-search-input'),
    homeSearchResults: document.getElementById('home-search-results'),
    homeRandomSection: document.getElementById('home-random-section'),
    homeRerollRandomBtn: document.getElementById('home-reroll-random-btn'),
    homeRandomGrid: document.getElementById('home-random-grid'),
    homeAllMoviesSection: document.getElementById('home-all-movies-section'),
    allMoviesCountBadge: document.getElementById('all-movies-count-badge'),
    filterNewBtn: document.getElementById('filter-new-btn'),
    toggleFiltersBtn: document.getElementById('toggle-filters-btn'),
    clearAllFiltersBtn: document.getElementById('clear-all-filters-btn'),
    allMoviesFiltersDrawer: document.getElementById('all-movies-filters-drawer'),
    genreFiltersList: document.getElementById('genre-filters-list'),
    floatingAlphabetBar: document.getElementById('floating-alphabet-bar'),
    homeAllMoviesGrid: document.getElementById('home-all-movies-grid'),

    // Rated & Reviewed Page
    ratedMoviesCountBadge: document.getElementById('rated-movies-count-badge'),
    ratedFilterHearts: document.querySelectorAll('.rated-filter-heart'),
    ratedMoviesGrid: document.getElementById('rated-movies-grid'),

    // Movie Detail Page
    movieHeroBackdrop: document.getElementById('movie-hero-backdrop'),
    movieBackdropImage: document.getElementById('movie-backdrop-image'),
    movieReleaseYear: document.getElementById('movie-release-year'),
    movieTitle: document.getElementById('movie-title'),
    movieDirectors: document.getElementById('movie-directors'),
    movieRatingRow: document.getElementById('movie-rating-row'),
    movieHearts: document.getElementById('movie-hearts'),
    movieLastWatch: document.getElementById('movie-last-watch'),
    movieSynopsis: document.getElementById('movie-synopsis'),
    openDownloadModalBtn: document.getElementById('open-download-modal-btn'),
    openRatingModalBtn: document.getElementById('open-rating-modal-btn'),
    openCollectionModalBtn: document.getElementById('open-collection-modal-btn'),
    openAddLinkModalBtn: document.getElementById('open-add-link-modal-btn'),
    deleteMovieBtn: document.getElementById('delete-movie-btn'),
    movieCastList: document.getElementById('movie-cast-list'),
    movieCollectionsContainer: document.getElementById('movie-collections-container'),

    // Person Detail Page
    personAvatarContainer: document.getElementById('person-avatar-container'),
    personRoleLabel: document.getElementById('person-role-label'),
    personName: document.getElementById('person-name'),
    personMoviesGrid: document.getElementById('person-movies-grid'),

    // Modal 1: Search Database
    dbSearchModal: document.getElementById('db-search-modal'),
    closeDbSearchBtn: document.getElementById('close-db-search-btn'),
    modalSearchForm: document.getElementById('modal-search-form'),
    modalSearchInput: document.getElementById('modal-search-input'),
    modalSearchResults: document.getElementById('modal-search-results'),

    // Modal 2: Add Movie (TMDB)
    tmdbAddModal: document.getElementById('tmdb-add-modal'),
    closeTmdbAddBtn: document.getElementById('close-tmdb-add-btn'),
    tmdbSearchForm: document.getElementById('tmdb-search-form'),
    tmdbSearchInput: document.getElementById('tmdb-search-input'),
    tmdbSearchResults: document.getElementById('tmdb-search-results'),

    // Modal 3: Rating & Review
    ratingModal: document.getElementById('rating-modal'),
    closeRatingModalBtn: document.getElementById('close-rating-modal-btn'),
    ratingForm: document.getElementById('rating-form'),
    ratingHeartsSelector: document.getElementById('rating-hearts-selector'),
    interactiveHearts: document.querySelectorAll('.interactive-heart'),
    ratingValueDisplay: document.getElementById('rating-value-display'),
    reviewTextarea: document.getElementById('review-textarea'),
    clearRatingBtn: document.getElementById('clear-rating-btn'),
    saveRatingBtn: document.getElementById('save-rating-btn'),

    // Modal 4: Add to Collection
    collectionModal: document.getElementById('collection-modal'),
    closeCollectionModalBtn: document.getElementById('close-collection-modal-btn'),
    collectionSearchForm: document.getElementById('collection-search-form'),
    collectionSearchInput: document.getElementById('collection-search-input'),
    addNewCollectionBtn: document.getElementById('add-new-collection-btn'),
    collectionListContainer: document.getElementById('collection-list-container'),

    // Modal 5: Download Links
    downloadModal: document.getElementById('download-modal'),
    closeDownloadModalBtn: document.getElementById('close-download-modal-btn'),
    downloadModalLinks: document.getElementById('download-modal-links'),

    // Modal 6: Confirm Remove Movie
    deleteMovieModal: document.getElementById('delete-movie-modal'),
    closeDeleteModalBtn: document.getElementById('close-delete-modal-btn'),
    deleteMovieTargetTitle: document.getElementById('delete-movie-target-title'),
    cancelDeleteMovieBtn: document.getElementById('cancel-delete-movie-btn'),
    confirmDeleteMovieBtn: document.getElementById('confirm-delete-movie-btn'),

    // Modal 7: Add Download Link
    addLinkModal: document.getElementById('add-link-modal'),
    closeAddLinkModalBtn: document.getElementById('close-add-link-modal-btn'),
    addLinkForm: document.getElementById('add-link-form'),
    addLinkInput: document.getElementById('add-link-input'),
    saveAddLinkBtn: document.getElementById('save-add-link-btn')
};