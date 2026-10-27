const ALLOWED_ORIGINS = new Set([
  "https://nashp.com",
  "https://www.nashp.com",
]);
const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

function stripeHeaderParts(value) {
  return String(value || "").split(",").reduce((parts, item) => {
    const [key, ...rest] = item.split("=");
    if (!key || !rest.length) return parts;
    (parts[key] ||= []).push(rest.join("="));
    return parts;
  }, {});
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameString(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

async function validStripeSignature(payload, header, secret) {
  const parts = stripeHeaderParts(header);
  const timestamp = Number(parts.t?.[0]);
  const signatures = parts.v1 || [];
  if (!Number.isFinite(timestamp) || !signatures.length || Math.abs(Date.now() / 1000 - timestamp) > STRIPE_SIGNATURE_TOLERANCE_SECONDS) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${payload}`)));
  return signatures.some((signature) => sameString(digest, signature));
}

function hyperfuelPaymentLinks(env) {
  return new Set(String(env.STRIPE_HYPERFUEL_PAYMENT_LINK_IDS || "").split(",").map((value) => value.trim()).filter(Boolean));
}

async function recordHyperfuel(storage, event) {
  const eventKey = `stripe:event:${event.id}`;
  if (await storage.get(eventKey)) return { accepted: true, duplicate: true };
  const month = chicagoDate(new Date(Number(event.created || Date.now() / 1000) * 1000)).slice(0, 7);
  const key = `hyperfuel:${month}`;
  const fuel = await storage.get(key) || { count: 0, events: [] };
  const events = [...fuel.events, { id: event.id, source: event.source, created: new Date(Number(event.created || Date.now() / 1000) * 1000).toISOString() }].slice(-64);
  await storage.put({ [eventKey]: true, [key]: { count: fuel.count + 1, events } });
  return { accepted: true, duplicate: false, month, count: fuel.count + 1 };
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin)
      ? origin
      : "https://nashp.com",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function publicationName(value) {
  return String(value || "Reeder")
    .split(/\s(?:\||—|–|-)\s|:/, 1)[0]
    .trim() || "Reeder";
}

function sourceFor(item) {
  return publicationName(
    item?._reeder?.feed?.title ||
    item?.authors?.[0]?.name ||
    "Reeder"
  );
}

function cleanTitleFragments(value) {
  return String(value || "")
    .replace(/^[\s★☆⭐︎*]+/, "")
    .replace(/\s+(?:https?:\/\/|www\.)\S.*$/i, "")
    .replace(/\s+[-–—]\s+[a-z]{1,2}$/i, "")
    .replace(/\s+\b(?:through|with|from|for|to|of|in|on|at|by)\s+(?:t|th)$/i, "")
    .trim();
}

function titleFor(item) {
  const title = cleanTitleFragments(item?.title);
  if (title) return title;
  const text = String(item?.content_text || "")
    .replace(/\s+/g, " ")
    .replace(/\s+(?:https?:\/\/|www\.)\S.*$/i, "")
    .trim();
  if (!text) return "Saved link";
  if (text.length <= 120) return cleanTitleFragments(text);
  const wordSafe = text.slice(0, 120).replace(/\s+\S*$/, "").replace(/[ .,;:—–-]+$/, "");
  return cleanTitleFragments(wordSafe) + "…";
}

function reederDate(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return "";
  // Reeder timestamps use Apple's epoch (2001-01-01), not Unix's.
  return new Date((seconds + 978307200) * 1000).toISOString();
}

const YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";

function chicagoDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

function isTodayInChicago(value) {
  return chicagoDate(value) === chicagoDate(new Date());
}

async function archivePath(env, path, init) {
  const archive = env.EXTRACTOR_ARCHIVE.getByName("main");
  return archive.fetch(`https://extractor.internal${path}`, init);
}

async function youtubeRefreshToken(env) {
  const response = await archivePath(env, "/youtube/token");
  if (!response.ok) return "";
  const stored = await response.json();
  return String(stored.refreshToken || "");
}

async function youtubeItems(env) {
  if (!env.YOUTUBE_CLIENT_ID || !env.YOUTUBE_CLIENT_SECRET) return [];
  const refreshToken = await youtubeRefreshToken(env);
  if (!refreshToken) return [];

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.YOUTUBE_CLIENT_ID,
      client_secret: env.YOUTUBE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!tokenResponse.ok) throw new Error("YouTube token refresh failed");
  const token = await tokenResponse.json();
  if (!token.access_token) throw new Error("YouTube access token unavailable");

  // YouTube returns Likes in pages of at most 50. Keep following the next-page
  // cursor so a long-running library is preserved rather than silently turning
  // into a rolling window of only the newest 50 videos.
  const videos = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      part: "snippet",
      myRating: "like",
      maxResults: "50",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const videosResponse = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?${params}`,
      { headers: { Authorization: `Bearer ${token.access_token}` } }
    );
    if (!videosResponse.ok) throw new Error("YouTube likes fetch failed");
    const payload = await videosResponse.json();
    videos.push(...(Array.isArray(payload.items) ? payload.items : []));
    pageToken = String(payload.nextPageToken || "");
  } while (pageToken);
  // YouTube does not expose the time a Like was made. Its Likes collection is
  // ordered by that action, though, so treat its leading edge as the current
  // intake. We stamp first discovery ourselves and keep it for the current
  // local day. This lets a video published years ago appear the moment Nash
  // likes it, without resurfacing the entire historical Likes library.
  const currentVideos = videos.slice(0, 50);
  const ids = currentVideos.map((video) => String(video.id || "")).filter(Boolean);
  const seenResponse = await archivePath(env, "/youtube/seen", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, now: new Date().toISOString() }),
  });
  const seen = seenResponse.ok ? (await seenResponse.json()).seen || {} : {};
  return currentVideos.filter((video) => isTodayInChicago(seen[String(video.id)])).map((video) => ({
    title: cleanTitleFragments(video?.snippet?.title) || "Liked YouTube video",
    url: `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`,
    source: video?.snippet?.channelTitle || "YouTube",
    date_published: video?.snippet?.publishedAt || "",
    // First discovery is the best available proxy for the private Like time.
    date_saved: seen[String(video.id)] || "",
    type: "youtube",
  }));
}

async function liveItems(env) {
  const FEED_URL = env.REEDER_FEED_URL;
  if (!FEED_URL) throw new Error("REEDER_FEED_URL is not configured");
  const response = await fetch(`${FEED_URL}?fresh=${Date.now()}`, {
    headers: { Accept: "application/feed+json, application/json" },
    cf: { cacheEverything: false, cacheTtl: 0 },
  });
  if (!response.ok) throw new Error(`Reeder returned ${response.status}`);
  const feed = await response.json();
  const reederItems = (Array.isArray(feed.items) ? feed.items : [])
    .map((item) => ({
      title: titleFor(item),
      url: item.url || FEED_URL,
      source: sourceFor(item),
      date_published: item.date_published || "",
      date_saved: reederDate(item?._reeder?.date),
    }));
  try {
    return [...reederItems, ...(await youtubeItems(env))];
  } catch (error) {
    // Extractor remains healthy if Google is temporarily unavailable.
    console.error("YouTube likes refresh failed", error);
    return reederItems;
  }
}

async function archiveRequest(env, items, recluster = false, replaceYoutube = false) {
  const archive = env.EXTRACTOR_ARCHIVE.getByName("main");
  const search = new URLSearchParams();
  if (recluster) search.set("recluster", "1");
  if (replaceYoutube) search.set("replaceYoutube", "1");
  return archive.fetch(`https://extractor.internal/archive${search.size ? `?${search}` : ""}`, items ? {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(items),
  } : undefined);
}

async function syncArchive(env, recluster = false) {
  const items = await liveItems(env);
  const response = await archiveRequest(env, items, recluster, true);
  if (!response.ok) throw new Error("Archive update failed");
  return response.json();
}

function topicId(label) {
  return `topic-${String(label || "other-signals")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "other-signals"}`;
}

