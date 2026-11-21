const { XMLParser } = require("fast-xml-parser");

const FEEDS = [
  {
    name: "OpenAI",
    url: "https://openai.com/blog/rss.xml",
    source: "openai",
  },
  {
    name: "Google DeepMind",
    url: "https://deepmind.google/blog/rss.xml",
    source: "deepmind",
  },
  {
    name: "Google AI",
    url: "https://blog.google/technology/ai/rss/",
    source: "google-ai",
  },
  {
    name: "Meta Engineering (ML)",
    url: "https://engineering.fb.com/category/ml-applications/feed/",
    source: "meta-ai",
  },
];

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

function stripHtml(html) {
  return (html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function extractLink(item) {
  if (typeof item.link === "string") return item.link;
  if (item.link?.["@_href"]) return item.link["@_href"];
  if (Array.isArray(item.link)) {
    const alt = item.link.find((l) => l["@_rel"] === "alternate");
    return alt?.["@_href"] || item.link[0]?.["@_href"] || "";
  }
  return item.guid || "";
}

async function fetchNew() {
  const items = [];

  const results = await Promise.allSettled(
    FEEDS.map(async (feed) => {
      const res = await fetch(feed.url, {
        headers: { "User-Agent": "AI-Monitor/1.0" },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`${feed.name} RSS ${res.status}`);
      const xml = await res.text();
      return { feed, xml };
    })
  );

  for (const result of results) {
    if (result.status !== "fulfilled") {
      console.warn(`[blogs] Feed fetch failed:`, result.reason?.message);
      continue;
    }

    const { feed, xml } = result.value;
    try {
      const parsed = parser.parse(xml);

      // Handle both RSS and Atom formats
      let entries =
        parsed?.rss?.channel?.item ||
        parsed?.feed?.entry ||
        [];
      if (!Array.isArray(entries)) entries = [entries];

      // Take only recent items (last 3 days)
      const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

      for (const entry of entries) {
        const pubDate = new Date(
          entry.pubDate || entry.published || entry.updated || 0
        );
        if (pubDate < cutoff) continue;

        const link = extractLink(entry);
        const title = (
          typeof entry.title === "string"
            ? entry.title
            : entry.title?.["#text"] || ""
        ).trim();

        const desc = stripHtml(
          entry.description ||
            entry["content:encoded"] ||
            entry.summary ||
            entry.content?.["#text"] ||
            ""
        );

        items.push({
          source: feed.source,
          id: `blog:${feed.source}:${link || title}`,
          title: `[${feed.name}] ${title}`,
          description: desc,
          link,
          metadata: { publisher: feed.name, pubDate: pubDate.toISOString() },
        });
      }
    } catch (e) {
      console.warn(`[blogs] Parse error for ${feed.name}:`, e.message);
    }
  }

  return items;
}

module.exports = { fetchNew };
