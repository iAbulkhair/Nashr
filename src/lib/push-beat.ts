/**
 * The "away" clock of phone notifications (rule 2564), in a module with no server imports so the tab's heartbeat
 * (src/components/app/TabBeat.tsx) can read it: a login counts as away when no tab of it was visible for
 * `AWAY_MINUTES`; a visible tab beats every `BEAT_SECONDS`, well inside that window.
 */
export const AWAY_MINUTES = 5;
export const BEAT_SECONDS = 120;