function normalizeThreadLabel(value) {
  return String(value || "")
    // Keep real abbreviations readable after a pattern label is title-cased.
    // This is deliberately an explicit list: headline publishers often write
    // ordinary words in all caps, so preserving every uppercase word would be
    // worse than protecting established acronyms.
    .replace(/\bNba\b/gi, "NBA")
    .replace(/\bNfl\b/gi, "NFL")
    .replace(/\bMlb\b/gi, "MLB")
    .replace(/\bNhl\b/gi, "NHL")
    .replace(/\bNcaa\b/gi, "NCAA")
    .replace(/\bUfc\b/gi, "UFC")
    .replace(/\bWwe\b/gi, "WWE")
    .replace(/\bEspn\b/gi, "ESPN")
    .replace(/\bBbc\b/gi, "BBC")
    .replace(/\bCnn\b/gi, "CNN")
    .replace(/\bAbc\b/gi, "ABC")
    .replace(/\bCbs\b/gi, "CBS")
    .replace(/\bOpenai\b/gi, "OpenAI")
    .replace(/\bChatgpt\b/gi, "ChatGPT")
    .replace(/\bCeo\b/gi, "CEO")
    .replace(/\bGta\b/gi, "GTA")
    .replace(/\bVi\b/g, "VI")
    .replace(/\bPs5\b/gi, "PS5")
    .replace(/\bTv\b/gi, "TV")
    .replace(/\bIos\b/gi, "iOS")
    .replace(/\bIphone\b/gi, "iPhone")
    .replace(/\bIpad\b/gi, "iPad")
    .replace(/\bXbox\b/gi, "Xbox")
    .trim();
}

const PATTERN_STOP_WORDS = new Set([
  "how", "what", "reportedly", "bring", "brings",
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "direct", "for", "from", "has", "have", "he", "her", "his", "in", "into", "introduce", "introduces", "is", "it", "its", "live", "more", "most", "new", "no", "not", "now", "of", "on", "or", "our", "out", "says", "that", "the", "their", "this", "to", "up", "was", "were", "with", "you", "your",
]);
const PATTERN_GENERIC_WORDS = new Set([
  "ad", "announce", "announces", "announcement", "announced", "april", "august", "billion", "box", "chart", "day", "days", "december", "demo", "domestic", "event", "fastest", "february", "feature", "first", "free", "game", "games", "gaming", "guide", "hub", "january", "july", "june", "launch", "launches", "latest", "look", "march", "may", "million", "month", "months", "news", "november", "october", "office", "preview", "release", "releases", "remaster", "review", "september", "story", "supported", "top", "trailer", "update", "video", "view", "views", "week", "weeks", "world", "year", "years",
  // Formats are useful inside a real name (Apple TV), but never establish
  // their own connection. Otherwise unrelated shows, reviews, and hardware
  // stories get welded together merely because they all say "TV".
  "tv",
]);
const PATTERN_QUANTITY_WORDS = new Set([
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "dozen", "dozens", "several", "many", "few", "multiple",
]);
// Broad platforms and formats are useful landing places, but they cannot be
// allowed to break apart a genuinely repeated named subject.
const BROAD_TOPIC_WORDS = new Set([
  "ai", "apple", "controller", "direct", "game", "games", "gaming", "marvel",
  "nintendo", "playstation", "ps3", "ps4", "ps5", "roundup", "switch", "xbox",
]);
const RESIDUAL_UMBRELLA_SUBJECTS = new Set([
  // Apple already has a literal parent connection. Letting this residual pass
  // pull it back out of earned Apple subfamilies would undo their promotion.
  "ai", "iphone", "nintendo", "playstation", "ps3", "ps4", "ps5", "switch", "xbox",
]);
const MODEL_EDITION_WORDS = new Set(["air", "max", "mini", "plus", "pro", "ultra"]);
// Words that describe a medium, form factor, or ordinary container never
// identify a subject by themselves. They can still contribute to a longer
// literal phrase such as "Apple TV" or "Retroid Pocket".
const NON_SUBJECT_HEADLINE_WORDS = new Set(["how", "man", "mini", "pocket", "tv"]);
const PATTERN_SINGULAR_EXCEPTIONS = new Set([
  "analysis", "business", "class", "glass", "news", "process", "series", "status",
]);

function normalizePatternToken(word) {
  // This is deliberately modest: normalize ordinary title plurals without
  // pretending to be a full language stemmer. It lets Direct and Directs
  // count as the same subject while preserving words where a trailing s is
  // part of the word itself.
  if (
    word.length > 4 &&
    /(?:ches|shes|xes|zes)$/.test(word)
  ) return word.slice(0, -2);
  if (
    word.length > 3 &&
    word.endsWith("s") &&
    !/(?:ss|us|is|ics)$/.test(word) &&
    !PATTERN_SINGULAR_EXCEPTIONS.has(word)
  ) return word.slice(0, -1);
  return word;
}

