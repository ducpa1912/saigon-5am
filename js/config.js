/**
 * SINGLE SOURCE OF TRUTH FOR EVERY EXTERNAL LINK + THE CHANNEL NAME.
 *
 * >>> EDIT ONLY THIS BLOCK TO DEPLOY. <<<
 * Everything below is filled with the literal tokens from the brief, so the
 * placeholders are impossible to miss. Grep for "REPLACE".
 */

export const CONFIG = {
  channelName: "REPLACE: [CHANNEL NAME]",
  youtubeUrl: "REPLACE: [YOUTUBE URL]",
  calendlyUrl: "REPLACE: [CALENDLY URL]",
  substackUrl: "REPLACE: [SUBSTACK URL]",
  instagramUrl: "REPLACE: [INSTAGRAM URL]",
  xUrl: "REPLACE: [X URL]",
};

/** True while a value is still an unfilled token. */
function isPlaceholder(value) {
  return typeof value !== "string" || value.includes("REPLACE");
}

/**
 * Applies CONFIG to every [data-link="key"] anchor.
 * Anchors ship with href="#" so the markup is valid and crawlable even before
 * this runs; we only upgrade them once a real value exists.
 */
export function applyLinks() {
  document.querySelectorAll("[data-link]").forEach((a) => {
    const key = a.dataset.link;
    const url = CONFIG[key];
    if (!url || isPlaceholder(url)) return;
    a.href = url;
    if (key !== "calendlyUrl") {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
  });

  const { channelName } = CONFIG;
  if (!isPlaceholder(channelName)) {
    document.title = `${channelName} — Andy`;
    document.querySelectorAll("[data-channel-name]").forEach((el) => {
      el.textContent = channelName;
    });
  }
}