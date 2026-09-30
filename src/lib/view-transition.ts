// Shared view-transition-name for a work's thumbnail in a collection grid and its main
// image on the work page, so the browser morphs one into the other on navigation.
// Scoped by collection because the home page can show several collections at once.
export const workTransitionName = (collection: string, workId: string) =>
  `work-${collection}-${workId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
