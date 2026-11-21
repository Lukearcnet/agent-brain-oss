const cheerio = require("cheerio");

const NEWS_URL = "https://www.anthropic.com/news";

async function fetchNew() {
  try {
    const res = await fetch(NEWS_URL, {
      headers: { "User-Agent": "AI-Monitor/1.0" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.warn(`[anthropic] Scrape failed: ${res.status}`);
      return [];
    }

    const html = await res.text();
    const $ = cheerio.load(html);
    const items = [];

    // Look for article links — Anthropic uses <a> tags with href="/news/..."
    $('a[href^="/news/"]').each((_, el) => {
      const href = $(el).attr("href");
      if (!href || href === "/news" || href === "/news/") return;

      const fullUrl = `https://www.anthropic.com${href}`;

      // Extract title from the link text or nearest heading
      let title = $(el).find("h2, h3, h4, span").first().text().trim();
      if (!title) title = $(el).text().trim();
      // Clean up whitespace
      title = title.replace(/\s+/g, " ").trim();
      if (!title || title.length < 5) return;

      // Avoid duplicates within this scrape
      if (items.some((i) => i.link === fullUrl)) return;

      items.push({
        source: "anthropic",
        id: `blog:anthropic:${href}`,
        title: `[Anthropic] ${title}`,
        description: "",
        link: fullUrl,
        metadata: { publisher: "Anthropic" },
      });
    });

    return items;
  } catch (e) {
    console.warn("[anthropic] Scrape error:", e.message);
    return [];
  }
}

module.exports = { fetchNew };
