/**
 * Google's details and photos of a place are read with the computer's Places
 * key (auth/central), so only the desktop serves them: a host without it (the
 * browser demo) says so, and a card draws its icon wash instead of a photo.
 */
export const PLACE_DETAILS_NEEDS_MACHINE = {
  feature: "Reading Google's details of a place",
};
