(function () {
  var ticker = document.getElementById("home-connection-ticker-track");
  var endpoint = window.NASHP_EXTRACTOR_ENDPOINT || "https://nashp-reeder-feed.nashp-8f3.workers.dev/";
  if (!ticker) return;
  // A compact last-known signal keeps this strip useful if a phone blocks the
  // cross-site refresh. A successful refresh below immediately replaces it.
  var fallbackConnections = ["OpenAI", "Xbox", "iOS 27", "iPhone Duo", "Apple Announces", "Apple TV", "John Ternus", "iPhone 18 Pro", "Gaming Roundup", "Nintendo"].map(function (label) { return { label: label }; });

  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (entries) {
      ticker.classList.toggle("is-visible", Boolean(entries[0] && entries[0].isIntersecting));
    }, { threshold: 0.05 }).observe(ticker.parentElement);
  } else {
    ticker.classList.add("is-visible");
  }

  function connectionAnchor(label) {
    return "connection-" + String(label || "connection")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  }

  function savedTime(item) {
    var time = new Date(item.date_saved || item.date_published).getTime();
    return Number.isNaN(time) ? 0 : time;
  }

  // Keep the homepage surface on the exact same connection vocabulary as
  // Extractor. The Worker is intentionally permissive while it learns; this
  // client rule prevents broad Apple variants and orphaned suffixes from
  // becoming duplicate reader-facing connections.
  function validConnectionSurface(item) {
    if (item.topic === "Apple") {
      return /\b(?:apple|iphone|ipad|macbook|macos|imac|vision pro|app store|tim cook|ternus|schiller)\b/i.test(item.title || "");
    }
    return true;
  }

  function promoteFullyOwnedSuffixTopics(items, topics) {
    var topicById = new Map((topics || []).map(function (topic) { return [topic.id, topic]; }));
    var groups = new Map();
    items.forEach(function (item) {
      var topic = topicById.get(item.topicId);
      var label = String(item.topic || "").trim();
      if (!topic || !topic.auto || !/^[a-z]+$/i.test(label)) return;
      if (!groups.has(item.topicId)) groups.set(item.topicId, { label: label, items: [] });
      groups.get(item.topicId).items.push(item);
    });
    var replacements = new Map();
    groups.forEach(function (group, topicId) {
      if (group.items.length < 3) return;
      var subject = group.label.toLowerCase();
      var prefixes = group.items.map(function (item) {
        var words = String(item.title || "").toLowerCase().match(/[a-z0-9]+/g) || [];
        var index = words.indexOf(subject);
        return index > 0 && words[index - 1].length > 2 ? words[index - 1] : "";
      });
      if (!prefixes.every(Boolean) || new Set(prefixes).size !== 1) return;
      var phrase = prefixes[0] + " " + subject;
      if (!group.items.every(function (item) {
        return (" " + String(item.title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() + " ")
          .includes(" " + phrase + " ");
      })) return;
      replacements.set(topicId, {
        id: "topic-" + phrase.replace(/[^a-z0-9]+/g, "-"),
        label: phrase.split(" ").map(function (word) { return word.charAt(0).toUpperCase() + word.slice(1); }).join(" ")
      });
    });
    if (!replacements.size) return { items: items, topics: topics };
    return {
      items: items.map(function (item) {
        var replacement = replacements.get(item.topicId);
        return replacement ? Object.assign({}, item, { topicId: replacement.id, topic: replacement.label }) : item;
      }),
      topics: topics.map(function (topic) {
        var replacement = replacements.get(topic.id);
        return replacement ? Object.assign({}, topic, replacement) : topic;
      })
    };
  }

  function promoteRepeatedNamedPhrases(items, topics) {
    var topicById = new Map((topics || []).map(function (topic) { return [topic.id, topic]; }));
    var ignored = new Set(["the", "and", "for", "from", "with", "this", "that", "your", "have", "will", "into", "about", "after", "over", "more", "than"]);
    var mentions = new Map();
    var phrasesFor = function (title) {
      var words = String(title || "").toLowerCase().match(/[a-z]+/g) || [];
      var phrases = [];
      for (var index = 0; index < words.length - 1; index += 1) {
        if (words[index].length < 3 || words[index + 1].length < 3 || ignored.has(words[index])) continue;
        phrases.push(words[index] + " " + words[index + 1]);
      }
      return phrases;
    };
    items.forEach(function (item, index) {
      var topic = topicById.get(item.topicId);
      if (!topic || !topic.auto) return;
      new Set(phrasesFor(item.title)).forEach(function (phrase) {
        if (!mentions.has(phrase)) mentions.set(phrase, new Set());
        mentions.get(phrase).add(index);
      });
    });
    var supported = new Map(Array.from(mentions).filter(function (entry) { return entry[1].size >= 3; }));
    if (!supported.size) return { items: items, topics: topics };
    var generated = new Map();
    var normalizedItems = items.map(function (item) {
      var topic = topicById.get(item.topicId);
      if (!topic || !topic.auto) return item;
      var choice = phrasesFor(item.title)
        .filter(function (phrase) { return supported.has(phrase); })
        .sort(function (left, right) { return supported.get(right).size - supported.get(left).size; })[0];
      if (!choice || String(topic.label || item.topic || "").toLowerCase().includes(choice)) return item;
      var label = choice.split(" ").map(function (word) { return word.charAt(0).toUpperCase() + word.slice(1); }).join(" ");
      var replacement = { id: "topic-" + choice.replace(/\s+/g, "-"), label: label, auto: true };
      generated.set(replacement.id, replacement);
      return Object.assign({}, item, { topicId: replacement.id, topic: replacement.label });
    });
    if (!generated.size) return { items: items, topics: topics };
    return { items: normalizedItems, topics: topics.concat(Array.from(generated.values())) };
  }

  function consolidateAppleSurface(items) {
    var topics = Array.from(new Set(items.map(function (item) { return String(item.topic || ""); })));
    var literalChildren = topics.filter(function (label) {
      return !/^apple\b/i.test(label) && label.trim().split(/\s+/).length >= 2;
    });
    var hasPhrase = function (title, label) {
      return (" " + String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() + " ")
        .includes(" " + String(label || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() + " ");
    };
    return items.map(function (item) {
      if (!/^apple\b/i.test(item.topic || "")) return item;
      var target = literalChildren.filter(function (label) { return hasPhrase(item.title, label); })
        .sort(function (left, right) { return right.length - left.length; })[0];
      if (target) return Object.assign({}, item, { topic: target, topicId: item.topicId });
      if (/^apple$/i.test(item.topic || "")) {
        if (/\b(event|launch|announce|announcement|release|releases|product roadmap|expect)\b/i.test(item.title || "")) {
          return Object.assign({}, item, { topic: "Apple Events & Products" });
        }
        if (/\b(iphone|ipad|macbook|mac mini|macos|imac|vision pro|display|hardware)\b/i.test(item.title || "")) {
          return Object.assign({}, item, { topic: "Apple Hardware" });
        }
      }
      return item;
    });
  }

  function makeItem(connection) {
    var link = document.createElement("a");
    var targetId = "homepage-" + connectionAnchor(connection.label);
    link.className = "home-connection-ticker-item";
    link.href = "/extractor";
    link.textContent = connection.label;
    link.addEventListener("click", function (event) {
      var widget = document.getElementById(targetId);
      if (!widget) return;
      event.preventDefault();
      window.location.hash = targetId;
    });
    return link;
  }

  function paintTicker(connections) {
    connections = connections.slice(0,5);
    if (!connections.length) return;
    ticker.replaceChildren();
    var set = document.createDocumentFragment();
    connections.forEach(function (connection) { set.appendChild(makeItem(connection)); });
    ticker.appendChild(set);

    var duplicate = document.createDocumentFragment();
    connections.forEach(function (connection) {
      var item = makeItem(connection);
      item.setAttribute("aria-hidden", "true");
      item.tabIndex = -1;
      duplicate.appendChild(item);
    });
    ticker.appendChild(duplicate);
    ticker.style.setProperty("--home-ticker-duration", Math.max(28, connections.length * 3) + "s");
  }

  function renderTicker(payload) {
    if (Array.isArray(payload && payload.connections)) {
      paintTicker(payload.connections);
      return;
    }
    var rawTopics = Array.isArray(payload && payload.topics) ? payload.topics : [];
    var rawItems = Array.isArray(payload && payload.items) ? payload.items : [];
    var normalized = promoteFullyOwnedSuffixTopics(rawItems.map(function (item) {
      return validConnectionSurface(item) ? item : Object.assign({}, item, { topic: "Individual Find", topicId: "" });
    }), rawTopics);
    normalized = promoteRepeatedNamedPhrases(normalized.items, normalized.topics);
    var topics = normalized.topics;
    var items = consolidateAppleSurface(normalized.items);
    var autoTopicIds = new Set(topics.filter(function (topic) { return topic && topic.auto; }).map(function (topic) { return topic.id; }));
    var counts = {};

    items.forEach(function (item) {
      if (!item || !item.topicId || !autoTopicIds.has(item.topicId)) return;
      var label = String(item.topic || "Connection");
      if (!counts[label]) counts[label] = { count: 0, newest: 0 };
      counts[label].count += 1;
      counts[label].newest = Math.max(counts[label].newest, savedTime(item));
    });

    var connections = Object.keys(counts).map(function (label) {
      return {
        label: label,
        count: counts[label].count,
        newest: counts[label].newest
      };
    }).sort(function (left, right) {
      return right.newest - left.newest || right.count - left.count ||
        left.label.localeCompare(right.label);
    });

    paintTicker(connections);
  }

  function requestTicker() {
    return fetch(endpoint + "?ticker=1&fresh=" + Date.now(), { cache: "no-store", headers: { Accept: "application/json" }, mode: "cors" });
  }

  paintTicker(fallbackConnections);
  requestTicker()
    .then(function (response) {
      if (!response.ok) throw new Error("Connections unavailable");
      return response.json();
    })
    .then(renderTicker)
    .catch(function () {
      // A brief retry handles a cold Worker without dropping the entire
      // homepage signal strip on a transient request failure.
      window.setTimeout(function () {
        requestTicker()
          .then(function (response) { if (!response.ok) throw new Error("Connections unavailable"); return response.json(); })
          .then(renderTicker)
          .catch(function () { paintTicker(fallbackConnections); });
      }, 900);
    });
})();
