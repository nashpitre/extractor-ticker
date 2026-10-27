
    window.nashpFetchExtractor = (function () {
      var pending, fetchedAt = 0;
      return function () {
        if (!pending || Date.now() - fetchedAt > 30000) {
          fetchedAt = Date.now();
          pending = fetch("https://nashp-reeder-feed.nashp-8f3.workers.dev/", {
            cache: "no-store", headers: { Accept: "application/json" }, mode: "cors"
          }).then(function (response) {
            if (!response.ok) throw new Error("Connections unavailable");
            return response;
          }).catch(function (error) { pending = null; throw error; });
        }
        return pending.then(function (response) { return response.clone(); });
      };
    })();
    document.addEventListener("DOMContentLoaded", function () {
      var tickers = document.querySelectorAll(".site-connection-ticker-track");
      if (!tickers.length) return;
      var endpoint = "https://nashp-reeder-feed.nashp-8f3.workers.dev/";

      function savedTime(item) {
        var time = new Date(item.date_saved || item.date_published).getTime();
        return Number.isNaN(time) ? 0 : time;
      }
      function fillTicker(ticker, payload) {
        var topics = Array.isArray(payload && payload.topics) ? payload.topics : [];
        var items = Array.isArray(payload && payload.items) ? payload.items : [];
        var counts = {};
        items.forEach(function (item) {
          if (!item || !item.topicId) return;
          if (!counts[item.topicId]) counts[item.topicId] = { count: 0, newest: 0 };
          counts[item.topicId].count += 1;
          counts[item.topicId].newest = Math.max(counts[item.topicId].newest, savedTime(item));
        });
        var connections = topics.filter(function (topic) {
          return topic && topic.auto && counts[topic.id];
        }).map(function (topic) {
          return { label: String(topic.label || "Connection"), count: counts[topic.id].count, newest: counts[topic.id].newest };
        }).sort(function (left, right) {
          return right.newest - left.newest || right.count - left.count || left.label.localeCompare(right.label);
        });
        connections = connections.slice(0,5);
        if (!connections.length) { ticker.closest(".site-connection-ticker").hidden = true; return; }
        ticker.replaceChildren();
        [connections, connections].forEach(function (set, copyIndex) {
          set.forEach(function (connection) {
            var link = document.createElement("a");
            link.className = "site-connection-ticker-item";
            link.href = "/extractor";
            link.textContent = connection.label;
            if (copyIndex) { link.setAttribute("aria-hidden", "true"); link.tabIndex = -1; }
            ticker.appendChild(link);
          });
        });
        ticker.style.setProperty("--site-ticker-duration", Math.max(28, connections.length * 3) + "s");
        ticker.classList.add("is-visible");
      }
      window.nashpFetchExtractor()
        .then(function (response) { if (!response.ok) throw new Error("Connections unavailable"); return response.json(); })
        .then(function (payload) {
          window.nashpConnectionPayload = payload;
          window.dispatchEvent(new CustomEvent("nashp:connections", { detail: payload }));
          tickers.forEach(function (ticker) { fillTicker(ticker, payload); });
        })
        .catch(function () { tickers.forEach(function (ticker) { ticker.closest(".site-connection-ticker").hidden = true; }); });
    });
  