function patternTokens(title) {
  const words = String(title || "")
    .toLowerCase()
    .replace(/grand theft auto\s*(?:6|vi)/g, "grand theft auto vi")
    .replace(/\bgta\s*(?:6|vi)\b/g, "grand theft auto vi")
    // Possessive forms are the same subject: Apple and Apple's both mean Apple.
    .replace(/\b([a-z0-9]+)[’']s\b/g, "$1")
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words
    .filter((word, index) => {
      if (/[a-z]/.test(word)) return true;
      // A model number is meaningful only when it sits inside a named phrase
      // ("iPhone 18 Pro"), never when it behaves like a date or a list number.
      return /^\d{1,2}$/.test(word) &&
        /[a-z]/.test(words[index - 1] || "") &&
        /[a-z]/.test(words[index + 1] || "");
    })
    .map(normalizePatternToken);
}

// Discovery intentionally folds small plural differences together. Keep a
// second version of the title for display, so a connection can retain the
// wording people actually used ("Clippers", "Trade Secrets", etc.).
function displayPatternTokens(title) {
  return String(title || "")
    .replace(/grand theft auto\s*(?:6|vi)/gi, "Grand Theft Auto VI")
    .replace(/\bgta\s*(?:6|vi)\b/gi, "Grand Theft Auto VI")
    // Keep a visible possessive for the label ("Man's"), while its
    // normalized form still groups with "Man" during matching.
    .match(/[a-zA-Z0-9]+(?:[’'][a-zA-Z0-9]+)?/g) || [];
}

function normalizedDisplayPatternToken(word) {
  return normalizePatternToken(String(word || "").toLowerCase()
    .replace(/\b([a-z0-9]+)[’']s\b/i, "$1")
    .replace(/[’']/g, ""));
}

function preferredPatternWord(word, itemIndexes, active) {
  const forms = new Map();
  itemIndexes.forEach((itemIndex) => {
    displayPatternTokens(active[itemIndex].title).forEach((form) => {
      const normalizedForm = normalizedDisplayPatternToken(form);
      if (normalizedForm !== word) return;
      const key = form.toLowerCase();
      const current = forms.get(key) || { form, count: 0 };
      current.count += 1;
      forms.set(key, current);
    });
  });
  return [...forms.values()].sort((left, right) =>
    right.count - left.count ||
    right.form.length - left.form.length ||
    left.form.localeCompare(right.form)
  )[0]?.form || word;
}

// A few short words are integral to recognized titles even though normal
// discovery treats them as weak. This lets "No Man's Sky" retain its name
// without promoting ordinary headline filler into connection labels.
const LABEL_LEADING_WORDS = new Set(["a", "an", "the", "no"]);
const LABEL_SMALL_WORDS = new Set([
  "a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "of", "on", "or", "the", "to", "via", "vs",
]);

function leadingPatternArticle(words, itemIndexes, active) {
  const articles = itemIndexes.map((itemIndex) => {
    const tokens = displayPatternTokens(active[itemIndex].title);
    const normalized = tokens.map(normalizedDisplayPatternToken);
    const article = normalized[0];
    return LABEL_LEADING_WORDS.has(article) &&
      normalized.slice(1, words.length + 1).join(" ") === words.join(" ")
      ? article
      : "";
  });
  // An article is part of a title only when every title in this connection
  // actually opens with the same one. This avoids promoting a sentence's
  // ordinary "the" into a connection name.
  return articles.length && articles.every((article) => article && article === articles[0])
    ? articles[0]
    : "";
}

function naturalPatternLabel(words, itemIndexes, active) {
  const article = leadingPatternArticle(words, itemIndexes, active);
  const label = words.map((word) =>
    preferredPatternWord(word, itemIndexes, active)
  ).join(" ");
  // A possessive at the beginning of a headline is usually grammatical
  // framing, not the name of the connection ("OpenAI's new..." -> OpenAI).
  // Keep possessives elsewhere intact, so genuine names such as No Man's Sky
  // still render naturally.
  // A one-word label such as "OpenAI's" is headline framing, whereas a
  // multi-word name such as "Marvel's Wolverine" can legitimately own its
  // possessive. Conversely, a trailing possessive ("Tim Cook's") is always
  // grammatical framing for this purpose. Treat those two positions
  // differently so cleanup never flattens a real title.
  const normalizedLeading = words.length === 1
    ? label.replace(/^([^\s]+)[’']s\b/i, "$1")
    : label;
  const normalizedLabel = normalizedLeading.replace(/\b([^\s]+)[’']s\b(?=\s*$)/i, "$1");
  return readablePatternLabel(article ? `${article} ${normalizedLabel}` : normalizedLabel);
}

function readablePatternLabel(phrase) {
  const words = String(phrase || "").toLowerCase().split(/\s+/).filter(Boolean);
  return normalizeThreadLabel(words.map((word, index) =>
    index > 0 && index < words.length - 1 && LABEL_SMALL_WORDS.has(word)
      ? word
      : word.charAt(0).toUpperCase() + word.slice(1)
  ).join(" "));
}

// Deal drops and raw URL saves are useful in the archive, but they are not
// editorial reads. Keep them out of every public connection surface.
function isRawLinkPromo(item) {
  const title = String(item?.title || "");
  return /(?:https?:\/\/|www\.)\S+/i.test(title) ||
    /\b[a-z0-9-]+\.(?:ly|link|to|co|io|app|gg)\/[a-z0-9]/i.test(title) ||
    /(?:^|\s)#ad\b/i.test(title);
}

function meaningfulPattern(words) {
  if (
    !words.length ||
    PATTERN_STOP_WORDS.has(words[0]) ||
    PATTERN_STOP_WORDS.has(words.at(-1)) ||
    words.some((word) => PATTERN_QUANTITY_WORDS.has(word))
  ) return false;
  return words.some((word) => !PATTERN_STOP_WORDS.has(word) && !PATTERN_GENERIC_WORDS.has(word));
}

function patternCandidates(active) {
  const occurrences = new Map();
  active.forEach((item, itemIndex) => {
    const tokens = patternTokens(item.title);
    const phrasesInItem = new Set();
    for (let start = 0; start < tokens.length; start += 1) {
      for (let length = 1; length <= 4 && start + length <= tokens.length; length += 1) {
        const words = tokens.slice(start, start + length);
        if (meaningfulPattern(words)) phrasesInItem.add(words.join(" "));
      }
    }
    phrasesInItem.forEach((phrase) => {
      const matches = occurrences.get(phrase) || [];
      matches.push(itemIndex);
      occurrences.set(phrase, matches);
    });
  });
  return [...occurrences.entries()]
    .filter(([, itemIndexes]) => itemIndexes.length >= 3)
    .map(([phrase, itemIndexes]) => ({ phrase, words: phrase.split(" "), itemIndexes }));
}

// A single repeated word is not enough to establish identity. Names are the
// clearest example: three unrelated stories can all mention Andrew. A lone
// word earns a connection only when a repeated two-word-or-longer phrase also
// contains it ("Legend of Zelda", "Grand Theft Auto", etc.).
function hasIdentityProof(candidate, candidates, active) {
  if (candidate.words.length !== 1) return true;
  const subject = candidate.words[0];
  if (NON_SUBJECT_HEADLINE_WORDS.has(subject)) return false;
  // A trailing subject word must not win when every one of its saves already
  // belongs to one fuller repeated title. Without this guard, "Emblem" can
  // outrank "Fire Emblem" merely because the one-word candidate is shorter.
  // This is deliberately evidence-based: the longer phrase has to cover the
  // entire one-word set, so "Wolverine" can still stand alone when it appears
  // outside a more specific series or film title.
  const fullyOwnedByLongerPhrase = candidates.some((other) =>
    other.words.length >= 2 &&
    other.words.at(-1) === subject &&
    other.itemIndexes.length >= 3 &&
    candidate.itemIndexes.every((itemIndex) => other.itemIndexes.includes(itemIndex))
  );
  if (fullyOwnedByLongerPhrase) return false;
  return candidates.some((other) =>
    other.words.length >= 2 &&
    other.words.includes(subject) &&
    other.itemIndexes.length >= 3
  ) || leadingHeadlineMatches(candidate, active) >= 3;
}

function leadingHeadlineMatches(candidate, active) {
  return candidate.itemIndexes.filter((itemIndex) => {
    const titleWords = patternTokens(active[itemIndex].title);
    for (let index = 0; index <= 1; index += 1) {
      if (titleWords.slice(index, index + candidate.words.length).join(" ") === candidate.phrase) return true;
    }
    return false;
  }).length;
}

function extendPatternPath(parentWords, childWords) {
  const parent = parentWords.join(" ");
  const child = childWords.join(" ");
  // A longer version of the parent replaces it; a wholly new repeated word
  // extends it. Partial overlaps are competing descriptions of the same
  // subject, not an additional level in its name.
  if (child.includes(parent)) return childWords;
  if (childWords.some((word) => parentWords.includes(word))) return childWords;
  // Product names often place their model number between the product and its
  // edition (iPhone 18 Pro, Galaxy S25 Ultra). Keep that natural order rather
  // than tacking a recognized number onto the end of the label.
  if (
    childWords.length === 1 &&
    /^\d{1,2}$/.test(childWords[0]) &&
    parentWords.some((word) => MODEL_EDITION_WORDS.has(word))
  ) {
    const editionIndex = parentWords.findIndex((word) => MODEL_EDITION_WORDS.has(word));
    return [...parentWords.slice(0, editionIndex), childWords[0], ...parentWords.slice(editionIndex)];
  }
  return [...parentWords, ...childWords];
}

function buildPatternConnections(items) {
  // The whole archive is the field of evidence. A connection may age down the page,
  // but it does not disappear simply because newer saves arrived.
  const active = items;
  const candidates = patternCandidates(active);
  items.forEach((item) => { delete item.topicId; });
  const topics = [];
  const canonicalTitleLabel = (words, itemIndexes) => {
    const phrase = words.join(" ");
    let articleMatches = 0;
    itemIndexes.forEach((itemIndex) => {
      const titleWords = displayPatternTokens(active[itemIndex].title)
        .map(normalizedDisplayPatternToken);
      for (let index = 1; index + words.length <= titleWords.length; index += 1) {
        if (titleWords[index - 1] === "the" && titleWords.slice(index, index + words.length).join(" ") === phrase) {
          articleMatches += 1;
          break;
        }
      }
    });
    // A repeated named title can keep its proper article even when other
    // related saves shorten it to the distinctive final subject (Zelda).
    return articleMatches === itemIndexes.length
      ? readablePatternLabel(`the ${phrase}`)
      : naturalPatternLabel(words.slice(0, 6), itemIndexes, active);
  };
  const addConnection = (words, itemIndexes, labelOverride = "") => {
    // A learned multi-word name may claim only saves that contain every word
    // in that name. This stops a shared tail word ("frame") from attaching an
    // unrelated headline to an established phrase such as Steam Frame. Named
    // fallbacks keep their own explicit evidence predicates.
    const normalizedOverride = patternTokens(labelOverride).join(" ");
    const requiresLiteralMembers = words.length >= 2 && (
      !labelOverride || normalizedOverride === words.join(" ")
    );
    const members = requiresLiteralMembers
      ? itemIndexes.filter((itemIndex) => {
        const titleWords = new Set(patternTokens(active[itemIndex].title));
        return words.every((word) => titleWords.has(word));
      })
      : itemIndexes;
    if (members.length < 3) return;
    // Keep a connection name readable even when a long headline offers several
    // overlapping fragments of the same repeated phrase.
    // When a repeated title has a canonical readable form, preserve it over a
    // token-only shorthand. This retains meaningful articles and title words.
    const label = labelOverride || canonicalTitleLabel(words.slice(0, 6), itemIndexes);
    const id = topicId(label);
    if (!topics.some((topic) => topic.id === id)) topics.push({ id, label, auto: true });
    members.forEach((itemIndex) => { active[itemIndex].topicId = id; });
  };
  const rank = (left, right) =>
    right.itemIndexes.length - left.itemIndexes.length ||
    leadingHeadlineMatches(right, active) - leadingHeadlineMatches(left, active) ||
    right.words.length - left.words.length ||
    left.phrase.localeCompare(right.phrase);

  // Repeated patterns are a tree, not a terminal label. Apple can split into
  // Apple OpenAI, which can then split again when a third recurring word appears.
  const subdivide = (pool, pathWords) => {
    let remaining = new Set(pool);
    while (remaining.size >= 3) {
      const currentPhrase = pathWords.join(" ");
      const options = candidates
        .map((candidate) => ({
          ...candidate,
          itemIndexes: candidate.itemIndexes.filter((itemIndex) => remaining.has(itemIndex)),
          overlapsParent: candidate.words.filter((word) => pathWords.includes(word)).length,
        }))
        .filter((candidate) => candidate.itemIndexes.length >= 3 && (
          candidate.itemIndexes.length < remaining.size || !currentPhrase.includes(candidate.phrase)
        ))
        .filter((candidate) => hasIdentityProof(candidate, candidates, active))
        // A two-word-or-longer repeated title is already a clear reader-facing
        // name. Do not fragment it into a smaller subtitle that reaches only
        // some of its saves; a child must literally extend and cover the whole
        // named parent. This keeps a franchise such as Fire Emblem together
        // even when individual headlines add different subtitle wording.
        .filter((candidate) => pathWords.length < 2 || (
          candidate.itemIndexes.length === remaining.size && candidate.phrase.includes(currentPhrase)
        ))
        // If every remaining headline shares a phrase, it can only be a child
        // when it genuinely extends the parent. This prevents an actor's name
        // from getting welded onto a film title just because both recur in the
        // same three headlines.
        .filter((candidate) =>
          candidate.itemIndexes.length < remaining.size || candidate.phrase.includes(currentPhrase)
        )
        // A child either extends its parent verbatim (Final Fantasy -> Final Fantasy
        // Resonance) or introduces mostly new language. This prevents a long title
        // from repeatedly re-attaching fragments such as "Auto VI Extended Look".
        .filter((candidate) => candidate.phrase.includes(currentPhrase) || candidate.overlapsParent * 2 < candidate.words.length)
        .sort(rank);
      const child = options[0];
      if (!child) break;
      subdivide(child.itemIndexes, extendPatternPath(pathWords, child.words));
      child.itemIndexes.forEach((itemIndex) => remaining.delete(itemIndex));
    }
    addConnection(pathWords, [...remaining]);
  };

  let unclaimed = new Set(active.map((_, itemIndex) => itemIndex));
  while (unclaimed.size >= 3) {
    const options = candidates
      .map((candidate) => ({ ...candidate, itemIndexes: candidate.itemIndexes.filter((itemIndex) => unclaimed.has(itemIndex)) }))
      .filter((candidate) => candidate.itemIndexes.length >= 3)
      .filter((candidate) => hasIdentityProof(candidate, candidates, active))
      .sort(rank);
    const root = options[0];
    if (!root) break;
    subdivide(root.itemIndexes, root.words);
    root.itemIndexes.forEach((itemIndex) => unclaimed.delete(itemIndex));
  }

  // Safety nets keep clear families out of Uncharted while they wait for enough
  // repeated wording to earn a sharper connection of their own.
  const addFallback = (label, predicate, reclaimFrom = []) => {
    const topicCounts = new Map();
    active.forEach((item) => {
      if (item.topicId) topicCounts.set(item.topicId, (topicCounts.get(item.topicId) || 0) + 1);
    });
    const topicById = new Map(topics.map((topic) => [topic.id, topic]));
    const canReclaim = (item) => {
      if (!item.topicId) return true;
      if (typeof reclaimFrom === "function") return reclaimFrom(item.topicId, topicById.get(item.topicId), topicCounts.get(item.topicId) || 0);
      return reclaimFrom.includes(item.topicId);
    };
    const matches = active
      .map((item, itemIndex) => ({ item, itemIndex }))
      .filter(({ item }) => canReclaim(item) && predicate(item))
      .map(({ itemIndex }) => itemIndex);
    if (matches.length < 3) return;
    const id = topicId(label);
    if (!topics.some((topic) => topic.id === id)) topics.push({ id, label, auto: true, generic: true });
    matches.forEach((itemIndex) => {
      active[itemIndex].topicId = id;
    });
  };
  const isGamingSource = (item) =>
    /^(Wario64|Overworld|Retro Game Corps|Gaming In The Wild|Digital Foundry|Game File|Nintendo Life)$/i.test(item.source || "");
  const applySafetyNets = () => {
    const broadOrWeakAppleHome = (currentTopicId, topic, count) =>
      currentTopicId === topicId("Apple") || Boolean(topic?.generic) || count < 3;
    // The specific Apple holders must run before the broad Apple home. This
    // lets an obvious family graduate out of Apple without hand-curating it.
    addFallback("Apple Events & Products", (item) =>
      /\bapple\b/i.test(item.title || "") &&
      /\b(event|launch|releases?|products?|product roadmap|expect)\b/i.test(item.title || ""),
      broadOrWeakAppleHome
    );
    addFallback("Apple Hardware", (item) =>
      /\b(macbook|mac mini|macos|vision pro|ipad|iphone)\b/i.test(item.title || "") &&
      /\b(oled|display|hardware|pro|mini|macos|vision)\b/i.test(item.title || ""),
      broadOrWeakAppleHome
    );
    addFallback("Apple Services", (item) =>
      /\b(apple tv|apple one|apple music|icloud|app store)\b/i.test(item.title || "") &&
      /\b(price|pricing|expensive|increase|subscription|streaming)\b/i.test(item.title || ""),
      broadOrWeakAppleHome
    );
    addFallback("Apple", (item) =>
      /\bapple|iphone|ipad|mac(?:book|os| mini| pro)?|vision pro|app store|tim cook|ternus|phil schiller\b/i.test(item.title || "")
    );
    addFallback("AI Roundup", (item) =>
      /\bai\b|openai|anthropic|claude|perplexity|chatgpt|artificial intelligence/i.test(item.title || "")
    );
    // Editorial holders sit between an exact connection and Gaming Roundup.
    // They need two independent signals per item and at least three saves to
    // appear, so they remain useful temporary homes instead of vague buckets.
    addFallback("Gaming Hardware", (item) => {
      const title = item.title || "";
      const signals = [
        isGamingSource(item),
        /\b(handheld|controllers?|console|cartridge|steam deck|accessory|device|hardware)\b/i.test(title),
        /\b(anbernic|retroid|konkr|ayaneo|abxylute|backbone)\b/i.test(title),
      ].filter(Boolean).length;
      return signals >= 2;
    });
    addFallback("Game Releases", (item) =>
      isGamingSource(item) &&
      /\b(release[sd]?|launch(?:es|ing)?|trailer|demo|remaster(?:ed)?|coming)\b/i.test(item.title || "") &&
      !/\blive tv|streaming service\b/i.test(item.title || "")
    );
    addFallback("Gaming Roundup", (item) =>
      /\b(game|games|gaming|xbox|playstation|ps[345]|nintendo|switch|steam|controllers?|geforce|capcom|mario|zelda|pokemon|handheld|console|gamescom|ace combat|witcher|path of exile)\b/i.test(item.title || "") ||
      isGamingSource(item)
    );
  };
  applySafetyNets();

  // A compact, article-led title owns every literal occurrence of that title,
  // regardless of which earlier connection first caught an individual save.
  // This is deliberately narrower than subject-word matching: a save has to
  // contain the entire repeated phrase. Limiting it to the compact title form
  // prevents a sequel, anniversary, or subtitle from overwriting its parent.
  candidates
    .filter((candidate) => candidate.words.length >= 2 && candidate.words.length <= 3)
    .filter((candidate) => {
      const meaningfulWords = candidate.words.filter((word) =>
        !PATTERN_STOP_WORDS.has(word) &&
        !PATTERN_GENERIC_WORDS.has(word) &&
        !PATTERN_QUANTITY_WORDS.has(word)
      );
      const modelNumberIndex = candidate.words.findIndex((word) => /^\d{1,2}$/.test(word));
      return meaningfulWords.length >= 2 && (
        candidate.words.at(-1).length >= 4 ||
        (modelNumberIndex > 0 && modelNumberIndex < candidate.words.length - 1)
      );
    })
    .sort(rank)
    .forEach((candidate) => {
      const canonicalLabel = canonicalTitleLabel(candidate.words, candidate.itemIndexes);
      const modelNumberIndex = candidate.words.findIndex((word) => /^\d{1,2}$/.test(word));
      const isModelTitle = modelNumberIndex > 0 && modelNumberIndex < candidate.words.length - 1;
      if (!canonicalLabel.startsWith("The ") && !isModelTitle) return;
      addConnection(candidate.words, candidate.itemIndexes, canonicalLabel);
    });

  // A full recurring title is stronger than the broad platform that happened
  // to catch it first. If "The Legend of Zelda" repeats while its shorter
  // Zelda saves sit in Nintendo or Gaming Roundup, reunite that named subject
  // under the full title. This is data-driven: it needs three literal title
  // matches plus a three-save single-word subject, and only reclaims broad or
  // broad-prefixed containers.
  const topicById = () => new Map(topics.map((topic) => [topic.id, topic]));
  const subjectCandidates = new Map(candidates
    .filter((candidate) => candidate.words.length === 1)
    .filter((candidate) => hasIdentityProof(candidate, candidates, active))
    .map((candidate) => [candidate.words[0], candidate]));
  const isBroadSubjectContainer = (topic, subject, canonicalLabel) => {
    if (!topic || topic.generic) return true;
    if (topic.label === canonicalLabel) return true;
    const labelWords = patternTokens(topic.label);
    return labelWords.includes(subject) && labelWords.some((word) => BROAD_TOPIC_WORDS.has(word));
  };
  candidates
    .filter((candidate) => candidate.words.length >= 2)
    .filter((candidate) => {
      const subject = candidate.words.at(-1);
      return subject.length >= 5 && !PATTERN_GENERIC_WORDS.has(subject) && !PATTERN_STOP_WORDS.has(subject);
    })
    .sort(rank)
    .forEach((candidate) => {
      const subject = candidate.words.at(-1);
      const subjectCandidate = subjectCandidates.get(subject);
      if (!subjectCandidate || subjectCandidate.itemIndexes.length < 3) return;
      const canonicalLabel = canonicalTitleLabel(candidate.words, candidate.itemIndexes);
      const lookup = topicById();
      if (!subjectCandidate.itemIndexes.every((itemIndex) =>
        isBroadSubjectContainer(lookup.get(active[itemIndex].topicId), subject, canonicalLabel)
      )) return;
      addConnection(
        candidate.words,
        subjectCandidate.itemIndexes,
        canonicalLabel
      );
    });

  // A connection can have a clear member even when that member does not repeat
  // the connection's eventual heading. A Steve Ballmer headline, for example,
  // belongs in Clippers when the existing group independently repeats both
  // Ballmer and NBA. This remains deliberately stricter than a single shared
  // word: an orphan needs two meaningful terms from one existing member.
  // Borrowing one term from each of two separate headlines creates false joins.
  const specificTopics = topics.filter((topic) => !topic.generic);
  const isStrongTerm = (word) =>
    !PATTERN_STOP_WORDS.has(word) &&
    !PATTERN_GENERIC_WORDS.has(word) &&
    !PATTERN_QUANTITY_WORDS.has(word);
  active.forEach((item) => {
    if (item.topicId) return;
    const itemTerms = new Set(patternTokens(item.title).filter(isStrongTerm));
    const matchedTopics = specificTopics.filter((topic) => {
      const members = active.filter((candidate) => candidate.topicId === topic.id);
      const matchesByMember = members.map((member) =>
        new Set(patternTokens(member.title).filter((word) => itemTerms.has(word) && isStrongTerm(word)))
      );
      return matchesByMember.some((matches) =>
        matches.size >= 2 && [...matches].some((word) => word.length >= 5)
      );
    }).map((topic) => topic.id);
    // Ambiguity is a reason to leave a find Uncharted, never to guess.
    if (matchedTopics.length === 1) item.topicId = matchedTopics[0];
  });

  // A broad platform connection is only a safety net. If a literal named
  // subject appears in three or more saves but was scattered across those
  // broad homes, promote that subject into its own connection. This lets
  // Zelda and Wolverine emerge without a hand-written rule, while preserving
  // established specific groups such as Apple OpenAI Lawsuit.
  const broadTopicIds = new Set(topics
    .filter((topic) => {
      const words = patternTokens(topic.label);
      return words.length && words.every((word) => BROAD_TOPIC_WORDS.has(word));
    })
    .map((topic) => topic.id));
  const promotableSubjects = candidates
    .filter((candidate) => candidate.words.length === 1)
    .filter((candidate) => hasIdentityProof(candidate, candidates, active))
    .filter((candidate) => candidate.words[0].length >= 5)
    .filter((candidate) => !BROAD_TOPIC_WORDS.has(candidate.words[0]))
    .filter((candidate) => candidate.itemIndexes.every((itemIndex) =>
      broadTopicIds.has(active[itemIndex].topicId)
    ))
    .sort(rank);
  promotableSubjects.forEach((candidate) => {
    const memberTopics = candidate.itemIndexes.map((itemIndex) => active[itemIndex].topicId);
    if (
      memberTopics.every((topicId) => broadTopicIds.has(topicId))
    ) addConnection(candidate.words, candidate.itemIndexes);
  });

  // Promotion can leave a former broad connection below the three-save
  // threshold. Return those remaining finds to the appropriate safety net
  // instead of keeping a misleading two-item connection alive.
  const counts = new Map();
  active.forEach((item) => {
    if (item.topicId) counts.set(item.topicId, (counts.get(item.topicId) || 0) + 1);
  });
  const viableTopicIds = new Set(topics
    .filter((topic) => (counts.get(topic.id) || 0) >= 3)
    .map((topic) => topic.id));
  active.forEach((item) => {
    if (item.topicId && !viableTopicIds.has(item.topicId)) delete item.topicId;
  });
  topics.splice(0, topics.length, ...topics.filter((topic) => viableTopicIds.has(topic.id)));
  applySafetyNets();

  // After a more specific subject is promoted, re-check the broad residual.
  // For example, moving Zelda out of Nintendo Directs and Nintendo Switch
  // must not leave the remaining five Nintendo saves stranded in Gaming
  // Roundup. This only restores an exact, three-save umbrella phrase.
  const genericTopicIds = new Set(topics
    .filter((topic) => topic.generic)
    .map((topic) => topic.id));
  candidates
    .filter((candidate) => candidate.words.length === 1)
    .filter((candidate) => hasIdentityProof(candidate, candidates, active))
    .filter((candidate) => RESIDUAL_UMBRELLA_SUBJECTS.has(candidate.words[0]))
    .sort(rank)
    .forEach((candidate) => {
      const residualIndexes = candidate.itemIndexes.filter((itemIndex) =>
        genericTopicIds.has(active[itemIndex].topicId)
      );
      addConnection(candidate.words, residualIndexes);
    });

  // Run literal-title reunification last. Broader safety nets and residual
  // passes are useful while discovering connections, but they must never pull
  // a fully proven title back apart afterward.
  candidates
    .filter((candidate) => candidate.words.length >= 2 && candidate.words.length <= 3)
    .filter((candidate) => {
      const meaningfulWords = candidate.words.filter((word) =>
        !PATTERN_STOP_WORDS.has(word) &&
        !PATTERN_GENERIC_WORDS.has(word) &&
        !PATTERN_QUANTITY_WORDS.has(word)
      );
      const modelNumberIndex = candidate.words.findIndex((word) => /^\d{1,2}$/.test(word));
      return meaningfulWords.length >= 2 && (
        candidate.words.at(-1).length >= 4 ||
        (modelNumberIndex > 0 && modelNumberIndex < candidate.words.length - 1)
      );
    })
    .sort(rank)
    .forEach((candidate) => {
      const canonicalLabel = canonicalTitleLabel(candidate.words, candidate.itemIndexes);
      const modelNumberIndex = candidate.words.findIndex((word) => /^\d{1,2}$/.test(word));
      const isModelTitle = modelNumberIndex > 0 && modelNumberIndex < candidate.words.length - 1;
      if (!canonicalLabel.startsWith("The ") && !isModelTitle) return;
      addConnection(candidate.words, candidate.itemIndexes, canonicalLabel);
    });

  // Once a full, article-led title has earned a package, it is the clearest
  // public name for that subject. Bring in only the nearby saves that were
  // caught by a generic holder or a broad-prefixed sibling ("Nintendo Zelda"
  // -> "The Legend of Zelda"). This is intentionally not a loose keyword
  // merge: the established title must appear literally in at least three
  // headlines, and a reclaimed sibling must contain both the same subject and
  // a recognized broad platform word.
  const consolidateEstablishedTitles = () => {
    const lookup = new Map(topics.map((topic) => [topic.id, topic]));
    topics
      .filter((topic) => /^The\s+/i.test(topic.label || ""))
      .forEach((topic) => {
        const titleWords = patternTokens(topic.label);
        const subject = titleWords.at(-1);
        if (!subject || subject.length < 5) return;
        const literalTitleMatches = active.filter((item) => {
          const words = patternTokens(item.title).join(" ");
          return (` ${words} `).includes(` ${titleWords.join(" ")} `);
        }).length;
        if (literalTitleMatches < 3) return;
        active.forEach((item) => {
          if (!item.topicId || item.topicId === topic.id) return;
          const current = lookup.get(item.topicId);
          const currentWords = patternTokens(current?.label);
          const isBroadSibling = Boolean(current?.generic) || (
            currentWords.includes(subject) &&
            currentWords.some((word) => BROAD_TOPIC_WORDS.has(word))
          );
          if (isBroadSibling && patternTokens(item.title).includes(subject)) {
            item.topicId = topic.id;
          }
        });
      });
  };
  consolidateEstablishedTitles();

  // A compact named phrase can be scattered across temporary platform homes
  // before the classifier has enough confidence to surface it. Once the same
  // two-word name occurs in three titles, it owns those saves when every
  // current home is only a broad/generic platform container. This lets a
  // durable title such as Fire Emblem outrank Gaming Roundup, Nintendo, or a
  // platform mashup, without merging unrelated stories through one word.
  const promoteRepeatedNamedPhrases = () => {
    const lookup = new Map(topics.map((topic) => [topic.id, topic]));
    const membersByTopic = new Map();
    active.forEach((item, itemIndex) => {
      if (!item.topicId) return;
      if (!membersByTopic.has(item.topicId)) membersByTopic.set(item.topicId, []);
      membersByTopic.get(item.topicId).push(itemIndex);
    });
    const isBroadContainer = (topic, candidate) => {
      if (!topic || topic.generic) return true;
      const words = patternTokens(topic.label);
      if (words.length > 0 && words.every((word) =>
        BROAD_TOPIC_WORDS.has(word) || /^\d{1,2}$/.test(word)
      )) return true;
      // A one-word topic is only a placeholder when every one of its members
      // literally carries the stronger two-word name. This prevents "Fortune"
      // from surviving beside the fully proven "Fire Emblem" title, while a
      // real independent subject remains untouched.
      const members = membersByTopic.get(topic.id) || [];
      const phrase = candidate.words.join(" ");
      return words.length === 1 && members.length >= 3 && members.every((itemIndex) =>
        (` ${patternTokens(active[itemIndex].title).join(" ")} `).includes(` ${phrase} `)
      );
    };
    candidates
      .filter((candidate) => candidate.words.length === 2)
      .filter((candidate) => candidate.words.every((word) =>
        word.length >= 3 &&
        !PATTERN_STOP_WORDS.has(word) &&
        !PATTERN_GENERIC_WORDS.has(word) &&
        !PATTERN_QUANTITY_WORDS.has(word)
      ))
        .sort(rank)
      .forEach((candidate) => {
        if (!candidate.itemIndexes.every((itemIndex) =>
          isBroadContainer(lookup.get(active[itemIndex].topicId), candidate)
        )) return;
        addConnection(
          candidate.words,
          candidate.itemIndexes,
          naturalPatternLabel(candidate.words, candidate.itemIndexes, active)
        );
      });

    // Some names are separated by ordinary headline wording ("Kojima's
    // project PHYSINT") and therefore never form a literal bigram. Promote
    // only an unambiguous pair of distinctive one-word subjects when the same
    // exact three saves carry both words and all three are still in temporary
    // broad homes. This is evidence for one story, not a keyword fallback.
    const sharedSubjects = new Map();
    candidates
      .filter((candidate) => candidate.words.length === 1)
      .filter((candidate) => candidate.words[0].length >= 5)
      .filter((candidate) => !PATTERN_STOP_WORDS.has(candidate.words[0]) && !PATTERN_GENERIC_WORDS.has(candidate.words[0]))
      .filter((candidate) => candidate.itemIndexes.length === 3)
      .forEach((candidate) => {
        const key = candidate.itemIndexes.join(",");
        const matches = sharedSubjects.get(key) || [];
        matches.push(candidate);
        sharedSubjects.set(key, matches);
      });
    sharedSubjects.forEach((matches) => {
      if (matches.length !== 2) return;
      const [left, right] = matches;
      if (!left.itemIndexes.every((itemIndex) =>
        isBroadContainer(lookup.get(active[itemIndex].topicId), left)
      )) return;
      const words = [left.words[0], right.words[0]];
      addConnection(words, left.itemIndexes, naturalPatternLabel(words, left.itemIndexes, active));
    });
  };
  promoteRepeatedNamedPhrases();

  // The recursive discovery pass can still choose a shared subtitle before it
  // sees the recurring name at the front of a headline ("Fortune's Weave"
  // instead of "Fire Emblem"). Reclaim that case only when a two-word phrase
  // is literally repeated at the start of at least three headlines and no
  // longer, equally complete name owns the same set. This is a deliberately
  // narrow tie-breaker: it promotes a demonstrated name, not a loose keyword.
  const promoteDominantLeadingBigrams = () => {
    const namedCandidates = candidates.filter((candidate) =>
      candidate.words.length >= 2 && candidate.words.length <= 4 &&
      candidate.words.every((word) =>
        word.length >= 3 &&
        !PATTERN_STOP_WORDS.has(word) &&
        !PATTERN_GENERIC_WORDS.has(word) &&
        !PATTERN_QUANTITY_WORDS.has(word)
      )
    );
    const containsEvery = (container, contained) =>
      contained.every((itemIndex) => container.includes(itemIndex));
    namedCandidates
      .filter((candidate) => candidate.words.length === 2)
      .filter((candidate) => leadingHeadlineMatches(candidate, active) >= 3)
      .sort((left, right) =>
        leadingHeadlineMatches(right, active) - leadingHeadlineMatches(left, active) ||
        right.itemIndexes.length - left.itemIndexes.length ||
        left.phrase.localeCompare(right.phrase)
      )
      .forEach((candidate) => {
        const coveredByCompleteLongerName = namedCandidates.some((other) =>
          other.words.length > candidate.words.length &&
          other.phrase.includes(candidate.phrase) &&
          containsEvery(other.itemIndexes, candidate.itemIndexes) &&
          leadingHeadlineMatches(other, active) >= 3
        );
        if (coveredByCompleteLongerName) return;
        const beatenByClearerLeadingName = namedCandidates.some((other) =>
          other !== candidate &&
          other.words.length === candidate.words.length &&
          containsEvery(other.itemIndexes, candidate.itemIndexes) &&
          leadingHeadlineMatches(other, active) > leadingHeadlineMatches(candidate, active)
        );
        if (beatenByClearerLeadingName) return;
        addConnection(
          candidate.words,
          candidate.itemIndexes,
          naturalPatternLabel(candidate.words, candidate.itemIndexes, active)
        );
      });
  };
  promoteDominantLeadingBigrams();

  // Safety-net labels are useful while the archive is still learning a subject,
  // but they must not become competing variants of the same named Apple
  // subject. A literal child (iPhone Duo) owns its Apple-prefixed variants;
  // distinct fallback lanes such as hardware and events remain separate so a
  // broad Apple bucket never becomes a meaningless catch-all.
  const consolidateAppleFallbacks = () => {
    const hasPhrase = (words, phrase) => {
      if (phrase.length > words.length) return false;
      return words.some((_, index) => words.slice(index, index + phrase.length).join(" ") === phrase.join(" "));
    };
    const appleTopics = topics.filter((topic) => patternTokens(topic.label).at(0) === "apple");
    const literalChildren = topics.filter((topic) => {
      const words = patternTokens(topic.label);
      return !topic.generic && words.length >= 2 && words.at(0) !== "apple";
    });
    appleTopics.forEach((source) => {
      const sourceWords = patternTokens(source.label);
      const target = literalChildren
        .filter((candidate) => hasPhrase(sourceWords, patternTokens(candidate.label)))
        .sort((left, right) => patternTokens(right.label).length - patternTokens(left.label).length)[0];
      if (!target) return;
      const targetWords = patternTokens(target.label);
      active.forEach((item) => {
        if (item.topicId === source.id && hasPhrase(patternTokens(item.title), targetWords)) item.topicId = target.id;
      });
    });
  };
  consolidateAppleFallbacks();

  // Repeated product names with internal capitals supply identity evidence
  // even when headline fragments and broad platforms previously won.
  const broadLabels = /^(?:apple|ai|apple ai|smart home|apple home|apple hardware|apple events & products|gaming roundup|game releases)$/i;
  candidates.filter(candidate => candidate.words.length === 1).forEach(candidate => {
    const word = candidate.words[0];
    const members = candidate.itemIndexes.filter(index => {
      const topic = topics.find(t => t.id === active[index].topicId);
      return !topic || topic.generic || broadLabels.test(topic.label);
    });
    const named = members.filter(index =>
      String(active[index].title).split(/[^A-Za-z0-9]+/).some(token =>
        token.length >= 6 && /[a-z][A-Z]/.test(token) && normalizePatternToken(token.toLowerCase()) === word
      )
    );
    if (named.length >= 3) addConnection(candidate.words, members);
  });

  // Later promotion and consolidation passes can move members out of a topic
  // that was valid when it was first created. Enforce the evidence floor one
  // final time at the public boundary: a connection never survives with fewer
  // than three current saves. Those displaced saves remain available to the
  // safety nets below, or truthfully stay Uncharted rather than posing as a
  // thin connection.
  const enforceFinalEvidenceFloor = () => {
    const finalCounts = new Map();
    active.forEach((item) => {
      if (item.topicId) finalCounts.set(item.topicId, (finalCounts.get(item.topicId) || 0) + 1);
    });
    active.forEach((item) => {
      if (item.topicId && (finalCounts.get(item.topicId) || 0) < 3) delete item.topicId;
    });
    topics.splice(0, topics.length, ...topics.filter((topic) =>
      (finalCounts.get(topic.id) || 0) >= 3
    ));
  };
  enforceFinalEvidenceFloor();
  applySafetyNets();
  enforceFinalEvidenceFloor();

  // Topic records are created while candidates compete. If a stronger package
  // takes every member, drop the now-empty record instead of exposing a ghost
  // heading such as an empty model connection in the UI or ticker.
  const usedTopicIds = new Set(active.map((item) => item.topicId).filter(Boolean));
  topics.splice(0, topics.length, ...topics.filter((topic) => usedTopicIds.has(topic.id)));
  return { items, topics };
}

// Connections are evidence; packages are the reader-facing organization of that
// evidence. A package is earned only when two or more established connections
// share a literal root phrase (Apple TV + Apple OpenAI -> Apple, iPhone 18 Pro
// + iPhone Duo -> iPhone). This keeps broad holders useful without inventing
// editorial categories or pulling unrelated saves together.
function buildConnectionPackages(items, topics) {
  const membersByTopic = new Map(topics.map((topic) => [topic.id, items.filter((item) => item.topicId === topic.id)]));
  const roots = new Map();
  topics.forEach((topic) => {
    const words = patternTokens(topic.label).filter((word) => !PATTERN_GENERIC_WORDS.has(word));
    for (let length = 1; length <= Math.min(2, words.length); length += 1) {
      const phrase = words.slice(0, length).join(" ");
      if (!phrase || phrase === "the") continue;
      // A package is a real connection with children, never a shared headline
      // fragment. Without this guard, partial names such as "Apple iPhone" or
      // "Grand Theft" become misleading containers beside their true parent.
      const hasParent = topics.some((candidate) =>
        patternTokens(candidate.label).filter((word) => !PATTERN_GENERIC_WORDS.has(word)).join(" ") === phrase
      );
      if (!hasParent) continue;
      if (!roots.has(phrase)) roots.set(phrase, new Set());
      roots.get(phrase).add(topic.id);
    }
  });
  const candidates = [...roots.entries()]
    .map(([phrase, ids]) => ({ phrase, ids: [...ids] }))
    .filter((candidate) => candidate.ids.length >= 2)
    .sort((left, right) => right.phrase.split(" ").length - left.phrase.split(" ").length || left.phrase.localeCompare(right.phrase));
  const packages = [];
  const assigned = new Set();
  candidates.forEach((candidate) => {
    const topicIds = candidate.ids.filter((id) => !assigned.has(id));
    if (topicIds.length < 2) return;
    const phraseWords = candidate.phrase.split(" ");
    const label = readablePatternLabel(candidate.phrase);
    const count = topicIds.reduce((total, id) => total + (membersByTopic.get(id)?.length || 0), 0);
    if (count < 6) return;
    const id = `package-${topicId(label).replace(/^topic-/, "")}`;
    packages.push({ id, label, topicIds, count });
    topicIds.forEach((topicIdValue) => assigned.add(topicIdValue));
  });
  const packageByTopic = new Map();
  packages.forEach((pkg) => pkg.topicIds.forEach((id) => packageByTopic.set(id, pkg)));
  return {
    packages: packages.sort((left, right) => right.count - left.count || left.label.localeCompare(right.label)),
    items: items.map((item) => ({ ...item, packageId: packageByTopic.get(item.topicId)?.id || "" })),
  };
}

function briefSignature(items) {
  return items.slice().sort((a, b) => String(b.date_saved || "").localeCompare(String(a.date_saved || "")))
    .slice(0, 12).map((item) => `${item.url}|${item.title}`).join("\n");
}

async function refreshConnectionBriefs(env, items, topics) {
  if (!env.AI) return;
  const stored = await archivePath(env, "/briefs");
  const existing = stored.ok ? await stored.json() : {};
  const labels = new Map(topics.map((topic) => [topic.id, topic.label]));
  const groups = new Map();
  items.forEach((item) => {
    if (!item.topicId || !labels.has(item.topicId)) return;
    if (!groups.has(item.topicId)) groups.set(item.topicId, []);
    groups.get(item.topicId).push(item);
  });
  const updates = {};
  for (const [id, members] of groups) {
    if (members.length < 3) continue;
    const signature = briefSignature(members);
    if (existing[id]?.signature === signature) continue;
    const label = labels.get(id);
    const headlines = members.slice().sort((a, b) => String(b.date_saved || "").localeCompare(String(a.date_saved || "")))
      .slice(0, 12).map((item) => `- ${cleanTitleFragments(item.title)}`).join("\n");
    const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      prompt: `Write one neutral, factual master sentence (maximum 32 words) summarizing this saved-news connection. Use only the headlines. Do not mention sources, links, counts, or uncertainty. Connection: ${label}\nHeadlines:\n${headlines}`,
    });
    const summary = String(result?.response || "").replace(/\s+/g, " ").trim().replace(/^[-•\s]+/, "").slice(0, 280);
    if (summary) updates[id] = { signature, summary, updatedAt: new Date().toISOString() };
  }
  if (Object.keys(updates).length) {
    await archivePath(env, "/briefs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(updates) });
  }
}

export class ExtractorArchive {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    let items = await this.ctx.storage.get("items") || [];
    let topics = await this.ctx.storage.get("topics") || [];
    const url = new URL(request.url);
    if (url.pathname === "/youtube/oauth-state") {
      if (request.method === "POST") {
        const { state } = await request.json();
        if (!state) return new Response("Missing state", { status: 400 });
        await this.ctx.storage.put("youtubeOAuthState", { value: state, createdAt: Date.now() });
        return Response.json({ ok: true });
      }
      const pending = await this.ctx.storage.get("youtubeOAuthState");
      const state = url.searchParams.get("state");
      const valid = Boolean(pending?.value && pending.value === state && Date.now() - pending.createdAt < 10 * 60 * 1000);
      if (valid) await this.ctx.storage.delete("youtubeOAuthState");
      return Response.json({ valid });
    }
    if (url.pathname === "/youtube/token") {
      if (request.method === "PUT") {
        const { refreshToken } = await request.json();
        if (!refreshToken) return new Response("Missing refresh token", { status: 400 });
        await this.ctx.storage.put("youtubeRefreshToken", refreshToken);
        return Response.json({ ok: true });
      }
      return Response.json({ refreshToken: await this.ctx.storage.get("youtubeRefreshToken") || "" });
    }
    if (url.pathname === "/youtube/seen" && request.method === "POST") {
      const { ids = [], now = new Date().toISOString() } = await request.json();
      const seen = await this.ctx.storage.get("youtubeSeen") || {};
      for (const id of ids) if (id && !seen[id]) seen[id] = now;
      await this.ctx.storage.put("youtubeSeen", seen);
      return Response.json({ seen });
    }
    if (url.pathname === "/briefs") {
      if (request.method === "POST") {
        const incoming = await request.json();
        const briefs = await this.ctx.storage.get("briefs") || {};
        await this.ctx.storage.put("briefs", { ...briefs, ...incoming });
        return Response.json({ ok: true });
      }
      return Response.json(await this.ctx.storage.get("briefs") || {});
    }
    if (url.pathname === "/hyperfuel") {
      const month = (url.searchParams.get("month") || chicagoDate(new Date()).slice(0, 7)).match(/^\d{4}-\d{2}$/)?.[0];
      if (!month) return new Response("Invalid month", { status: 400 });
      const fuel = await this.ctx.storage.get(`hyperfuel:${month}`) || { count: 0, events: [] };
      return Response.json({ month, count: Number(fuel.count || 0), updatedAt: fuel.events.at(-1)?.created || "" });
    }
    if (url.pathname === "/stripe/webhook" && request.method === "POST") {
      const event = await request.json();
      if (!event?.id || !event?.type || !event?.data?.object) return new Response("Invalid Stripe event", { status: 400 });
      const object = event.data.object;
      const paymentLinks = hyperfuelPaymentLinks(this.env);
      if (!paymentLinks.size) return new Response("Hyperfuel payment links are not configured", { status: 503 });
      if (event.type === "checkout.session.completed") {
        if (!paymentLinks.has(String(object.payment_link || ""))) return Response.json({ accepted: false });
        if (object.mode === "payment" && object.payment_status === "paid") {
          return Response.json(await recordHyperfuel(this.ctx.storage, { id: event.id, created: event.created, source: "one-time" }));
        }
        if (object.mode === "subscription" && object.subscription) {
          await this.ctx.storage.put(`stripe:subscription:${object.subscription}`, true);
          const pendingKey = `stripe:pending-subscription:${object.subscription}`;
          const pending = await this.ctx.storage.get(pendingKey) || [];
          const credited = [];
          for (const invoice of pending) credited.push(await recordHyperfuel(this.ctx.storage, invoice));
          if (pending.length) await this.ctx.storage.delete(pendingKey);
          return Response.json({ accepted: true, subscription: true, credited: credited.length });
        }
        return Response.json({ accepted: false });
      }
      if (event.type === "invoice.paid" && object.subscription) {
        const fuel = { id: event.id, created: event.created, source: "membership" };
        if (await this.ctx.storage.get(`stripe:subscription:${object.subscription}`)) return Response.json(await recordHyperfuel(this.ctx.storage, fuel));
        const pendingKey = `stripe:pending-subscription:${object.subscription}`;
        const pending = await this.ctx.storage.get(pendingKey) || [];
        await this.ctx.storage.put(pendingKey, [...pending.filter((invoice) => invoice.id !== fuel.id), fuel].slice(-8));
        return Response.json({ accepted: true, pending: true });
      }
      return Response.json({ accepted: false });
    }
    if (request.method === "POST") {
      const incoming = await request.json();
      if (url.searchParams.has("replaceYoutube")) {
        const currentYouTubeUrls = new Set(
          incoming
            .filter((item) => item?.type === "youtube" && item?.url)
            .map((item) => item.url)
        );
        // The YouTube source is a current-day surface, not a permanent
        // archive. Remove older imported videos while leaving saved links
        // and all non-YouTube Extractor history untouched.
        items = items.filter((item) =>
          item?.type !== "youtube" || currentYouTubeUrls.has(item.url)
        );
      }
      const byUrl = new Map(items.map((item) => [item.url, item]));
      for (const item of incoming) {
        if (!item?.url) continue;
        byUrl.set(item.url, item);
      }
      items = [...byUrl.values()].sort((a, b) =>
        String(b.date_saved || b.date_published || "")
          .localeCompare(String(a.date_saved || a.date_published || ""))
      );
      ({ items, topics } = buildPatternConnections(items));
      await this.ctx.storage.put({ items, topics });
    }
    const topicMap = new Map(topics.map((topic) => [topic.id, topic.label]));
    const visibleItems = items.filter((item) => !isRawLinkPromo(item));
    const packaged = buildConnectionPackages(items, topics);
    return Response.json({
      title: "Extractor",
      topics,
      packages: packaged.packages,
      items: visibleItems.map((item) => ({ ...item, packageId: packaged.items.find((candidate) => candidate.url === item.url)?.packageId || "", topic: topicMap.get(item.topicId) || item.title || "Individual Find" })),
    });
  }
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin);
    const requestUrl = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (requestUrl.pathname === "/stripe/webhook") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
      if (!env.STRIPE_WEBHOOK_SECRET) return new Response("Stripe webhook is not configured", { status: 503 });
      const payload = await request.text();
      if (!await validStripeSignature(payload, request.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET)) return new Response("Invalid Stripe signature", { status: 400 });
      let event;
      try { event = JSON.parse(payload); } catch (_) { return new Response("Invalid Stripe payload", { status: 400 }); }
      const response = await archivePath(env, "/stripe/webhook", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(event) });
      return new Response(await response.text(), { status: response.status, headers: { "Content-Type": "application/json; charset=utf-8" } });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { ...cors, Allow: "GET, HEAD, OPTIONS" },
      });
    }

    try {
      if (requestUrl.pathname === "/hyperfuel") {
        const fuel = await archivePath(env, `/hyperfuel${requestUrl.search}`);
        return new Response(await fuel.text(), { status: fuel.status, headers: { ...cors, "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" } });
      }
      if (requestUrl.pathname === "/youtube/connect") {
        if (!env.YOUTUBE_CLIENT_ID || !env.YOUTUBE_CLIENT_SECRET || !env.YOUTUBE_REDIRECT_URI) {
          return new Response("YouTube is not configured yet.", { status: 503, headers: cors });
        }
        const state = crypto.randomUUID();
        const stored = await archivePath(env, "/youtube/oauth-state", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ state }),
        });
        if (!stored.ok) throw new Error("Could not prepare YouTube connection");
        const authorization = new URL("https://accounts.google.com/o/oauth2/v2/auth");
        authorization.search = new URLSearchParams({
          client_id: env.YOUTUBE_CLIENT_ID,
          redirect_uri: env.YOUTUBE_REDIRECT_URI,
          response_type: "code",
          scope: YOUTUBE_SCOPE,
          access_type: "offline",
          prompt: "consent",
          state,
        });
        return Response.redirect(authorization.toString(), 302);
      }
      if (requestUrl.pathname === "/youtube/callback") {
        const code = requestUrl.searchParams.get("code");
        const state = requestUrl.searchParams.get("state");
        const stateCheck = await archivePath(env, `/youtube/oauth-state?state=${encodeURIComponent(state || "")}`);
        const { valid } = stateCheck.ok ? await stateCheck.json() : { valid: false };
        if (!code || !valid) return new Response("That YouTube connection link has expired. Start again from /youtube/connect.", { status: 400, headers: cors });
        const exchange = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: env.YOUTUBE_CLIENT_ID,
            client_secret: env.YOUTUBE_CLIENT_SECRET,
            redirect_uri: env.YOUTUBE_REDIRECT_URI,
            grant_type: "authorization_code",
          }),
        });
        const tokens = await exchange.json();
        if (!exchange.ok || !tokens.refresh_token) {
          throw new Error("Google did not return a YouTube refresh token");
        }
        const saved = await archivePath(env, "/youtube/token", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: tokens.refresh_token }),
        });
        if (!saved.ok) throw new Error("Could not save YouTube connection");
        ctx.waitUntil(syncArchive(env).catch((error) => console.error("YouTube archive refresh failed", error)));
        return new Response("YouTube Likes are connected to Extractor. You can close this tab.", {
          headers: { ...cors, "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      const recluster = requestUrl.searchParams.has("recluster");
      const syncNow = requestUrl.searchParams.has("sync");
      let payload;
      if (recluster) {
        payload = await syncArchive(env, true);
      } else if (syncNow) {
        payload = await syncArchive(env, false);
      } else {
        const archived = await archiveRequest(env);
        if (!archived.ok) throw new Error("Archive unavailable");
        payload = await archived.json();
        ctx.waitUntil(syncArchive(env).catch((error) => console.error("Background archive refresh failed", error)));
      }
      const { items, topics } = payload;
      // The homepage ticker needs connection metadata, not the full archive.
      // Keeping this response tiny avoids a large download and duplicate
      // client-side clustering on every homepage visit.
      if (requestUrl.searchParams.has("ticker")) {
        const topicIds = new Set(topics.filter((topic) => topic.auto).map((topic) => topic.id));
        const counts = new Map();
        items.forEach((item) => {
          if (!item.topicId || !topicIds.has(item.topicId) || isRawLinkPromo(item)) return;
          const label = item.topic || "Connection";
          const current = counts.get(label) || { label, count: 0, newest: "" };
          current.count += 1;
          const saved = String(item.date_saved || item.date_published || "");
          if (saved > current.newest) current.newest = saved;
          counts.set(label, current);
        });
        const connections = [...counts.values()].sort((left, right) =>
          right.newest.localeCompare(left.newest) || right.count - left.count || left.label.localeCompare(right.label)
        );
        return new Response(JSON.stringify({ connections }), {
          status: 200,
          headers: { ...cors, "Cache-Control": "no-store, no-cache, must-revalidate", "Content-Type": "application/json; charset=utf-8" },
        });
      }
      ctx.waitUntil(refreshConnectionBriefs(env, items, topics).catch((error) => console.error("Connection brief refresh failed", error)));
      const briefResponse = await archivePath(env, "/briefs");
      const briefs = briefResponse.ok ? await briefResponse.json() : {};
      return new Response(JSON.stringify({ title: "Extractor", topics, briefs, items }), {
        status: 200,
        headers: {
          ...cors,
          "Cache-Control": "no-store, no-cache, must-revalidate",
          "Content-Type": "application/json; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      const archived = await archiveRequest(env);
      return new Response(await archived.text(), {
        status: archived.ok ? 200 : 502,
        headers: {
          ...cors,
          "Cache-Control": "no-store",
          "Content-Type": "application/json; charset=utf-8",
          "X-Extractor-Fallback": "archive",
        },
      });
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(syncArchive(env));
  },
};
