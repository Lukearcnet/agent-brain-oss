const HN_API = "https://hn.algolia.com/api/v1";

// Separate queries since Algolia doesn't support OR syntax
const QUERIES = ["AI", "LLM", "Claude Anthropic", "GPT OpenAI", "machine learning"];
const MIN_POINTS = 50;

async function fetchAIStories() {
  const seen = new Set();
  const items = [];

  for (const query of QUERIES) {
    try {
      const params = new URLSearchParams({
        tags: "front_page",
        query,
        numericFilters: `points>${MIN_POINTS}`,
        hitsPerPage: "20",
      });
      const url = `${HN_API}/search?${params}`;

      const res = await fetch(url, {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const data = await res.json();

      for (const hit of data.hits || []) {
        if (seen.has(hit.objectID)) continue;
        seen.add(hit.objectID);

        // Only include stories from the last 24 hours
        const age = Date.now() - new Date(hit.created_at).getTime();
        if (age > 24 * 60 * 60 * 1000) continue;

        items.push({
          source: "hackernews",
          id: `hn:${hit.objectID}`,
          title: hit.title || "",
          description: `${hit.points} points, ${hit.num_comments} comments`,
          link:
            hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
          metadata: {
            points: hit.points,
            comments: hit.num_comments,
            hnLink: `https://news.ycombinator.com/item?id=${hit.objectID}`,
          },
        });
      }
    } catch (e) {
      console.warn(`[hackernews] Query "${query}" failed:`, e.message);
    }
  }

  // Sort by points descending
  return items.sort((a, b) => (b.metadata.points || 0) - (a.metadata.points || 0));
}

module.exports = { fetchAIStories };
